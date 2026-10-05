// 에이전트 오케스트레이터. (worker.py 와 1:1 — 스레드 4개가 비동기 루프 4개로 바뀌었을 뿐 동작·옵션·로그 문구가 같다)
//
// 두 경로를 한 프로세스에서 돌린다.
//
//   Fast Path  (매 주기)     웹 접수 · 리플레이 투입 → ①분류 → 심각도 스냅샷
//                            웹에서 요청한 조치요청서 생성
//   Agent Path (느린 주기)   ②감시 → ③조치 → ④통합
//
// Agent Path를 매 주기 돌리면 LLM 호출이 폭증한다. 기본 60초 간격이고, 새로 분류된 민원이 있을 때만 돈다.
//
// 실행
//     node server/worker.ts                      기본 (수거 1초·접수 즉시 분류 / 에이전트 60초)
//     node server/worker.ts --agent-interval 20  시연용 (반응을 빠르게)
//     node server/worker.ts --no-agents          ①분류만 (비용 절약)
//     node server/worker.ts --once               한 주기만
//     node server/worker.ts --sqlite [경로]      SUPABASE_DB_URL 을 무시하고 SQLite 로 (기본 festival.db, 경로를 주면 그 파일).
//                                                원가 측정처럼 운영 DB 와 섞이면 안 되는 실행용. 시작할 때 'DB: SQLite <파일명>' 한 줄 (URL 은 안 찍는다)
//
// 비동기 루프 4개 + Agent Path 한 바퀴씩. Agent Path 한 바퀴가 claude_code 로 몇 분씩 걸리고 ①분류 한 배치도 수십 초 걸리므로, 서로 기다리면 접수·요청이 밀린다.
//
//   ingest   (--interval)  웹 접수 수거(마스킹) · 리플레이 투입 — 화면 유입이 바로 뜨게
//   메인     (--interval)  ①분류 → 심각도 스냅샷. 분류는 이 루프만 한다
//   doc_jobs (--interval)  웹의 조치요청서 요청
//   issues   (5초)         관제 '지금 조치할 일' 카드의 건수·마지막 시각·최신 민원 갱신 (LLM 없음)
//   agents   (필요할 때)   Agent Path 한 바퀴. 끝나야 다음 바퀴를 띄운다
//
// --once 는 루프 없이 한 번씩 차례로 돈다.
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "./core/config.ts";
import * as db from "./core/db.ts";
import * as inbox_listen from "./core/inbox_listen.ts";
import * as intake from "./core/intake.ts";
import * as issues from "./core/issues.ts";
import * as llm from "./core/llm.ts";
import type { Plan } from "./agents/planner.ts";
import * as procguard from "./core/procguard.ts";
import * as replay from "./core/replay.ts";
import * as review from "./core/review.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 기다리는 루프를 일찍 깨운다 (D5-71). notify 가 기다리기 전에 와도 다음 wait 이 바로 끝난다. */
export class Wake {
  private waiter: (() => void) | null = null;
  private pending = false;
  notify(): void {
    if (this.waiter) this.waiter();
    else this.pending = true;
  }
  wait(ms: number): Promise<void> {
    if (this.pending) { this.pending = false; return Promise.resolve(); }
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.waiter = null; resolve(); }, ms);
      this.waiter = () => { clearTimeout(t); this.waiter = null; resolve(); };
    });
  }
}
/** 접수가 들어왔다(NOTIFY) → 수거 루프를 깨운다. 수거가 새 민원을 만들었다 → 분류 루프를 깨운다. */
export const inbox_wake = new Wake();
export const classify_wake = new Wake();
const SLOW_POLL = 3.0;                // 분류·조치요청서 루프의 예비 폴링(초). 새 민원은 깨우기로 바로 처리한다
const LISTEN_POLL = 3.0;              // LISTEN 이 살아 있을 때 수거 루프의 예비 폴링(초)
const REPLAY_CHECK_MS = 5000;         // 리플레이가 꺼져 있을 때 상태를 다시 보는 간격 — 비어 있을 때 수거 틱은 쿼리 1개

/** ③조치는 한 번에 하나만 돈다. 웹 요청 루프와 Agent Path 가 같은 유형의 문서를 동시에 만들거나,
 *  새로 생긴 action_request 를 서로의 것으로 잡지 않게. (Python 의 threading.Lock) */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    await prev;
    try { return await fn(); } finally { release(); }
  }
}
export const DISPATCH_LOCK = new Mutex();

