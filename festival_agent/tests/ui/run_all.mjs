// UI 회귀 테스트 묶음 — 한 줄로 끝: `node tests/ui/run_all.mjs`   (festival_agent 폴더에서)
//
// 하는 일
//   1. 운영 festival.db 를 '복사'해서 (읽기만) 테스트 DB 를 만든다 — 운영 DB 는 쓰지 않는다.
//   2. 복사본 DB 에 webapi(기본 8799) 와 vite 개발 서버(기본 5174)를 띄운다. 이미 누가 쓰는 포트면
//      그 서버는 건드리지 않고 빈 포트로 옮겨 간다 (다른 세션이 쓰는 서버를 끄지 않는다).
//   3. 점검 4묶음을 차례로 돌린다
//        visitor  방문객 접수 흐름            report_flow.mjs
//        admin    관제·조치 기능              admin_flow.mjs  (SSE · 펼침 · 요청서 · 상태 · 지우기·되돌리기 · 카드)
//        mobile   5폭 가로 스크롤·터치·글꼴    mobile_check.mjs
//        build    빌드본(구형 폰 대비)        구형 문법 0개 + JS 실패 안내 (boot_check.mjs)
//   4. 끝나면 제가 띄운 서버·크롬·임시 파일을 모두 정리하고, 결과를 tests/ui/report.md 에 쓴다.
//
// 옵션   --only=visitor,admin   --skip=mobile   --keep(임시 폴더 남김)   --webapi-port=N   --vite-port=N   --report=경로
// 종료 코드   0 전부 통과(건너뜀 허용) · 1 실패 있음 · 2 준비 실패
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import net from "node:net";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..", "..");
const WEB = join(APP, "web");
const VITE = join(WEB, "node_modules", "vite", "bin", "vite.js");
const PY = process.env.PYTHON ?? "python";

// ── 인자 ──────────────────────────────────────────────────────────
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const flag = (k) => process.argv.includes(`--${k}`);
const only = arg("only")?.split(",");
const skipSet = new Set(arg("skip")?.split(",") ?? []);
const want = (k) => (!only || only.includes(k)) && !skipSet.has(k);
const REPORT = resolve(arg("report") ?? join(HERE, "report.md"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[run_all] ${m}`);
const t00 = Date.now();
const mm = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초` : `${(ms / 1000).toFixed(1)}초`);

// ── 포트 ──────────────────────────────────────────────────────────
const connects = (port, host) => new Promise((res) => {
  const s = net.connect({ port, host }); let done = false;
  const end = (v) => { if (!done) { done = true; s.destroy(); res(v); } };
  s.setTimeout(400, () => end(false)); s.on("connect", () => end(true)); s.on("error", () => end(false));
});
const busy = async (port) => (await connects(port, "127.0.0.1")) || (await connects(port, "::1"));
async function pick(pref, avoid = []) {
  for (let p = pref; p < pref + 40; p++) if (!avoid.includes(p) && !(await busy(p))) return p;
  throw new Error(`빈 포트를 못 찾음 (${pref}~${pref + 39})`);
}
// 내가 띄운 프로세스가 '준비됐다'고 찍는 줄(ready)이 나올 때까지 기다린다. 포트에 누가 듣고 있는지만 보면 안 된다:
// 다른 실행과 같은 포트를 동시에 고르면 늦게 뜬 쪽은 죽는데(webapi 는 같은 포트 중복 실행을 거부한다) 포트는 열려 있어서,
// 남의 서버를 내 것으로 착각하고 그 서버에 테스트(틀린 코드 시험 등)를 보내게 된다.
async function waitReady(child, ready, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child.exitCode !== null) return false;            // 내 프로세스가 죽었다 → 그 포트는 내 것이 아니다
    if (ready.test(child.text())) return true;
    await sleep(250);
  }
  return false;
}
async function launch(tag, cmd, argsFor, pref, opts, ready, avoid = []) {
  const tried = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = await pick(pref, [...avoid, ...tried]);
    const child = start(tag, cmd, argsFor(port), opts);
    if (await waitReady(child, ready)) return { child, port };
    tried.push(port); killTree(child);
    log(`${tag} 가 ${port} 에서 못 떴습니다 (다른 실행이 같은 포트를 쓴 듯) → 다른 포트로 다시 시도`);
  }
  throw new Error(`${tag} 를 띄우지 못함: ${procs.at(-1)?.tail?.() ?? ""}`);
}

