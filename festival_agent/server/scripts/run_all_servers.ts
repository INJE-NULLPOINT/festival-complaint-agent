// 서버 일괄 실행 + 감시 (D5-34) — webapi · worker · vite 를 분리 프로세스로 띄우고, 죽으면 다시 띄운다. (scripts/run_all_servers.py 와 1:1)
//
// 사용법
//     node server/scripts/run_all_servers.ts                 webapi(8765) + worker + vite 개발 서버(5173)
//     node server/scripts/run_all_servers.ts --phone         vite 대신 폰 확인용 빌드본 서버(npm run phone, 4173)
//     node server/scripts/run_all_servers.ts --lan           vite 개발 서버를 --host 로 (같은 Wi-Fi 의 폰이 5173 으로 접속, dev:phone 과 같은 명령)
//     node server/scripts/run_all_servers.ts --llm claude_code --agent-interval 20    워커에 LLM_BACKEND·Agent Path 주기 전달
//     node server/scripts/run_all_servers.ts --only webapi worker     일부만
//     node server/scripts/run_all_servers.ts --dry-run       명령만 출력
//     node server/scripts/run_all_servers.ts --backup-now    DB 를 지금 백업하고 끝
//     node server/scripts/run_all_servers.ts --python        전환 전: webapi·worker 를 Python(webapi.py·worker.py)으로 띄운다
//
// - 로그: output/logs/<이름>.log (1MB 넘으면 .log.1 로 넘김). 이 스크립트 자신의 기록은 supervisor.log.
// - 죽으면 2·4·8…최대 60초 간격으로 다시 띄운다. 60초 넘게 살아 있으면 간격을 처음으로 되돌린다.
// - 이 스크립트가 두 번 뜨지 않는다 (PID 잠금). 이미 해당 포트가 쓰이고 있으면 그 서버는 건드리지 않고 넘어간다.
// - DB 를 30분마다 백업하고 최근 12개만 남긴다 (backup/ 은 git 제외).
//     SUPABASE_DB_URL 이 있으면(운영) Supabase 를 읽기 전용으로 읽어 backup/supabase_*.json 한 파일로 (source_key 제외).
//     없으면 festival.db(또는 DB_PATH)를 backup/auto_*.db 로 복사. 복원: node server/cli.ts db restore <파일> [--live-db]
// - 끄려면 Ctrl+C — 자식 프로세스도 같이 끈다.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../core/config.ts";
import * as dbbackup from "../core/dbbackup.ts";
import * as procguard from "../core/procguard.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");        // festival_agent/
/** 로그 폴더. 시험이 임시 폴더로 바꿀 수 있게 객체로 연다 (paths.LOG_DIR). */
export const paths = { LOG_DIR: path.join(ROOT, "output", "logs") };
const LOG_MAX = 1_000_000;
const BACKUP_EVERY = 30 * 60;
const BACKUP_KEEP = 12;
const BACKOFF_MAX = 60;
const STABLE_AFTER = 60;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (full = false) => {
  const d = new Date();
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return full ? `${d.getFullYear()}-${md}` : md;
};

function log_line(msg: string): void {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(paths.LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(paths.LOG_DIR, "supervisor.log"), line + "\n", "utf-8");
  } catch { /* 기록을 못 남겨도 계속 */ }
}