/**
 * 워커 시작 직후 분류 에이전트로 준비 호출 1회 (D5-76) — **anthropic 일 때만** (D5-79).
 * claude_code 는 효과가 없었다(첫 호출 11.3초 그대로): _cli_call 이 호출마다 새 `claude -p` 프로세스를 띄우고(--no-session-persistence, 호출마다 새 임시 폴더)
 * 프로세스 사이에 남는 것이 없어서, 준비 호출이 다음 호출의 시작을 데워 주지 못하고 토큰만 쓴다. local 도 하지 않는다. 실패해도 워커는 계속 돈다.
 */
export async function warmup(): Promise<boolean> {
  if (llm.backend() !== "anthropic") return false;
  try {
    const c = await import("./agents/classifier.ts");
    return await (config.CLASSIFY_MODE === "agent" ? c.classifier : c.classifier_prefetch).warmup();
  } catch (e) {
    console.error(`[worker] 준비 호출 실패(무시): ${(e as Error).message ?? e}`);
    return false;
  }
}

/** 웹 접수 수거(마스킹) + 리플레이 투입. 들어온 건수를 돌려준다. */
export async function ingest(): Promise<number> {
  return (await db.pull_inbox()) + (await replay.step());
}

let _replay_active = false;
let _replay_checked = 0;
/** 루프용 수거 한 번. 리플레이가 꺼져 있으면 상태 조회는 5초에 한 번만 — 비어 있을 때는 접수함 쿼리 1개만 돈다. */
export async function ingest_tick(): Promise<number> {
  const moved = await db.pull_inbox();
  let replayed = 0;
  const t = Date.now();
  if (_replay_active || t - _replay_checked >= REPLAY_CHECK_MS) {
    _replay_checked = t;
    replayed = await replay.step();
    _replay_active = replayed > 0 || Boolean((await replay.progress())?.active);
  }
  if (moved + replayed) classify_wake.notify();          // 새 민원이 생겼다 → 분류 루프를 바로 깨운다
  return moved + replayed;
}

/** 웹 접수 · 리플레이 투입 + 분류. 처리한 건수를 돌려준다 (--once 용). */
export async function fast_path(batch: number): Promise<number> {
  return (await ingest()) + (await classify_step(batch));
}

/** ①분류 한 배치. 대기 건수를 돌려준다.
 *  분류가 끝나면 심각도 스냅샷을 바로 남긴다. 계산은 결정적 함수라 LLM 비용이 없고, 웹 관제 화면은 이 스냅샷을 실시간 구독으로 받는다. */
export async function classify_step(batch: number): Promise<number> {
  const { run_once: classify } = await import("./agents/classifier.ts");
  const pending = await db.pending_count();
  if (pending) {
    await classify(batch);
    const ranked = await db.ranked();
    if (ranked.length) await db.save_severity(ranked, db.SEVERITY_BASIS);
    await issues.refresh();             // 분류가 끝난 즉시 카드에도 반영 (문구는 ④가 따로 씀)
  }
  return pending;
}

/** 지금 DB 기준으로 심각도 스냅샷과 이슈 카드를 한 번 다시 계산한다 (규칙 계산만, LLM 호출 없음).
 *  워커 시작 때 부른다 — 새 민원이 올 때까지 시간 지남(S-04 1시간)·조치 완료 반영이 멈춰 있지 않게. */
export async function recompute_now(): Promise<void> {
  const ranked = await db.ranked();
  if (ranked.length && !(await db.severity_recorded(ranked, db.SEVERITY_BASIS))) await db.save_severity(ranked, db.SEVERITY_BASIS);
  await issues.refresh();
}

