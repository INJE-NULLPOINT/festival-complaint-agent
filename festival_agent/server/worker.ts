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
//     node server/worker.ts                      기본 (분류 3초 / 에이전트 60초)
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
// --once 는 루프 없이 예전처럼 한 번씩 차례로 돈다.
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "./core/config.ts";
import * as db from "./core/db.ts";
import * as intake from "./core/intake.ts";
import * as issues from "./core/issues.ts";
import * as procguard from "./core/procguard.ts";
import * as replay from "./core/replay.ts";
import * as review from "./core/review.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** 웹 접수 수거(마스킹) + 리플레이 투입. 들어온 건수를 돌려준다. */
export async function ingest(): Promise<number> {
  return (await db.pull_inbox()) + (await replay.step());
}

/** 웹 접수 · 리플레이 투입 + 분류. 처리한 건수를 돌려준다 (--once 용). */
export async function fast_path(batch: number, window: number): Promise<number> {
  return (await ingest()) + (await classify_step(batch, window));
}

/** ①분류 한 배치. 대기 건수를 돌려준다.
 *  분류가 끝나면 심각도 스냅샷을 바로 남긴다. 계산은 결정적 함수라 LLM 비용이 없고, 웹 관제 화면은 이 스냅샷을 실시간 구독으로 받는다. */
export async function classify_step(batch: number, window: number): Promise<number> {
  const { run_once: classify } = await import("./agents/classifier.ts");
  const pending = await db.pending_count();
  if (pending) {
    await classify(batch);
    const ranked = await db.ranked(window);
    if (ranked.length) await db.save_severity(ranked, `${window}min`);
    await issues.refresh(window);             // 분류가 끝난 즉시 카드에도 반영 (문구는 ④가 따로 씀)
  }
  return pending;
}

/** 웹의 '조치요청서 생성' 버튼 요청을 처리한다. */
export async function doc_jobs(window: number): Promise<void> {
  const dispatcher = await import("./agents/dispatcher.ts");
  for (const job of await db.claim_doc_jobs()) {
    const label = job.label;
    try {
      const item = (await db.ranked(window)).find((r) => r.label === label);
      if (!item) throw new Error("최근 창에 해당 유형 민원이 없습니다");
      const { res, row } = await DISPATCH_LOCK.run(async () => {
        const conn = await db.connect();
        const before = (await conn.execute("SELECT MAX(id) m FROM action_request")).fetchone()?.m || 0;
        const res = await dispatcher.run_for(label, item.score, item.grade, item.formula, window);
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
export function doc_loop(window: number, interval: number): Promise<never> {
  return _loop(() => doc_jobs(window), interval);
}

const ISSUE_INTERVAL = 5.0;
const PURGE_INTERVAL = 600.0;          // 출처 해시(submit_rate)·운영자 코드 실패 기록은 접수·실패가 없어도 10분마다 지운다

/** 관제 카드 갱신 루프. 건수·마지막 시각·최신 민원·조치 그룹을 LLM 없이 바로 반영한다.
 *  조치 상태를 사람이 바꾸거나 시간이 흘러 '최근' 값이 바뀌는 것도 여기서 따라간다. 값이 그대로면 쓰지 않으므로 화면이 매번 다시 그려지지 않는다. */
export function issue_loop(window: number): Promise<never> {
  let last_purge = 0;
  return _loop(async () => {
    await issues.refresh(window);
    await review.raise_stale_alerts();        // 안전 의심 확인 필요가 15분 넘게 방치되면 알림 1회 (시간 기반이라 여기서)
    if (Date.now() / 1000 - last_purge >= PURGE_INTERVAL) {      // 24시간 지난 출처 해시·실패 기록 정리 (D5-33)
      last_purge = Date.now() / 1000;
      await intake.purge_old();
    }
  }, ISSUE_INTERVAL);
}

/** 접수 수거 전용 루프. 분류·Agent Path 가 오래 걸려도 유입은 바로 뜬다. */
export function ingest_loop(interval: number): Promise<never> {
  return _loop(async () => {
    const n = await ingest();
    if (n) {
      const prog = await replay.progress();
      const tail = prog && prog.active ? ` · 재생 ${prog.cursor}/${prog.total} (${prog.sim_now})` : "";
      console.log(`[worker] 접수 ${n}건${tail}`);
    }
  }, interval);
}

/** ②감시 → ③조치 → ④통합. 마지막에 통합이 합친다. 세 에이전트가 같은 창을 본다. 다르면 건수·점수가 서로 어긋난다. */
export async function agent_path(window: number): Promise<void> {
  const dispatcher = await import("./agents/dispatcher.ts");
  const monitor = await import("./agents/monitor.ts");
  const supervisor = await import("./agents/supervisor.ts");

  let out = await monitor.run_once(window);
  if (out) console.log(`  ②감시   ${out.slice(0, 120)}`);

  for (const item of (await dispatcher.pending_labels()).slice(0, 2)) {      // 한 주기에 최대 2건
    await DISPATCH_LOCK.run(async () => {
      // 락을 기다리는 사이 웹 요청으로 같은 유형 문서가 생겼을 수 있다
      const still = new Set((await dispatcher.pending_labels()).map((p: any) => p.label));
      if (!still.has(item.label)) return;
      const res = await dispatcher.run_for(item.label, item.score, item.grade, item.formula, window);
      if (res) console.log(`  ③조치   ${String(res).slice(0, 120)}`);
    });
  }

  out = await supervisor.run_once(window);
  if (out) console.log(`  ④통합   ${out.slice(0, 160)}`);

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
      interval: { type: "string", default: "3.0" },          // Fast Path 주기(초)
      "agent-interval": { type: "string", default: "60.0" }, // Agent Path 주기(초)
      batch: { type: "string", default: "20" },              // 분류 배치 크기
      "no-agents": { type: "boolean", default: false },      // ①분류만 실행
      once: { type: "boolean", default: false },             // 한 주기만
      window: { type: "string" },                            // 심각도 창(분)
    },
  });
  const interval = Number(a.interval), agentInterval = Number(a["agent-interval"]), batch = Number(a.batch);
  const noAgents = a["no-agents"] as boolean, once = a.once as boolean;
  const window = a.window !== undefined ? Number(a.window) : config.DEFAULT_WINDOW_MIN;

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
  console.log(`[worker] 시작 · Fast ${interval}s · Agent ${noAgents ? "off" : `${agentInterval}s`}`);

  if (once) {
    await _guarded(async () => {
      const n = await fast_path(batch, window);
      await issues.refresh(window);
      if (n) console.log(`[worker] 처리 ${n}건`);
      if (!noAgents) {
        await doc_jobs(window);
        if (n) {
          console.log("[worker] Agent Path 실행");
          await agent_path(window);
        }
      }
    });
    await db.close_all();
    return;
  }

  void issue_loop(window);
  void ingest_loop(interval);
  if (!noAgents) void doc_loop(window, interval);

  let agentsRunning = false;
  let lastAgent = 0;                     // 직전 Agent Path 가 끝난 시각
  let processedSinceAgent = 0;

  const runAgents = async () => {
    await _guarded(() => agent_path(window));
    lastAgent = Date.now() / 1000;
    agentsRunning = false;
  };

  for (;;) {
    try {
      const n = await classify_step(batch, window);
      processedSinceAgent += n;
      if (n) console.log(`[worker] 분류 ${n}건`);

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
    await sleep(interval * 1000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.on("SIGINT", () => { console.log("\n[worker] 종료"); process.exit(0); });
  main().catch((e) => { console.error(e); process.exit(1); });
}
