// 접수 → 분류 완료 벽시계 측정 (워커 폴링 포함) — 임시 DB, 운영 DB는 쓰지 않는다. (scripts/wall_clock.py 와 1:1)
//
// 실제 worker.ts(--no-agents)를 띄우고, 웹 접수(feedback_inbox)로 민원을 넣은 뒤 분류가 끝날 때까지 시간을 잰다.
// 호출 시간이 아니라 '접수 → 분류 완료' 전체(워커 수거 3초 주기 + 분류 주기 + 모델 호출)다.
//
// 사용법
//     node server/scripts/wall_clock.ts                                   agent 모드 · claude_code · 1건 3번 + 5건 1번
//     node server/scripts/wall_clock.ts --mode prefetch                   B′ 모드 (CLASSIFY_MODE=prefetch)
//     node server/scripts/wall_clock.ts --mode agent --n 5 --batch 10     1건 5번 + 10건 묶음
//     node server/scripts/wall_clock.ts --backend anthropic               API 경로 (키가 있을 때 — 제출 기준 측정)
//     node server/scripts/wall_clock.ts --backend local                   비용 없는 구조 확인 (규칙 대역)
//     node server/scripts/wall_clock.ts --backend local --concurrent 20   동시 접수 20건 — 유실·중복 수와 유입·분류 지연을 표로 (D6-8)
//
// 결과는 표로 출력한다. --report 를 주면 tests/wall_clock_report.md 에도 쓴다 (덮어씀).
// 판정 기준은 '중앙값'과 '최댓값'이다 (신청서 목표: 접수 후 10초 이내). 폴링 위상을 흩으려고 접수 전에 0~3초 무작위로 쉰다.
import "./_safe_env.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BASE_DIR, config } from "../core/config.ts";
import * as db from "../core/db.ts";
import { fixed } from "../core/pyfmt.ts";
import * as webapi from "../webapi.ts";
import { median, mkdtemp, percentile, refuse_live_db, same_path, sleep, write_text, ymd_hm } from "./_common.ts";

const ROOT = BASE_DIR;
const SERVER = path.join(ROOT, "server");

// 문장은 측정용으로 **지어낸 가상 민원**이다 — 실제 방문객이 쓴 글이 아니다 (24개; 서로 달라야 캐시·같은 글 합치기에 걸리지 않는다). 구역은 돌아가며 쓴다.
// 24개를 넘으면 text_for() 가 '(N번째 시험)' 번호를 붙여 이어 쓴다.
export const TEXTS = [
  "유등터널 입구에서 사람들이 한꺼번에 몰려 앞으로 나가기 힘들었어요",
  "임시 화장실 앞 줄이 너무 길어서 삼십 분이나 기다렸습니다",
  "먹거리장터 어묵 가격이 너무 비싸서 놀랐어요",
  "촉석루 가는 길 표지판이 없어서 헤맸어요",
  "남강 수상무대 옆 계단 난간이 흔들려서 무서웠어요",
  "셔틀버스가 한참 오지 않아서 승강장에서 오래 기다렸어요",
  "소망등 달기 구역 안내가 없어서 물어보고 다녔어요",
  "주차장이 만차라서 한참 돌다가 겨우 세웠습니다",
  "공연이 정말 좋았고 다음에도 꼭 오고 싶어요",
  "다리 위 바닥이 젖어서 미끄러질 뻔했어요",
  "진주교 근처 조명이 꺼져 있어 많이 어두웠어요",
  "화장실 휴지가 다 떨어져서 그냥 나왔습니다",
  "주차 안내요원이 없어서 차들이 엉켜 있었어요",
  "소망등 값이 생각보다 비싸서 망설였어요",
  "출구를 알려 주는 표시가 없어서 한참 돌았어요",
  "터널 안이 너무 붐벼서 아이 손을 놓칠 뻔했어요",
  "먹거리장터 줄이 너무 길어서 음식을 받는 데 사십 분이 걸렸어요",
  "남강 수상무대 앞 통로가 막혀서 사람들이 서로 밀리고 있어요",
  "촉석루 계단 조명이 꺼져 있어서 내려가다 넘어질 뻔했습니다",
  "셔틀버스 승강장 표지가 없어서 어느 줄에 서야 할지 몰랐어요",
  "임시 화장실 세면대에 물이 안 나와서 손을 못 씻었어요",
  "진주교 남단 주차장 출구가 한 곳뿐이라 나가는 데 오래 걸렸어요",
  "소망등 달기 구역에서 안내 요원을 찾을 수 없어 한참 헤맸어요",
  "등이 정말 예뻐서 가족과 사진을 많이 찍었습니다 감사합니다",
];