/** 웹의 '조치요청서 생성' 버튼 요청을 처리한다. */
export async function doc_jobs(): Promise<void> {
  const dispatcher = await import("./agents/dispatcher.ts");
  for (const job of await db.claim_doc_jobs()) {
    const label = job.label;
    try {
      const item = (await db.ranked()).find((r) => r.label === label);
      if (!item) throw new Error("처리 안 된 해당 유형 민원이 없습니다");
      const { res, row } = await DISPATCH_LOCK.run(async () => {
        const conn = await db.connect();
        const before = (await conn.execute("SELECT MAX(id) m FROM action_request")).fetchone()?.m || 0;
        const res = await dispatcher.run_for(label, item.score, item.grade, item.formula);
        const row = (await conn.execute("SELECT MAX(id) m FROM action_request WHERE label=? AND id>?", [label, before])).fetchone();
        return { res, row };
      });
      if (!row || !row.m) throw new Error(`문서가 만들어지지 않았습니다: ${String(res ?? "").slice(0, 120)}`);
      await db.finish_doc_job(job.id, row.m);
      console.log(`  ③조치   (웹 요청) ${String(res ?? "").slice(0, 120)}`);
    } catch (e) {
      await db.finish_doc_job(job.id, null, String((e as Error).message ?? e));
      console.log(`  ③조치   (웹 요청 실패) ${label}: ${(e as Error).message ?? e}`);
    }
  }
}

// 개발자 보기용 루프 상태 (D5-62). 같은 루프는 10초에 한 번만 쓴다 (운영 DB 왕복을 늘리지 않게). 실패는 바로 쓴다.
const STATUS_EVERY_MS = 10_000;
const _status_at = new Map<string, number>();

async function track<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  let ok = true, note = "";
  try {
    return await fn();
  } catch (e) {
    ok = false;
    note = String((e as Error)?.message ?? e);
    throw e;
  } finally {
    const took = Date.now() - t0;
    if (!ok || t0 - (_status_at.get(name) ?? 0) >= STATUS_EVERY_MS || took >= STATUS_EVERY_MS) {
      _status_at.set(name, t0);
      await db.set_worker_status(name, took, ok, note);
      if (name === "agents") await db.set_worker_status("_backend", 0, true, llm.backend());
    }
  }
}

/** 한 번 실행. 예외는 찍고 로그에 남긴 뒤 삼킨다 — 루프가 죽지 않게. */
async function _guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const tb = (e as Error)?.stack ?? String(e);
    console.error(tb);
    try { await db.log_agent("worker", "error", "", tb.slice(-200)); } catch { /* 로그를 못 남겨도 계속 */ }
  }
}

async function _loop(fn: () => Promise<void>, interval: number): Promise<never> {
  for (;;) {
    await _guarded(fn);
    await sleep(interval * 1000);
  }
}

/** 웹 요청 전용 루프. Agent Path 와 따로 돌아 요청 후 바로 작성에 들어간다. */
export function doc_loop(interval: number): Promise<never> {
  return _loop(() => track("doc_jobs", () => doc_jobs()), interval);
}

const ISSUE_INTERVAL = 5.0;
const PURGE_INTERVAL = 600.0;          // 출처 해시(submit_rate)는 접수가 없어도 10분마다 지운다

/** 관제 카드 갱신 루프. 건수·마지막 시각·최신 민원·조치 그룹을 LLM 없이 바로 반영한다.
 *  조치 상태를 사람이 바꾸거나 시간이 흘러 '최근' 값이 바뀌는 것도 여기서 따라간다. 값이 그대로면 쓰지 않으므로 화면이 매번 다시 그려지지 않는다. */
export function issue_loop(): Promise<never> {
  let last_purge = 0;
  return _loop(() => track("issues", async () => {
    await issues.refresh();
    await review.raise_stale_alerts();        // 안전 의심 확인 필요가 15분 넘게 방치되면 알림 1회 (시간 기반이라 여기서)
    if (Date.now() / 1000 - last_purge >= PURGE_INTERVAL) {      // 24시간 지난 출처 해시·실패 기록 정리 (D5-33)
      last_purge = Date.now() / 1000;
      await intake.purge_old();
    }
  }), ISSUE_INTERVAL);
}

/** 접수 수거 전용 루프. 분류·Agent Path 가 오래 걸려도 유입은 바로 뜬다. */
export async function ingest_loop(interval: number, listener: inbox_listen.Listener | null = null): Promise<never> {
  for (;;) {
    await _guarded(() => track("ingest", async () => {
      const n = await ingest_tick();
    if (n) {
      const prog = await replay.progress();
      const tail = prog && prog.active ? ` · 재생 ${prog.cursor}/${prog.total} (${prog.sim_now})` : "";
      console.log(`[worker] 접수 ${n}건${tail}`);
    }
    }));
    // 다음 수거까지: 접수 알림(NOTIFY)이 오면 바로, 아니면 예비 폴링 (알림이 살아 있으면 조금 느슨하게)
    await inbox_wake.wait((listener?.live() ? Math.max(interval, LISTEN_POLL) : interval) * 1000);
  }
}