function port_in_use(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(500, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

/** 감시할 프로세스 1개. */
export class Managed {
  name: string; cmd: string[]; cwd: string; port: number | null; env: NodeJS.ProcessEnv;
  proc: ChildProcess | null = null;
  logFd: number | null = null;
  started = 0; restarts = 0; delay = 2.0; next_try = 0; skipped = false;
  exitCode: number | null = null;

  constructor(name: string, cmd: string[], cwd: string, port: number | null = null, env: Record<string, string> = {}) {
    this.name = name; this.cmd = cmd; this.cwd = cwd; this.port = port;
    this.env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", ...env };
  }

  get log_path(): string { return path.join(paths.LOG_DIR, `${this.name}.log`); }

  private open_log(): void {
    fs.mkdirSync(paths.LOG_DIR, { recursive: true });
    const p = this.log_path;
    try { if (fs.existsSync(p) && fs.statSync(p).size > LOG_MAX) fs.renameSync(p, p + ".1"); } catch { /* */ }
    this.logFd = fs.openSync(p, "a");
    fs.writeSync(this.logFd, `\n===== ${stamp(true)} 시작: ${this.cmd.join(" ")}\n`);
  }

  async start(): Promise<void> {
    if (this.port && await port_in_use(this.port)) {
      if (!this.skipped) log_line(`${this.name}: 포트 ${this.port} 이 이미 쓰이고 있어 새로 띄우지 않습니다 (다른 서버를 그대로 씁니다)`);
      this.skipped = true;
      return;
    }
    this.skipped = false;
    this.open_log();
    this.exitCode = null;
    const child = spawn(this.cmd[0], this.cmd.slice(1), { cwd: this.cwd, env: this.env, stdio: ["ignore", this.logFd!, this.logFd!], windowsHide: true });
    child.on("exit", (code) => { this.exitCode = code ?? -1; });
    child.on("error", (e) => { this.exitCode = -1; if (this.logFd !== null) fs.writeSync(this.logFd, `시작 실패: ${e.message}\n`); });
    this.proc = child;
    this.started = Date.now() / 1000;
    log_line(`${this.name}: 시작 (pid ${child.pid}) → ${this.log_path}`);
  }

  /** 한 번 점검한다. 'ok' | 'restarted' | 'waiting' | 'skipped' 를 돌려준다. */
  async check(now = Date.now() / 1000): Promise<string> {
    if (this.proc === null) {
      if (now < this.next_try) return "waiting";
      await this.start();
      return this.skipped ? "skipped" : "restarted";
    }
    if (this.exitCode === null) {
      if (now - this.started >= STABLE_AFTER) this.delay = 2.0;
      return "ok";
    }
    const code = this.exitCode;
    const ran = now - this.started;
    if (this.logFd !== null) {
      fs.writeSync(this.logFd, `===== 종료 코드 ${code} (${ran.toFixed(0)}초 실행)\n`);
      fs.closeSync(this.logFd);
      this.logFd = null;
    }
    this.restarts += 1;
    if (ran >= STABLE_AFTER) this.delay = 2.0;
    log_line(`${this.name}: 종료됨 (코드 ${code}, ${ran.toFixed(0)}초 실행) → ${this.delay.toFixed(0)}초 뒤 다시 시작 (누적 ${this.restarts}회)`);
    this.proc = null;
    this.next_try = now + this.delay;
    this.delay = Math.min(this.delay * 2, BACKOFF_MAX);
    return "waiting";
  }

  stop(): void {
    if (this.proc && this.exitCode === null && this.proc.pid) {
      try {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" });
        else this.proc.kill("SIGTERM");
      } catch { /* */ }
    }
    if (this.logFd !== null) { try { fs.closeSync(this.logFd); } catch { /* */ } this.logFd = null; }
  }
}

type Args = { only: string[]; phone: boolean; lan: boolean; llm?: string; agentInterval?: number; host: string; port: number; python: boolean };

function build(args: Args): Managed[] {
  const node = process.execPath;
  const py = process.env.PYTHON ?? "python";
  const workerCmd = args.python ? [py, "worker.py"] : [node, path.join("server", "worker.ts")];
  if (args.agentInterval !== undefined) workerCmd.push("--agent-interval", String(args.agentInterval));
  const webapiCmd = args.python ? [py, "webapi.py", "--host", args.host, "--port", String(args.port)]
    : [node, path.join("server", "webapi.ts"), "--host", args.host, "--port", String(args.port)];
  const childEnv: Record<string, string> = args.llm ? { LLM_BACKEND: args.llm } : {};      // 자식 프로세스(webapi·worker)에만 넣는다
  const web = path.join(ROOT, "web");
  const items: Record<string, Managed> = {
    webapi: new Managed("webapi", webapiCmd, ROOT, args.port, childEnv),
    worker: new Managed("worker", workerCmd, ROOT, null, childEnv),
  };
  if (args.phone) items.vite = new Managed("vite", [node, "scripts/phone.ts"], web, 4173);
  else items.vite = new Managed("vite", [node, path.join(web, "node_modules", "vite", "bin", "vite.js"), ...(args.lan ? ["--host"] : [])], web, 5173);
  return ["webapi", "worker", "vite"].filter((n) => args.only.includes(n)).map((n) => items[n]);
}

/** 지금 쓰는 DB 를 한 번 백업한다. 운영(Supabase)이면 JSON, 아니면 SQLite 사본. 저장한 경로를 돌려준다. */
async function backup_once(): Promise<string> {
  return config.SUPABASE_DB_URL ? dbbackup.save_backup(BACKUP_KEEP) : procguard.backup_db(BACKUP_KEEP);
}

async function backup_loop(stop: { v: boolean }): Promise<void> {
  for (;;) {
    for (let i = 0; i < BACKUP_EVERY && !stop.v; i++) await sleep(1000);
    if (stop.v) return;
    try {
      const p = await backup_once();
      log_line(`DB 백업: ${path.basename(p)} (자동 백업은 최근 ${BACKUP_KEEP}개만 보관)`);
    } catch (e) {          // 백업 실패가 서버를 멈추면 안 된다
      log_line(`DB 백업 실패: ${(e as Error).message ?? e}`);
    }
  }
}

async function main(): Promise<number> {
  const { values: v } = parseArgs({
    options: {
      only: { type: "string", multiple: true },
      phone: { type: "boolean", default: false },
      lan: { type: "boolean", default: false },
      llm: { type: "string" },
      "agent-interval": { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8765" },
      python: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "backup-now": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const only = (v.only && v.only.length ? v.only : ["webapi", "worker", "vite"]);
  for (const o of only) if (!["webapi", "worker", "vite"].includes(o)) { console.error(`--only 는 webapi worker vite 중에서: ${o}`); return 2; }
  if (v.llm && !["anthropic", "claude_code", "local"].includes(v.llm)) { console.error(`--llm 은 anthropic claude_code local 중에서: ${v.llm}`); return 2; }
  const args: Args = { only, phone: v.phone as boolean, lan: v.lan as boolean, llm: v.llm, agentInterval: v["agent-interval"] !== undefined ? Number(v["agent-interval"]) : undefined,
    host: v.host as string, port: Number(v.port), python: v.python as boolean };

  if (v["backup-now"]) {
    const p = await backup_once();
    console.log(`백업했습니다: ${p}`);
    return 0;
  }
  const servers = build(args);
  if (v["dry-run"]) {
    for (const s of servers) console.log(`${s.name.padEnd(7)} cwd=${s.cwd !== ROOT ? path.relative(ROOT, s.cwd) : "."}  ${s.cmd.join(" ")}`);
    console.log(`로그 ${paths.LOG_DIR} · DB 백업(${config.SUPABASE_DB_URL ? "Supabase → supabase_*.json" : "SQLite → auto_*.db"}) ${Math.floor(BACKUP_EVERY / 60)}분마다 → ${procguard.paths.BACKUP_DIR} (최근 ${BACKUP_KEEP}개)`);
    return 0;
  }

  const lock = await procguard.acquire("run_all_servers", config.DB_PATH);
  if (lock === null) {
    console.error("이미 run_all_servers 가 실행 중입니다 (같은 DB). 중복 실행을 막았습니다.");
    return 1;
  }
  const stop = { v: false };
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    log_line("Ctrl+C — 자식 프로세스를 끕니다");
    stop.v = true;
    for (const s of servers) s.stop();
    procguard.release(lock);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    log_line(`감시 시작: ${servers.map((s) => s.name).join(", ")} · DB ${config.SUPABASE_DB_URL ? "Supabase" : config.DB_PATH}`);
    try {
      log_line(`시작 전 DB 백업: ${path.basename(await backup_once())}`);
    } catch (e) {
      log_line(`시작 전 DB 백업 실패: ${(e as Error).message ?? e}`);
    }
    void backup_loop(stop);
    for (;;) {
      for (const s of servers) await s.check();
      await sleep(2000);
    }
  } finally {
    stop.v = true;
    for (const s of servers) s.stop();
    procguard.release(lock);
  }
}

// 직접 실행할 때만 돈다 (import 만 하면 돌지 않는다)
if (import.meta.main) main().then((code) => { if (code) process.exit(code); }).catch((e) => { console.error(e); process.exit(1); });