/** k 번째 측정 문장. TEXTS 개수를 넘으면 같은 글이 아니도록 번호를 붙여 이어 쓴다 (같은 구역·같은 글 합치기에 걸리지 않게). */
export const text_for = (k: number): string => TEXTS[k % TEXTS.length] + (k >= TEXTS.length ? ` (${Math.floor(k / TEXTS.length) + 1}번째 시험)` : "");

interface Args { mode: string; backend: string; n: number; batch: number; concurrent: number; timeout: number; report: boolean }

async function stop_worker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode === null) {
    worker.kill();
    await Promise.race([new Promise((r) => worker.once("exit", r)), sleep(10_000)]);
    if (worker.exitCode === null) worker.kill("SIGKILL");
  }
}

/** 동시 접수 N건 — 서로 다른 문장을 N개가 한꺼번에 접수하고 워커가 처리하는 동안 지연을 잰다.
 *
 *  유실 = 접수번호는 받았는데 끝내 민원(feedback)이 안 생긴 건(저장 거절 포함). 중복 = 같은 문장이 민원으로 둘 이상 생긴 건.
 *  유입 지연 = 접수 시작 → feedback 생성, 분류 지연 = 접수 시작 → 분류(done·review) 완료. */
async function run_concurrent(args: Args, worker: ChildProcess, log_fd: number): Promise<number> {
  const n = args.concurrent;
  const texts = Array.from({ length: n }, (_, i) => `${TEXTS[i % TEXTS.length]} (${i + 1}번째 동시 접수 시험)`);
  const receipts = new Map<number, number>();          // 접수번호 → 문장 번호
  const errors: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });     // 모두 준비되면 한꺼번에 출발

  const go = async (i: number): Promise<void> => {
    await gate;
    try {
      const r = await webapi.submit_feedback(1 + i % 6, texts[i], null);
      if (r !== null) receipts.set(r, i);
    } catch (exc) {                      // 접수 자체가 실패한 것도 유실로 센다
      errors.push(String((exc as Error).message ?? exc));
    }
  };
  const t0 = Date.now() / 1000;
  const tasks = Array.from({ length: n }, (_, i) => go(i));
  await sleep(0);
  open();
  await Promise.all(tasks);
  const t_submitted = Date.now() / 1000 - t0;

  const seen_ingest = new Map<number, number>();
  const seen_done = new Map<number, number>();
  const deadline = Date.now() / 1000 + args.timeout;
  const conn = await db.connect();
  while (Date.now() / 1000 < deadline && seen_done.size < receipts.size) {
    for (const r of receipts.keys()) {
      const row = (await conn.execute(
        "SELECT i.feedback_id fid, c.status st FROM feedback_inbox i " +
        "LEFT JOIN classification c ON c.feedback_id=i.feedback_id WHERE i.id=?", [r])).fetchone();
      const now = Date.now() / 1000 - t0;
      if (row && row.fid !== null && row.fid !== -1 && !seen_ingest.has(r)) seen_ingest.set(r, now);
      if (row && ["done", "review"].includes(row.st) && !seen_done.has(r)) seen_done.set(r, now);
    }
    await sleep(100);
  }
  await stop_worker(worker);
  closeSync(log_fd);

  const fb = (await conn.execute("SELECT raw_text FROM feedback WHERE source='qr'")).fetchall().map((r) => r.raw_text as string);
  const dup = fb.length - new Set(fb).size;
  const lost = n - seen_done.size;                             // 끝내 분류까지 못 간 건 (접수 실패 포함)
  const lost_ingest = n - seen_ingest.size;
  const stat = (d: Map<number, number>): [string, string] => {
    const v = [...d.values()].sort((a, b) => a - b);
    return v.length ? [`${fixed(median(v), 1)}s`, `${fixed(Math.max(...v), 1)}s`] : ["-", "-"];
  };
  const lines = [
    `# 동시 접수 ${n}건 측정 (${ymd_hm(new Date())})`, "",
    `- 모드 \`${args.mode}\` · 백엔드 \`${args.backend}\` · 임시 DB(운영 DB 미사용) · 접수 ${n}건이 한꺼번에 출발 (접수 호출 완료까지 ${fixed(t_submitted, 2)}s)`, "",
    "| 지표 | 값 |", "|---|---|",
    `| 접수 성공 / 요청 | ${receipts.size} / ${n} (접수 오류 ${errors.length}건) |`,
    `| 유실(유입까지) | ${lost_ingest}건 |`, `| 유실(분류까지) | ${lost}건 |`, `| 중복 민원 | ${dup}건 |`,
    `| 유입 지연 중앙값 · 최댓값 | ${stat(seen_ingest)[0]} · ${stat(seen_ingest)[1]} |`,
    `| 분류 지연 중앙값 · 최댓값 | ${stat(seen_done)[0]} · ${stat(seen_done)[1]} |`, "",
  ];
  if (errors.length) lines.push(`- 접수 오류 예: ${errors[0].slice(0, 80)}`);
  const out = lines.join("\n");
  console.log("\n" + out);
  if (args.report) write_text(path.join(ROOT, "tests", "wall_clock_report.md"), out + "\n");
  return !lost && !dup ? 0 : 1;
}