/** ②감시 → ③조치 → ④통합. 마지막에 통합이 합친다. 세 에이전트가 같은 처리 안 된 민원을 본다. */
export async function agent_path(given_plan: Plan | null = null): Promise<void> {
  const dispatcher = await import("./agents/dispatcher.ts");
  const monitor = await import("./agents/monitor.ts");
  const planner = await import("./agents/planner.ts");
  const supervisor = await import("./agents/supervisor.ts");

  // 계획(D5-65): 이번 주기에 무엇을 할지 계획 에이전트가 정한다. 분류(①)는 별도 루프에서 항상 돌고, ②는 항상 돈다(필수 단계).
  const plan = given_plan ?? await planner.run_once();
  console.log(`  계획     집중 [${plan.focus_labels.join(",")}] · ③${plan.run_dispatcher ? "O" : "X"} ④${plan.run_supervisor ? "O" : "X"}` +
    (plan.overrides.length ? ` · 안전 규칙으로 보정 ${plan.overrides.length}건` : "") + ` — ${plan.reason.slice(0, 80)}`);

  let out = await monitor.run_once();
  if (out) console.log(`  ②감시   ${out.slice(0, 120)}`);

  const targets = plan.run_dispatcher
    ? (await dispatcher.pending_labels()).filter((p: any) => p.grade === "immediate" || !plan.focus_labels.length || plan.focus_labels.includes(p.label))
    : [];
  for (const item of targets.slice(0, 2)) {      // 한 주기에 최대 2건
    await DISPATCH_LOCK.run(async () => {
      // 락을 기다리는 사이 웹 요청으로 같은 유형 문서가 생겼을 수 있다
      const still = new Set((await dispatcher.pending_labels()).map((p: any) => p.label));
      if (!still.has(item.label)) return;
      const res = await dispatcher.run_for(item.label, item.score, item.grade, item.formula);
      if (res) console.log(`  ③조치   ${String(res).slice(0, 120)}`);
    });
  }

  if (plan.run_supervisor) {
    out = await supervisor.run_once();
    if (out) console.log(`  ④통합   ${out.slice(0, 160)}`);
  }

  // 에이전트가 일한 결과를 할 일 목록에 반영한다. 내용이 그대로면 파일을 건드리지 않는다.
  // (core/todo.ts 가 아직 없으면 — 이전 중 — 이 단계만 건너뛴다)
  let todo: any = null;
  try { todo = await import("./core/todo.ts"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; }
  if (todo) {
    const [done, total, changed] = await todo.refresh();
    if (changed) console.log(`  할일     진행 ${done}/${total} 갱신`);
  }
}

async function main(): Promise<void> {
  // --sqlite 는 값이 있어도 없어도 된다 (parseArgs 의 string 옵션은 값이 꼭 필요하므로 먼저 떼어 낸다)
  const argv = process.argv.slice(2);
  let sqlite: string | null = null;
  const si = argv.indexOf("--sqlite");
  if (si >= 0) {
    const next = argv[si + 1];
    const has_path = next !== undefined && !next.startsWith("--");
    sqlite = has_path ? path.resolve(next) : path.join(config.BASE_DIR, "festival.db");
    argv.splice(si, has_path ? 2 : 1);
  }
  const { values: a } = parseArgs({
    args: argv,
    options: {
      interval: { type: "string", default: "1.0" },          // 접수 수거 폴링 주기(초) — LISTEN/깨우기가 예비 폴링보다 먼저 깨운다 (D5-71)
      "agent-interval": { type: "string", default: "60.0" }, // Agent Path 주기(초)
      batch: { type: "string", default: "20" },              // 분류 배치 크기
      "no-agents": { type: "boolean", default: false },      // ①분류만 실행
      once: { type: "boolean", default: false },             // 한 주기만
    },
  });
  const interval = Number(a.interval), agentInterval = Number(a["agent-interval"]), batch = Number(a.batch);
  const noAgents = a["no-agents"] as boolean, once = a.once as boolean;

  if (sqlite !== null) {
    // 운영 Supabase 와 끊고 SQLite 파일로 돈다. 환경변수도 비워 자식 코드(로깅·다른 모듈)가 URL 을 다시 읽지 않게 한다.
    // Storage 설정(SUPABASE_URL·SERVICE_KEY)도 같이 비운다 — 안 그러면 테스트 DOCX 가 운영 Storage 에 올라간다 (D5-57).
    for (const k of ["SUPABASE_DB_URL", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) process.env[k] = "";
    config.SUPABASE_DB_URL = "";
    config.SUPABASE_URL = "";
    config.SUPABASE_SERVICE_KEY = "";
    config.DB_PATH = sqlite;
    console.log(`DB: SQLite ${path.basename(sqlite)}`);
  }

  if (!once) {
    // 같은 DB 로 워커가 둘 뜨면 같은 대기 민원을 둘이 분류한다 (Agent Path 도 겹친다)
    const lock = await procguard.acquire("worker", config.DB_PATH);
    if (lock === null) {
      console.error("[worker] 같은 DB 로 이미 워커가 실행 중입니다. 중복 실행을 막았습니다.");
      process.exit(1);
    }
  }

  await db.init_db();
  await replay.ensure();
  await _guarded(recompute_now);
  console.log(`[worker] 시작 · Fast ${interval}s · Agent ${noAgents ? "off" : `${agentInterval}s`}`);

  if (once) {
    await _guarded(async () => {
      const n = await fast_path(batch);
      await issues.refresh();
      if (n) console.log(`[worker] 처리 ${n}건`);
      if (!noAgents) {
        await doc_jobs();
        if (n) {
          console.log("[worker] Agent Path 실행");
          await agent_path();
        }
      }
    });
    await db.close_all();
    return;
  }

  await db.set_worker_status("_backend", 0, true, llm.backend());
  void warmup().then((ok) => { if (llm.backend() === "anthropic") console.log(`[worker] 준비 호출 ${ok ? "완료" : "실패 (무시하고 계속)"}`); });   // 첫 분류 콜드스타트 줄이기
  void issue_loop();
  // Postgres 면 접수 알림(LISTEN/NOTIFY)으로 바로 깨어난다. 못 받아도 수거 루프의 폴링이 예비로 받는다.
  const listener = db.is_pg() ? inbox_listen.start_listener(() => inbox_wake.notify(), (m) => console.log(m)) : null;
  void ingest_loop(interval, listener);
  if (!noAgents) void doc_loop(Math.max(interval, SLOW_POLL));

  let agentsRunning = false;
  let lastAgent = 0;                     // 직전 Agent Path 가 끝난 시각
  let processedSinceAgent = 0;

  const runAgents = async () => {
    await _guarded(() => track("agents", () => agent_path()));
    lastAgent = Date.now() / 1000;
    agentsRunning = false;
  };

  for (;;) {
    try {
      const n = await track("classify", () => classify_step(batch));
      processedSinceAgent += n;
      if (n) console.log(`[worker] 분류 ${n}건`);
      if (n > batch && (await db.pending_count()) < n) continue;   // 대기가 한 배치보다 많고 줄어들고 있으면 쉬지 않고 이어서 (못 줄이면 기다린다)

      const idle = !agentsRunning;
      const due = Date.now() / 1000 - lastAgent >= agentInterval;
      if (!noAgents && idle && due && processedSinceAgent) {
        console.log("[worker] Agent Path 실행");
        processedSinceAgent = 0;
        agentsRunning = true;
        void runAgents();
      }
    } catch (e) {
      const tb = (e as Error)?.stack ?? String(e);
      console.error(tb);
      try { await db.log_agent("worker", "error", "", tb.slice(-200)); } catch { /* */ }
    }
    // 새 민원이 생기면 수거 루프가 깨워 준다 (classify_wake). 깨우기가 없어도 SLOW_POLL 마다 본다.
    await classify_wake.wait(SLOW_POLL * 1000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.on("SIGINT", () => { console.log("\n[worker] 종료"); process.exit(0); });
  main().catch((e) => { console.error(e); process.exit(1); });
}