// ── 프로세스 ──────────────────────────────────────────────────────
const procs = [];
function start(tag, cmd, args, { cwd, env, logFile }) {
  const out = logFile ? { stdio: ["ignore", "pipe", "pipe"] } : { stdio: "ignore" };
  const c = spawn(cmd, args, { cwd, env, ...out });
  const chunks = [];
  if (logFile) for (const s of [c.stdout, c.stderr]) s.on("data", (d) => { chunks.push(d); if (chunks.length > 400) chunks.shift(); });
  c.text = () => Buffer.concat(chunks).toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
  c.tag = tag; c.tail = () => Buffer.concat(chunks).toString("utf8").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
  procs.push(c);
  return c;
}
function killTree(c) {
  if (!c || c.exitCode !== null || !c.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
  else c.kill("SIGKILL");
}

// ── 잠금: run_all 은 한 번에 하나만 ─────────────────────────────────
// 둘이 동시에 돌면 서로의 서버·테스트 데이터를 건드리고(같은 포트를 고르면 한쪽이 남의 서버에 붙는다) CPU 도 모자라 점검이 깨진다.
const LOCK = join(tmpdir(), "ui-suite.lock");
async function acquireLock() {
  const t0 = Date.now(); let warned = false;
  for (;;) {
    try { const fd = openSync(LOCK, "wx"); writeSync(fd, String(process.pid)); closeSync(fd); return; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stale = false;
      try {
        const pid = Number(readFileSync(LOCK, "utf8"));
        try { process.kill(pid, 0); } catch { stale = true; }                   // 주인 프로세스가 없다
        if (Date.now() - statSync(LOCK).mtimeMs > 45 * 60 * 1000) stale = true;  // 너무 오래됐다
      } catch { stale = true; }
      if (stale) { try { rmSync(LOCK, { force: true }); } catch { /* */ } continue; }
      if (!warned) { log("다른 run_all 이 실행 중 — 끝날 때까지 기다립니다 (동시에 돌면 서로의 서버·데이터를 건드리고 CPU 도 모자랍니다)"); warned = true; }
      if (Date.now() - t0 > 30 * 60 * 1000) throw new Error("다른 run_all 을 30분 넘게 기다렸습니다");
      await sleep(3000);
    }
  }
}
function releaseLock() {
  try { if (readFileSync(LOCK, "utf8") === String(process.pid)) rmSync(LOCK, { force: true }); } catch { /* */ }
}
await acquireLock();

// ── 임시 작업장 ───────────────────────────────────────────────────
// 이전 실행이 못 지우고 남긴 폴더를 먼저 치운다 (크롬이 늦게 놓는 파일 때문에 그때는 못 지울 수 있다). 10분이 안 된 것은 다른 실행 중일 수 있어 둔다.
for (const d of readdirSync(tmpdir())) {
  if (!d.startsWith("ui-suite-")) continue;
  try {
    const p = join(tmpdir(), d);
    if (Date.now() - statSync(p).mtimeMs > 10 * 60 * 1000) rmSync(p, { recursive: true, force: true });
  } catch { /* 아직 잠겨 있으면 다음 실행에 */ }
}
const ROOT = mkdtempSync(join(tmpdir(), "ui-suite-"));
const TMP = join(ROOT, "tmp"); mkdirSync(TMP);          // 자식 스크립트의 크롬 프로필이 여기에 생긴다
const SHOTS = join(ROOT, "shots"); mkdirSync(SHOTS);
const DBCOPY = join(ROOT, "ui_test.db");
// 운영자 코드(D5-31): 이 실행에서만 쓰는 무작위 값. 테스트 webapi 의 환경변수(ADMIN_CODE)로만 넣고 점검 스크립트에 UI_ADMIN_CODE 로 넘긴다.
// 운영 .env 에는 쓰지 않으며, 보고서·로그에도 찍지 않는다.
// UI_TEST_CODE 로 테스트 코드를 지정할 수 있다 — 한글 등 비ASCII 코드가 화면에서 되는지 볼 때 (운영자 코드가 아니라 테스트용 임의 문자열).
const ADMIN_CODE = process.env.UI_TEST_CODE || `t${randomBytes(6).toString("hex")}`;
const childEnv = { ...process.env, TEMP: TMP, TMP, TMPDIR: TMP, PYTHONIOENCODING: "utf-8", UI_ADMIN_CODE: ADMIN_CODE };

// 기계 부하: 다른 프로그램(게임·빌드·다른 세션의 테스트)이 CPU 를 많이 쓰면 화면이 늦게 반응해 고정 대기 시간이 모자란다.
// 시작할 때 CPU 사용률을 1초간 재서 기다리는 시간의 배율(UI_SLOW)을 정한다. 검사 기준은 그대로고 기다리는 시간만 는다.
const cpuBusy = () => new Promise((res) => {
  const a = cpus();
  setTimeout(() => {
    const b = cpus(); let idle = 0, total = 0;
    a.forEach((c, i) => { for (const k of ["user", "nice", "sys", "idle", "irq"]) total += b[i].times[k] - c.times[k]; idle += b[i].times.idle - c.times.idle; });
    res(total > 0 ? 1 - idle / total : 0);
  }, 1000);
});
const BUSY = await cpuBusy();
const SLOW = BUSY > 0.85 ? 3 : BUSY > 0.6 ? 2 : 1;
childEnv.UI_SLOW = String(SLOW);
log(`CPU 사용률 ${Math.round(BUSY * 100)}% → 기다리는 시간 ×${SLOW}`);

let cleaned = false;
// 이 실행의 임시 폴더를 쓰는 크롬을 모두 끄고, 몇 개가 남았는지 돌려준다.
// (스크립트의 chrome.kill() 은 본 프로세스만 끄고, 하위 프로세스는 잠깐 더 살아서 파일을 붙잡는다 — 한 번 훑고 끝내면 못 지운다)
function sweepChrome() {
  if (process.platform !== "win32") return 0;
  const ps = `$n = 0; Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${ROOT.replace(/'/g, "''")}*' } | ForEach-Object { $n++; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $n`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
  return Number.parseInt((r.stdout ?? "").trim(), 10) || 0;
}
async function cleanup() {
  if (cleaned) return; cleaned = true;
  for (const c of procs) killTree(c);
  releaseLock();
  // 기계가 바쁘면(SLOW>1) 크롬이 죽고 파일 잠금이 풀리는 데도 그만큼 더 걸린다 — 기다리는 횟수를 배율만큼 늘린다 (기본 약 10초 → 최대 약 30초)
  for (let i = 0; i < 20 * SLOW && sweepChrome() > 0; i++) await sleep(500);   // 크롬이 하나도 안 남을 때까지
  await sleep(500 * SLOW);
  if (!flag("keep")) for (let i = 0; i < 20 * SLOW; i++) { try { rmSync(ROOT, { recursive: true, force: true }); break; } catch { await sleep(500); } }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { log("중단 — 정리합니다"); await cleanup(); process.exit(130); });

// ── 점검 묶음 결과 ────────────────────────────────────────────────
const results = []; // { key, label, lines:[{kind,text}], ms, exit, note }
const parse = (out) => out.split(/\r?\n/).filter((l) => /^[✓✗○] /.test(l)).map((l) => ({ kind: l[0], text: l.slice(2).trim() }));
function runScript(key, label, file, args, { timeoutMs = 300000 } = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [join(HERE, file), ...args], { cwd: APP, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(c);
    let out = ""; c.stdout.on("data", (d) => { out += d.toString("utf8"); }); c.stderr.on("data", (d) => { out += d.toString("utf8"); });
    const timer = setTimeout(() => { out += "\n✗ 시간 초과로 중단\n"; killTree(c); }, timeoutMs * SLOW);   // 기계가 바쁘면 그만큼 더 기다린다
    c.on("exit", (code) => {
      clearTimeout(timer);
      const lines = parse(out);
      const r = { key, label, lines, ms: Date.now() - t0, exit: code, raw: out };
      if (code !== 0 && !lines.some((l) => l.kind === "✗")) { r.lines.push({ kind: "✗", text: `스크립트가 오류로 끝남 (exit ${code}): ${out.trim().split(/\r?\n/).slice(-3).join(" / ")}` }); }
      results.push(r); res(r);
      log(`${label}: 통과 ${r.lines.filter((l) => l.kind === "✓").length} · 실패 ${r.lines.filter((l) => l.kind === "✗").length} · 건너뜀 ${r.lines.filter((l) => l.kind === "○").length}  (${mm(r.ms)})`);
    });
  });
}