async function main(): Promise<number> {
  refuse_live_db("wall_clock");
  const { values: v } = parseArgs({
    options: {
      mode: { type: "string", default: "prefetch" },       // 기본 분류 방식과 같게 (config.CLASSIFY_MODE, D5-69)
      backend: { type: "string", default: "claude_code" },
      n: { type: "string", default: "3" },
      batch: { type: "string", default: "5" },
      concurrent: { type: "string", default: "0" },
      timeout: { type: "string", default: "180" },
      report: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (v.help) { console.log("접수 → 분류 완료 벽시계 측정 (워커 폴링 포함) — 임시 DB, 운영 DB는 쓰지 않는다."); return 0; }
  const args: Args = {
    mode: v.mode as string, backend: v.backend as string, n: Number(v.n), batch: Number(v.batch),
    concurrent: Number(v.concurrent), timeout: Number(v.timeout), report: v.report as boolean,
  };
  if (!["agent", "prefetch"].includes(args.mode) || !["claude_code", "anthropic", "local"].includes(args.backend)) {
    console.error("--mode 는 agent|prefetch, --backend 는 claude_code|anthropic|local 이어야 합니다.");
    return 2;
  }

  const need = args.n + Math.max(args.batch, 0);
  if (!args.concurrent && need > 200) {
    console.log(`--n 과 --batch 합은 200 이하여야 합니다 (지금 ${need}).`);
    return 2;
  }
  const tmp = path.join(mkdtemp("wall_"), "t.db");
  // 이 프로세스(접수·확인)와 워커(자식)가 같은 임시 DB 를 본다. 운영 연결 값은 _safe_env 가 비웠다.
  config.DB_PATH = tmp;
  config.SUPABASE_DB_URL = "";
  const env = {
    ...process.env, DB_PATH: tmp, LLM_BACKEND: args.backend, CLASSIFY_MODE: args.mode, SUPABASE_DB_URL: "",
    SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", PYTHONIOENCODING: "utf-8", DOCS_DIR: path.join(path.dirname(tmp), "docs"),
  };
  if (!same_path(config.DB_PATH, tmp) || same_path(config.DB_PATH, path.join(ROOT, "festival.db"))) throw new Error("임시 DB 설정 실패");

  await db.init_db();
  const log_fd = openSync(path.join(path.dirname(tmp), "worker.log"), "w");
  const worker = spawn(process.execPath, [path.join(SERVER, "worker.ts"), "--no-agents"], { cwd: ROOT, stdio: ["ignore", log_fd, log_fd], env });
  console.log(`측정 시작: 모드 ${args.mode} · 백엔드 ${args.backend} · 임시 DB ${tmp} (워커 pid ${worker.pid})`);
  // 워커가 준비된 뒤부터 잰다 (D5-76): 실제 모델 백엔드는 워커가 시작 직후 준비 호출 1회를 한다 — 그게 끝날 때까지 기다리고 측정에 넣지 않는다.
  if (args.backend === "local") await sleep(4000);
  else {
    const log_path = path.join(path.dirname(tmp), "worker.log");
    const t_ready = Date.now();
    let ready = false;
    while (Date.now() - t_ready < 120_000) {
      const txt = existsSync(log_path) ? readFileSync(log_path, "utf-8") : "";
      if (/준비 호출 (완료|실패)/.test(txt)) { ready = true; break; }
      await sleep(300);
    }
    console.log(ready ? `워커 준비 호출 끝 (${fixed((Date.now() - t_ready) / 1000, 1)}초 기다림) — 이제부터 잰다` : "⚠ 준비 호출 표시를 못 봄 (120초) — 그대로 잰다");
    await sleep(1000);
  }

  const conn = await db.connect();
  const wait_done = async (receipts: number[]): Promise<Map<number, number>> => {
    const done = new Map<number, number>();
    const t0 = Date.now() / 1000;
    while (Date.now() / 1000 - t0 < args.timeout && done.size < receipts.length) {
      for (const r of receipts) {
        if (done.has(r)) continue;
        const row = (await conn.execute(
          "SELECT c.status FROM feedback_inbox i JOIN classification c ON c.feedback_id=i.feedback_id WHERE i.id=?", [r])).fetchone();
        if (row && ["done", "review"].includes(row.status)) done.set(r, Date.now() / 1000);
      }
      await sleep(250);
    }
    return done;
  };

  if (args.concurrent) return run_concurrent(args, worker, log_fd);

  const results: [string, number[], number][] = [];
  let k = 0;
  const trials: [string, number][] = [...Array.from({ length: args.n }, (_, i): [string, number] => [`1건 #${i + 1}`, 1]),
    ...(args.batch > 0 ? [[`${args.batch}건 묶음`, args.batch] as [string, number]] : [])];
  try {
    for (const [label, n] of trials) {
      await sleep(Math.random() * 3 * 1000);                     // 워커 폴링 주기의 위상을 흩는다
      const t = Date.now() / 1000;
      const receipts: number[] = [];
      for (let i = 0; i < n; i++) receipts.push((await webapi.submit_feedback(1 + (k + i) % 6, text_for(k + i), null))!);
      k += n;
      const done = await wait_done(receipts);
      const lat = receipts.filter((r) => done.has(r)).map((r) => done.get(r)! - t);
      results.push([label, lat, n - lat.length]);
      console.log(`  ${label}: ` + (lat.length ? [...lat].sort((a, b) => a - b).map((x) => `${fixed(x, 1)}s`).join(" / ") : "미완료") +
        (lat.length < n ? ` (미완료 ${n - lat.length}건)` : ""));
      await sleep(3000);
    }
  } finally {
    await stop_worker(worker);
    closeSync(log_fd);
  }

  const calls = (await conn.execute("SELECT COUNT(*) n, ROUND(AVG(latency_ms)) ms FROM agent_log " +
    "WHERE action IN ('cli_call','api_call') AND agent='classifier'")).fetchone()!;
  const lookups = Number((await conn.execute("SELECT COUNT(*) n FROM agent_log WHERE action='lookup_similar'")).fetchone()!.n);
  const tokens = (await conn.execute("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM agent_log " +
    "WHERE action IN ('cli_call','api_call')")).fetchone()!;

  const singles = results.filter(([label]) => label.startsWith("1건")).flatMap(([, lat]) => lat);
  const every = results.flatMap(([, lat]) => lat);
  const lines = [
    `# 접수→분류 벽시계 측정 (${ymd_hm(new Date())})`, "",
    `- 모드 \`${args.mode}\` · 백엔드 \`${args.backend}\` · 임시 DB (운영 DB 미사용) · 워커 폴링 포함`, "",
    "| 묶음 | 건수 | 최소 | 중앙값 | 최대 | 미완료 |", "|---|---|---|---|---|---|",
    ...results.map(([label, lat, miss]) => lat.length
      ? `| ${label} | ${lat.length} | ${fixed(Math.min(...lat), 1)}s | ${fixed(median(lat), 1)}s | ${fixed(Math.max(...lat), 1)}s | ${miss} |`
      : `| ${label} | 0 | - | - | - | ${miss} |`), "",
  ];
  if (singles.length) {
    const p90 = percentile(singles, 90);
    lines.push(`**1건 접수: 중앙값 ${fixed(median(singles), 1)}s · p90 ${fixed(p90, 1)}s · 최대 ${fixed(Math.max(...singles), 1)}s** ` +
      `(${singles.length}회 · 신청서 목표 10초 이내 → ${Math.max(...singles) <= 10 ? "달성" : median(singles) > 10 ? "미달" : p90 <= 10 ? "중앙값·p90 은 달성, 최대는 초과" : "중앙값은 달성, p90·최대는 초과"})`);
    lines.push(`- p90 = 정렬한 ${singles.length}개 중 ceil(0.9×${singles.length}) 번째 값(최근접 순위, 보간 없음)` + (singles.length < 20 ? ` · 표본이 ${singles.length}회뿐이라 참고용(20회 이상이면 의미 있음)` : ""));
  }
  const avg = calls.ms !== null && calls.ms !== undefined ? `${fixed(Number(calls.ms), 0)}ms` : "-";
  lines.push(`- 분류 모델 호출 ${calls.n}회 · 호출 평균 ${avg} · lookup_similar ${lookups}회 · ` +
    `입력 ${tokens.i} · 출력 ${tokens.o} 토큰`,
    args.backend === "claude_code" ? "- 백엔드 `claude_code` 는 CLI 경유 참고값이다. 제출 기준은 `--backend anthropic` 측정이다."
      : args.backend === "local" ? "- 백엔드 `local` 은 규칙 대역(모델 호출 없음)이라 구조 확인용이다. 제출 기준은 `--backend anthropic` 측정이다."
      : "- 제출 기준 측정(`--backend anthropic`).");
  const warm = (await conn.execute("SELECT latency_ms, input_tokens, output_tokens FROM agent_log WHERE action='warmup' ORDER BY id LIMIT 1")).fetchone();
  if (warm) lines.push(`- 준비 호출(워커 시작 직후 1회, 측정에 넣지 않음): ${fixed(Number(warm.latency_ms) / 1000, 1)}초 · 토큰 ${warm.input_tokens}→${warm.output_tokens}`);
  if (lookups === 0) {
    lines.push("- 기억 조회 0회: 측정용 빈 임시 DB라 비슷한 과거 사례가 없음. 기억 동작의 근거는 server/tests/memory.test.ts");
  } else {
    lines.push(`- 기억 조회 ${lookups}회: 측정 문장은 ${TEXTS.length}개라 ${TEXTS.length + 1}회째부터 같은 문장에 번호만 붙여 다시 써서 앞 측정 문장을 비슷한 사례로 찾음. ` +
      "번호가 붙은 글은 기억 정규화에서 덧붙은 내용으로 처리돼 LLM 호출을 건너뛰지 않으므로 LLM 판단·지연은 그대로. 기억 동작의 근거는 server/tests/memory.test.ts");
  }
  const out = lines.join("\n");
  console.log("\n" + out);
  if (args.report) {
    write_text(path.join(ROOT, "tests", "wall_clock_report.md"), out + "\n");
    console.log("\n리포트: tests/wall_clock_report.md");
  }
  return every.length ? 0 : 1;
}

if (import.meta.main) {
  const code = await main();
  await db.close_all();
  process.exit(code);
}