// ══ 준비 ═════════════════════════════════════════════════════════
let ports = {}; let dbNote = "";
try {
  if (!existsSync(VITE)) throw new Error(`vite 가 없습니다 — cd web && npm install (${VITE})`);
  const src = process.env.DB_PATH ?? join(APP, "festival.db");
  log(`운영 DB(${src})는 읽기만 합니다. 복사본: ${DBCOPY}`);
  let r = spawnSync(PY, [join(HERE, "make_mobile_db.py"), DBCOPY], { cwd: APP, env: childEnv, encoding: "utf-8" });
  if (r.status === 0) dbNote = "운영 DB 복사본 + 긴 민원·URL·부서명 등 극단 입력 추가 (make_mobile_db.py)";
  else {
    log(`극단 입력 추가 실패 → 단순 복사로 대체: ${(r.stderr || r.stdout || "").trim().split(/\r?\n/).pop()}`);
    r = spawnSync(PY, ["-c", `import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d)`, src, DBCOPY], { cwd: APP, env: childEnv, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`DB 복사 실패: ${r.stderr}`);
    dbNote = "운영 DB 단순 복사본 (극단 입력 추가는 실패해서 생략)";
  }

  const webapiPref = Number(arg("webapi-port") ?? 8799), vitePref = Number(arg("vite-port") ?? 5174);
  const apiEnv = { ...childEnv, DB_PATH: DBCOPY, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", LLM_BACKEND: "local", ADMIN_CODE };
  const api = await launch("webapi", PY, (p) => ["webapi.py", "--port", String(p)], webapiPref, { cwd: APP, env: apiEnv, logFile: true }, /local 대역 · http/);
  const webapi = api.port;
  const viteEnv = { ...childEnv, WEBAPI_PORT: String(webapi) };
  let viteP = vitePref;
  if (want("visitor") || want("admin") || want("mobile")) {
    const v = await launch("vite", process.execPath, (p) => [VITE, "--port", String(p), "--strictPort", "--host", "127.0.0.1"], vitePref, { cwd: WEB, env: viteEnv, logFile: true }, /Local:/, [webapi]);
    viteP = v.port;
  }
  // 잠금 시험용 webapi (별도 포트 · 별도 DB 복사본): 틀린 코드를 5번 넘게 넣으면 그 서버가 10분간 잠기므로, 본 서버와 떼어 놓는다
  let lockPort = null;
  if (want("admin")) {
    const DB2 = join(ROOT, "ui_lock.db");
    const m2 = spawnSync(PY, [join(HERE, "make_mobile_db.py"), DB2], { cwd: APP, env: childEnv, encoding: "utf-8" });
    if (m2.status === 0) {
      const lk = await launch("webapi-lock", PY, (p) => ["webapi.py", "--port", String(p)], 8830, { cwd: APP, env: { ...apiEnv, DB_PATH: DB2 }, logFile: true }, /local 대역 · http/, [webapi, viteP]);
      lockPort = lk.port;
      childEnv.UI_LOCK_BASE = `http://127.0.0.1:${lockPort}`;
    } else log("잠금 시험용 DB 복사본을 못 만들어 '잠김(서버)' 점검은 건너뜁니다");
  }
  const prev = await pick(4174, [webapi, viteP, lockPort ?? 0]);
  ports = { webapi, vite: viteP, preview: prev, lock: lockPort, moved: webapi !== webapiPref || viteP !== vitePref };
  if (ports.moved) log(`기본 포트(${webapiPref}/${vitePref})를 다른 세션이 쓰고 있어 ${webapi}/${viteP} 로 옮겼습니다 (그 서버는 건드리지 않습니다)`);
  log(`서버 준비: webapi ${webapi} · vite ${viteP}`);
  const dev = `http://127.0.0.1:${viteP}`;

  // ══ 점검 ═══════════════════════════════════════════════════════
  if (want("visitor")) await runScript("visitor", "방문객 접수 흐름", "report_flow.mjs", [dev], { timeoutMs: 240000 });
  if (want("admin")) await runScript("admin", "관제·조치 기능", "admin_flow.mjs", [dev], { timeoutMs: 300000 });
  // 서버 껐다 켜기: 이 스크립트가 자기 webapi·vite 를 따로 띄우고 끈다 (위의 본 서버는 그대로)
  if (want("reconnect")) await runScript("reconnect", "연결 끊김·복구 (서버 껐다 켜기)", "reconnect_flow.mjs", [], { timeoutMs: 300000 });
  if (want("mobile")) await runScript("mobile", "5폭 가로 스크롤", "mobile_check.mjs", [dev, SHOTS, "m_"], { timeoutMs: 900000 });

  if (want("build")) {
    const t0 = Date.now(); const lines = []; const dist = join(ROOT, "dist");
    const b = spawnSync(process.execPath, [VITE, "build", "--outDir", dist, "--emptyOutDir"], { cwd: WEB, env: viteEnv, encoding: "utf-8" });
    lines.push(b.status === 0 ? { kind: "✓", text: "빌드본 만들기 (vite build)" } : { kind: "✗", text: `빌드 실패: ${(b.stderr || b.stdout).trim().split(/\r?\n/).slice(-3).join(" / ")}` });
    if (b.status === 0) {
      const js = readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dist, "assets", f), "utf8")).join("\n");
      const pats = { "??=": /\?\?=/g, "||=": /\|\|=/g, "&&=": /&&=/g, "?.[": /\?\.\[/g, "?.식": /\?\.[A-Za-z_$(]/g, "??": /[^?]\?\?[^?=]/g, structuredClone: /structuredClone/g, "Object.hasOwn": /Object\.hasOwn/g, ".at(": /\.at\(/g, replaceAll: /replaceAll/g };
      const hit = Object.entries(pats).map(([k, re]) => [k, (js.match(re) ?? []).length]).filter(([, n]) => n > 0);
      lines.push(hit.length === 0 ? { kind: "✓", text: "빌드본에 최신 문법 0개 (??= ?. ?? 등 — 구형 폰 대비)" } : { kind: "✗", text: `빌드본에 최신 문법이 남음: ${hit.map(([k, n]) => `${k}×${n}`).join(", ")}` });
      let pv = null;
      try { pv = await launch("preview", process.execPath, (p) => [VITE, "preview", "--outDir", dist, "--port", String(p), "--strictPort", "--host", "127.0.0.1"], prev, { cwd: WEB, env: viteEnv, logFile: true }, /Local:/, [webapi, viteP]); } catch (e) { lines.push({ kind: "✗", text: `preview 가 안 뜸: ${e.message}` }); }
      if (pv) {
        ports.preview = pv.port;
        const r = await runScript("build-boot", "빌드본 JS 실패 안내", "boot_check.mjs", [`http://127.0.0.1:${pv.port}`], { timeoutMs: 120000 });
        results.pop(); lines.push(...r.lines);
      }
    }
    const r = { key: "build", label: "빌드본(구형 폰 대비)", lines, ms: Date.now() - t0, exit: lines.some((l) => l.kind === "✗") ? 1 : 0 };
    results.push(r);
    log(`${r.label}: 통과 ${lines.filter((l) => l.kind === "✓").length} · 실패 ${lines.filter((l) => l.kind === "✗").length}  (${mm(r.ms)})`);
  }
} catch (e) {
  log(`준비 실패: ${e.message}`);
  await cleanup();
  writeFileSync(REPORT, `# UI 회귀 테스트 결과\n\n준비 단계에서 실패했습니다.\n\n\`\`\`\n${e.message}\n\`\`\`\n`, "utf8");
  process.exit(2);
}

// ══ 정리 + 결과 ═══════════════════════════════════════════════════
const stillUp = [];
await cleanup();
for (const [k, p] of Object.entries({ webapi: ports.webapi, vite: ports.vite, preview: ports.preview, lock: ports.lock })) if (p && (await busy(p))) stillUp.push(`${k}:${p}`);
const leftover = existsSync(ROOT);

const cnt = (r, k) => r.lines.filter((l) => l.kind === k).length;
const P = results.reduce((n, r) => n + cnt(r, "✓"), 0), F = results.reduce((n, r) => n + cnt(r, "✗"), 0), S = results.reduce((n, r) => n + cnt(r, "○"), 0);
const now = new Date(); const pad = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

let md = `# UI 회귀 테스트 결과\n\n`;
md += `**${F === 0 ? "전부 통과" : `실패 ${F}건`}** · 통과 ${P} · 실패 ${F} · 건너뜀 ${S}  ·  ${stamp}  ·  ${mm(Date.now() - t00)}\n\n`;
md += `\`node tests/ui/run_all.mjs\` 로 다시 돌립니다. 이 파일은 실행할 때마다 덮어씁니다.\n\n`;
md += `## 환경\n\n`;
md += `- DB: ${dbNote} — **운영 festival.db 는 읽기만 했습니다.**\n`;
md += `- 포트: webapi ${ports.webapi} · vite(개발) ${ports.vite} · preview(빌드본) ${ports.preview}${ports.lock ? ` · 잠금 시험용 webapi ${ports.lock}(별도 DB — 본 서버는 잠그지 않음)` : ""}${ports.moved ? " — 기본 포트(8799·5174)를 다른 세션이 쓰고 있어 옮겼습니다" : ""}\n`;
md += `- 기계 부하: 시작할 때 CPU 사용률 ${Math.round(BUSY * 100)}% → 기다리는 시간 ×${SLOW} (검사 기준은 그대로)\n`;
md += `- 운영자 코드(D5-31): 이 실행에서만 쓰는 무작위 값을 테스트 webapi 에 환경변수로 넣었습니다 (운영 .env 는 쓰지 않았고, 값은 기록하지 않습니다).
`;
md += `- 워커·LLM 없음(local). 그래서 '요청서 생성'은 요청이 쌓이는 데까지만 보고, 미리보기·DOCX 는 복사본에 이미 있는 요청서로 봅니다.\n`;
md += `- 정리: ${stillUp.length === 0 && !leftover ? "제가 띄운 서버·크롬·임시 폴더를 모두 정리했습니다." : `⚠ 정리되지 않은 것 있음 — 서버 ${stillUp.join(", ") || "없음"} · 임시 폴더 ${leftover ? ROOT : "없음"}`}\n\n`;
md += `## 묶음별\n\n| 묶음 | 통과 | 실패 | 건너뜀 | 시간 |\n|---|---|---|---|---|\n`;
for (const r of results) md += `| ${r.label} | ${cnt(r, "✓")} | ${cnt(r, "✗")} | ${cnt(r, "○")} | ${mm(r.ms)} |\n`;
md += `\n`;
const fails = results.flatMap((r) => r.lines.filter((l) => l.kind === "✗").map((l) => `- **${r.label}** — ${l.text}`));
md += `## 실패\n\n${fails.length ? fails.join("\n") : "없음"}\n\n`;
const skips = results.flatMap((r) => r.lines.filter((l) => l.kind === "○").map((l) => `- **${r.label}** — ${l.text}`));
md += `## 건너뜀 (아직 없는 기능 — 생기면 자동으로 켜집니다)\n\n${skips.length ? skips.join("\n") : "없음"}\n\n`;
md += `## 통과 항목\n\n`;
for (const r of results) md += `**${r.label}**\n\n${r.lines.filter((l) => l.kind === "✓").map((l) => `- ${l.text}`).join("\n") || "- (없음)"}\n\n`;
writeFileSync(REPORT, md, "utf8");

log(`결과: ${F === 0 ? "전부 통과" : `실패 ${F}건`} (통과 ${P} · 건너뜀 ${S}) → ${REPORT}`);
if (stillUp.length || leftover) log(`⚠ 정리 미완: 서버 ${stillUp.join(", ") || "-"} · 임시 폴더 ${leftover ? ROOT : "-"}`);
process.exit(F === 0 ? 0 : 1);
