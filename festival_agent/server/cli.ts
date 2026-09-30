// 터미널 인터페이스 — 브라우저 없이 전체 흐름을 다룬다. (cli.py 와 1:1 — 명령·옵션·출력 문구가 같다)
//
// 개발·검증·시연 리허설용. 웹 화면·워커와 같은 DB를 보므로 동시에 켜도 된다.
//
//     node server/cli.ts status                     현재 상태 (관제 화면의 터미널판)
//     node server/cli.ts submit "진입로가 어두워요"   민원 접수
//     node server/cli.ts cycle                      ①②③④ 한 바퀴
//     node server/cli.ts replay start --speed 300   리플레이
//     node server/cli.ts db log                     DB 조회
//     node server/cli.ts db restore <파일> --live-db  백업 JSON(backup/supabase_*.json)으로 DB 복원 (확인 질문 있음, 운영은 --live-db 필수)
//     node server/cli.ts demo                       E2E 자동 실행 (LLM_BACKEND=local 이면 LLM 없이)
//     node server/cli.ts reset --all                초기화
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BASE_DIR, config } from "./core/config.ts";
import * as db from "./core/db.ts";
import { fixed, floatstr } from "./core/pyfmt.ts";
import * as replay from "./core/replay.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 출력 유틸 ─────────────────────────────────────────────────────
const _COLOR = process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY);
const c = (text: string, code: string) => (_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => c(t, "1");
const dim = (t: string) => c(t, "2");
const red = (t: string) => c(t, "31");
const yellow = (t: string) => c(t, "33");
const green = (t: string) => c(t, "32");
const cyan = (t: string) => c(t, "36");
const ident = (s: string) => s;
const print = (s = "") => console.log(s);
/** Python f"{x:<n}" / f"{x:>n}" (코드 포인트 수 기준) */
const ljust = (s: unknown, n: number) => { const t = String(s); const len = [...t].length; return len >= n ? t : t + " ".repeat(n - len); };
const rjust = (s: unknown, n: number) => { const t = String(s); const len = [...t].length; return len >= n ? t : " ".repeat(n - len) + t; };
const num = (x: number) => floatstr(x);   // 점수 같은 float 는 Python 처럼 100.0 으로

const GRADE_COLOR: Record<string, (s: string) => string> = { immediate: red, high: yellow, mid: ident, low: dim };
const GRADE_MARK: Record<string, string> = { immediate: "!!", high: "! ", mid: "  ", low: "  " };

function rule(title = ""): void {
  const line = "─".repeat(64);
  print(!title ? `\n${dim(line)}` : `\n${bold(title)}  ${dim("─".repeat(Math.max(0, 62 - [...title].length)))}`);
}

type Args = Record<string, any>;

async function _backend_line(): Promise<string> {
  // 지금 어떤 백엔드로 도는지. 시연 중 모르면 안 되는 정보다.
  const llm = await import("./core/llm.ts");
  if (llm.is_local()) return yellow("  백엔드 local — 규칙 기반 대역입니다. 제출본이 아닙니다.");
  if (llm.is_cli()) {
    return yellow(`  백엔드 claude_code (${config.MODEL}, Claude Code CLI 경유) — 실제 모델이지만 개발용 경로입니다. 제출은 anthropic.`);
  }
  return green(`  백엔드 anthropic (${config.MODEL})`);
}

async function ranked_now(window: number | null = null): Promise<[any[], number]> {
  const win = window || config.DEFAULT_WINDOW_MIN;
  return [await db.ranked(win), (await db.window_rows(win)).length];
}

const sumValues = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const hhmmss = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

// ── status ────────────────────────────────────────────────────────
async function cmd_status(args: Args): Promise<void> {
  const conn = await db.connect();
  const fest = (await conn.execute("SELECT * FROM festival LIMIT 1")).fetchone();
  const brief = (await conn.execute("SELECT * FROM briefing ORDER BY id DESC LIMIT 1")).fetchone();
  const alerts = (await conn.execute("SELECT * FROM alert WHERE acked=0 ORDER BY id DESC LIMIT 5")).fetchall();

  const win = args.window || config.DEFAULT_WINDOW_MIN;
  const total_counts = await db.label_counts();          // 누적 (전 기간)
  const counts = await db.label_counts(win);             // 창 기준 — 심각도와 같은 모집단
  const [ranked, win_total] = await ranked_now(win);
  const pending = await db.pending_count();
  const reviewN = await db.review_count();

  print(`\n${bold(fest ? fest.name : "축제")}   `
    + dim(`누적 ${sumValues(total_counts) + pending}건 · 분류완료 ${sumValues(total_counts)} · 대기 ${pending}` + (reviewN ? ` · 확인필요 ${reviewN}` : "")));
  const dn = await db.data_now();
  print(dim(`  데이터 기준 ${String(dn.getMonth() + 1).padStart(2, "0")}-${String(dn.getDate()).padStart(2, "0")} ${String(dn.getHours()).padStart(2, "0")}:${String(dn.getMinutes()).padStart(2, "0")} · 창 ${win}분 (${win_total}건)`));
  print(await _backend_line());
  if (win_total < sumValues(total_counts) * 0.3) print(dim(`  창 밖 데이터가 많습니다.  --window ${win * 24}  처럼 넓혀 보세요`));

  const prog = await replay.progress();
  if (prog && prog.active) print(dim(`  리플레이 ${fixed(prog.speed, 0)}배속 · ${prog.cursor}/${prog.total} · 시뮬 ${prog.sim_now}`));

  // 브리핑
  rule("통합 에이전트 브리핑");
  if (brief) {
    print(`  ${cyan(brief.text)}`);
    if (brief.rationale) print(dim(`  근거: ${brief.rationale}`));
    print(dim(`  ${brief.created_at}`));
  } else {
    print(dim("  아직 없음.  node server/cli.ts brief  로 생성"));
  }

  // 알림
  if (alerts.length) {
    rule("알림");
    const kind: Record<string, string> = { spike: "급증", safety_threshold: "안전 임계", grade_up: "등급 상승" };
    for (const a of alerts) {
      print(`  ${red("▲")} ${bold(kind[a.kind] ?? a.kind)} ${config.LABELS[a.label] ?? a.label}  ${dim(String(a.created_at).slice(11, 19))}`);
      print(`    ${a.detail}`);
    }
  }

  // 두 순위
  rule(`건수 순위  vs  심각도 순위  (최근 ${win}분)`);
  print(`  ${ljust("", 4)}${ljust("건수", 22)}${ljust("", 4)}${ljust("심각도", 28)}`);
  const cl = Object.entries(counts);
  for (let i = 0; i < Math.max(cl.length, ranked.length); i++) {
    let left = "";
    if (i < cl.length) left = `${i + 1}. ${ljust(config.LABELS[cl[i][0]] ?? cl[i][0], 9)}${rjust(cl[i][1], 4)}건`;
    let right = "";
    if (i < ranked.length) {
      const r = ranked[i];
      const col = GRADE_COLOR[r.grade] ?? ident;
      right = col(`${GRADE_MARK[r.grade]}${i + 1}. ${ljust(config.LABELS[r.label] ?? r.label, 9)}${rjust(num(r.score), 6)}  ${r.grade}`);
    }
    print(`  ${ljust(left, 28)}  ${right}`);
  }

  if (ranked.length) {
    rule("판정 근거 (상위 3)");
    for (const r of ranked.slice(0, 3)) {
      print(`  ${bold(config.LABELS[r.label] ?? r.label)}  ${num(r.score)}점 · ${r.freq}건`);
      print(dim(`    ${r.formula}`));
      if (r.spike.spiked) {
        print(yellow(`    급증: 최근 ${config.SPIKE_WINDOW_MIN}분 ${r.spike.rate}/분 (기준 ${r.spike.baseline}/분, ${r.spike.multiplier}배)`));
      }
    }
  }

  // 조치
  const actions = await db.open_actions();
  if (actions.length) {
    rule("조치요청서");
    const st: Record<string, string> = { requested: "요청", in_progress: "조치중", done: "완료" };
    for (const a of actions.slice(0, 6)) {
      print(`  [${ljust(st[a.status] ?? a.status, 3)}] ${ljust(a.department, 10)} ${ljust(config.LABELS[a.label] ?? a.label, 9)} ${rjust(a.count, 3)}건  ${dim(String(a.created_at).slice(5, 16))}`);
    }
  }
  print();
}

// ── check ─────────────────────────────────────────────────────────
async function cmd_check(_args: Args): Promise<void> {
  // 키가 유효한지 최소 비용으로 확인한다. 전체 cycle 전에 먼저 돌린다.
  const llm = await import("./core/llm.ts");

  print(bold("\n백엔드"));
  print(await _backend_line());
  print(dim("  LLM_BACKEND 로 전환합니다 (anthropic | claude_code | local). 미지정이면 키 유무로 자동 판단합니다."));

  if (llm.is_cli()) {
    const exe = llm.cli_path();
    print(bold("\nClaude Code CLI"));
    print(`  claude  ${exe ? green(exe) : red("찾을 수 없음 (PATH 확인)")}`);
    print(dim("  구독 사용량을 씁니다. worker 상시 구동보다 cycle 1회·소량 측정으로 확인하세요."));
    print(bold("\n실행 규모"));
    print(`  분류 대기 ${await db.pending_count()}건`);
    return;
  }

  print(bold("\n자격증명"));
  const key = process.env.ANTHROPIC_API_KEY;
  const env = path.join(BASE_DIR, ".env");
  print(`  ANTHROPIC_API_KEY  ${key ? green("설정됨") : red("미설정")}${key ? dim(`  (…${key.slice(-6)})`) : ""}`);
  print(`  .env 파일          ${fs.existsSync(env) ? green("있음") : dim("없음")}`);

  const tourapi = await import("./core/tourapi.ts");
  print(`  TOURAPI_KEY        ${tourapi.available() ? green("설정됨") : dim("미설정 (선택)")}`);

  if (llm.is_local()) {
    print(dim("\n  local 백엔드라 API 를 호출하지 않습니다."));
    print(dim("  실제 모델로 검증하려면 .env 에 ANTHROPIC_API_KEY 를 넣거나"));
    print(dim("  LLM_BACKEND=anthropic 을 설정하십시오."));
    print(bold("\n실행 규모"));
    print(`  분류 대기 ${await db.pending_count()}건`);
    return;
  }

  if (!key && !fs.existsSync(env)) {
    print(red("\n  키가 없습니다.") + " .env 파일을 만들고 아래 한 줄을 넣으십시오.");
    print(dim("    ANTHROPIC_API_KEY=sk-ant-..."));
    return;
  }

  print(bold("\nAPI 호출 (최소 토큰)"));
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  try {
    const r: any = await (llm.client() as any).messages.create({
      model: config.MODEL,
      max_tokens: 16,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "OK 라고만 답해." }],
    });
    const txt = r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    const u = r.usage;
    print(`  ${green("성공")}  모델 ${config.MODEL}`);
    print(`  응답: ${txt.slice(0, 40)}`);
    print(dim(`  토큰: 입력 ${u.input_tokens} / 출력 ${u.output_tokens}`));
  } catch (exc: any) {
    if (exc instanceof Anthropic.AuthenticationError) { print(red("  인증 실패") + " — 키가 잘못됐거나 만료됐습니다."); return; }
    if (exc instanceof Anthropic.NotFoundError) { print(red("  모델을 찾을 수 없음") + " — core/config.ts 의 MODEL 확인"); return; }
    if (exc instanceof Anthropic.RateLimitError) { print(yellow("  요청 한도 초과") + " — 잠시 후 다시 시도하십시오."); return; }
    if (exc instanceof Anthropic.APIConnectionError) { print(red("  연결 실패") + " — 네트워크를 확인하십시오."); return; }
    if (exc instanceof Anthropic.APIError) { print(red(`  API 오류 ${exc.status}`) + ` — ${String(exc.message).slice(0, 120)}`); return; }
    throw exc;
  }

  print(bold("\n실행 규모"));
  const pending = await db.pending_count();
  print(`  분류 대기 ${pending}건`);
  if (pending > 30) print(yellow("  대기가 많습니다. 먼저  node server/cli.ts classify --batch 10  으로 소량만 돌려 보십시오."));
  print(dim("\n  준비됐습니다.  node server/cli.ts cycle  로 ①②③④ 한 바퀴를 돌립니다."));
}

// ── submit ────────────────────────────────────────────────────────
async function cmd_submit(args: Args): Promise<void> {
  const zones = await db.zones();
  const names = zones.map((z) => z.name);
  let zid: number, zname: string;
  if (args.zone) {
    const match = zones.filter((z) => String(z.name).includes(args.zone));
    if (!match.length) {
      print(red(`구역을 찾을 수 없습니다: ${args.zone}`));
      print(dim("  " + names.join(" / ")));
      return;
    }
    zid = match[0].id; zname = match[0].name;
  } else {
    zid = zones[0].id; zname = zones[0].name;
  }

  const fid = await db.insert_feedback(zid, args.text, "cli");
  if (fid === null) { print(yellow("이미 접수된 내용입니다.")); return; }

  const conn = await db.connect();
  const stored = (await conn.execute("SELECT raw_text FROM feedback WHERE id=?", [fid])).fetchone()!;
  print(green(`접수 #${fid}`) + `  ${zname}`);
  print(`  저장: ${stored.raw_text}`);
  if (stored.raw_text !== args.text) print(yellow("  개인정보가 마스킹되었습니다."));
  print(dim(`  대기열 ${await db.pending_count()}건 ·  node server/cli.ts classify  로 분류`));
}

// ── 에이전트 ──────────────────────────────────────────────────────
async function cmd_classify(args: Args): Promise<void> {
  const { run_once } = await import("./agents/classifier.ts");
  const n = await db.pending_count();
  if (!n) { print(dim("대기 중인 민원이 없습니다.")); return; }
  print(dim(`①분류 에이전트 실행 (대기 ${n}건)…`));
  const out = await run_once(args.batch);
  print(`  ${out || "(응답 없음)"}`);
  print(dim(`  남은 대기 ${await db.pending_count()}건`));
}

async function cmd_monitor(args: Args): Promise<void> {
  const { run_once } = await import("./agents/monitor.ts");
  print(dim("②심각도·감시 에이전트 실행…"));
  print(`  ${(await run_once(args.window || config.DEFAULT_WINDOW_MIN)) || "(데이터 없음)"}`);
}

async function cmd_dispatch(args: Args): Promise<void> {
  const { pending_labels, run_for } = await import("./agents/dispatcher.ts");
  const win = args.window || config.DEFAULT_WINDOW_MIN;
  let targets = await pending_labels();
  if (args.label) targets = targets.filter((t: any) => t.label === args.label);
  if (!targets.length) { print(dim("조치요청서가 필요한 유형이 없습니다.")); return; }
  for (const t of targets.slice(0, args.limit)) {
    print(dim(`③조치 에이전트 실행 — ${config.LABELS[t.label] ?? t.label}…`));
    print(`  ${await run_for(t.label, t.score, t.grade, t.formula, win)}`);
  }
}

async function cmd_brief(args: Args): Promise<void> {
  const { run_once } = await import("./agents/supervisor.ts");
  print(dim("④통합 에이전트 실행…"));
  print(`  ${(await run_once(args.window || config.DEFAULT_WINDOW_MIN)) || "(데이터 없음)"}`);
}

async function cmd_cycle(args: Args): Promise<void> {
  // ①②③④ 한 바퀴.
  const injected = await replay.step();
  if (injected) print(dim(`리플레이 ${injected}건 투입`));
  await cmd_classify(args);
  await cmd_monitor(args);
  await cmd_dispatch(args);
  await cmd_brief(args);
}

// ── replay ────────────────────────────────────────────────────────
async function cmd_replay(args: Args): Promise<void> {
  const seed_dir = path.join(BASE_DIR, "seed");
  if (args.action === "start") {
    const p = path.join(seed_dir, args.file);
    if (!fs.existsSync(p)) {
      print(red(`시드 없음: ${p}`));
      print(dim("  node server/scripts/make_dev_seed.ts  로 생성"));
      return;
    }
    const info = await replay.start(p, { speed: args.speed });
    print(green("재생 시작") + `  ${info.total}건 · ${fixed(info.speed, 0)}배속 · 시작 ${info.sim_start}`);
  } else if (args.action === "stop") {
    await replay.stop(); print("정지");
  } else if (args.action === "step") {
    const n = await replay.step();
    print(`${n}건 투입 · 대기열 ${await db.pending_count()}건`);
  } else {
    const p = await replay.progress();
    print(p ? JSON.stringify(p) : dim("재생 기록 없음"));
  }
}

// ── db ────────────────────────────────────────────────────────────
const TABLES = ["feedback", "classification", "severity", "alert", "action_request",
  "agent_log", "briefing", "issue", "zone", "festival", "classify_cache"];

/** 두 ISO 시각의 차이(초). 없거나 해석 못 하면 null. */
function _secs(a: unknown, b: unknown): number | null {
  const ta = Date.parse(String(a)), tb = Date.parse(String(b));
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return (tb - ta) / 1000;
}

export async function show_feedback(target: unknown): Promise<void> {
  // 민원 1건의 시각·분류 상태. 접수부터 분류까지 걸린 시간을 DB 시각으로 잰다 (실사용자 검증 S2).
  const s = String(target ?? "").trim();
  const m_inbox = /^[Ww]-?(\d+)$/.exec(s);            // 접수 완료 창의 'W-38' 은 접수번호(feedback_inbox.id)
  const m_fb = /^#?(\d+)$/.exec(s);                   // '#202'·'202' 는 민원 번호(feedback.id)
  if (!(m_inbox || m_fb)) {
    print(red("사용법: node server/cli.ts db show <번호>   W-38 = 접수 완료 창의 접수번호, #202 또는 202 = 민원 번호(관제 유입)"));
    return;
  }
  const conn = await db.connect();
  let fid: number;
  if (m_inbox) {
    const ib = (await conn.execute("SELECT id, feedback_id FROM feedback_inbox WHERE id = ?", [Number(m_inbox[1])])).fetchone();
    if (!ib) { print(red(`없는 접수번호입니다: W-${m_inbox[1]}`)); return; }
    if (ib.feedback_id === null) { print(yellow(`W-${ib.id} 는 아직 접수 대기 중입니다 (워커가 가져가기 전). 잠시 뒤에 다시 보세요.`)); return; }
    if (ib.feedback_id < 0) { print(yellow(`W-${ib.id} 는 저장되지 않았습니다 (같은 내용이 이미 있거나 내용이 없는 민원).`)); return; }
    fid = ib.feedback_id;
  } else {
    fid = Number(m_fb![1]);
  }
  const row = (await conn.execute(
    `SELECT f.id, f.raw_text, f.ingested_at, f.posted_at, f.source, f.deleted_at,
            COALESCE(z.name, ?) zone, c.label, c.status, c.processed_at, c.confidence,
            c.is_safety, c.agent_note
     FROM feedback f
     LEFT JOIN zone z ON z.id = f.zone_id
     LEFT JOIN classification c ON c.feedback_id = f.id
     WHERE f.id = ?`, [config.ZONE_UNKNOWN, fid])).fetchone();
  const inbox = (await conn.execute("SELECT id, created_at FROM feedback_inbox WHERE feedback_id = ?", [fid])).fetchone();
  if (!row) { print(red(`없는 민원입니다: ${fid}`)); return; }
  // 두 번호를 같이 보여 준다: W-번호(방문객이 본 접수번호) · #번호(관제 유입의 민원 번호)
  rule(inbox ? `W-${inbox.id} · 민원 #${fid}` : `민원 #${fid}`);
  print(`  내용        ${row.raw_text}`);
  print(`  구역        ${row.zone}    출처 ${row.source}` + (row.deleted_at ? "    " + red("지움(숨김)") : ""));
  if (inbox) print(`  접수함 시각 ${inbox.created_at}    (방문객이 제출한 시각)`);
  print(`  접수 시각   ${row.ingested_at}    (워커가 마스킹해서 feedback 에 넣은 시각)`);
  print(`  분류 시각   ${row.processed_at || "-"}`);
  const label = row.label ? (config.LABELS[row.label] ?? row.label) : "-";
  print(`  유형·상태   ${label} · ${row.status}` + (row.confidence !== null && row.confidence !== undefined ? `  (신뢰도 ${row.confidence})` : ""));
  const d_ing = _secs(row.ingested_at, row.processed_at);
  const d_inbox = inbox ? _secs(inbox.created_at, row.processed_at) : null;
  print(`  접수→분류   ${d_ing === null ? "-" : `${fixed(d_ing, 0)}초`}`);
  if (d_inbox !== null) print(`  제출→분류   ${fixed(d_inbox, 0)}초    ← 방문객이 체감하는 반영 시간 (웹 접수만)`);
  if (row.status === "review" && row.agent_note) print(`  확인 필요   ${row.agent_note}`);
  print();
}

/** 한 줄 입력을 받는다 (stdin 이 끝났으면 빈 문자열). */
async function ask(prompt: string): Promise<string> {
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } catch {
    return "";
  } finally {
    rl.close();
  }
}

/** db restore <파일> — 지금 연결된 DB 의 백업 대상 테이블을 파일 내용으로 바꾼다. 운영 Supabase 는 --live-db 와 확인 문구가 있어야 한다. */
export async function cmd_db_restore(args: Args): Promise<void> {
  const dbbackup = await import("./core/dbbackup.ts");
  if (!args.target) { print(red("사용법: node server/cli.ts db restore <백업파일.json> [--live-db] [--yes]")); return; }
  const file = path.resolve(String(args.target));
  if (!fs.existsSync(file)) { print(red(`파일이 없습니다: ${file}`)); return; }
  const live = db.is_pg();
  if (live && !args["live-db"]) {
    print(red("운영 Supabase 가 연결돼 있습니다. 운영 DB 를 바꾸려면 --live-db 를 붙이세요."));
    print(dim("  테스트는 SUPABASE_DB_URL= (빈 값) 과 DB_PATH=<임시.db> 로 임시 SQLite 에 하세요."));
    return;
  }
  let bf;
  try { bf = dbbackup.read_backup(file); } catch (e) { print(red((e as Error).message)); return; }

  if (!live) {
    const tourapi = await import("./core/tourapi.ts");
    await tourapi.ensure_cache();           // festival_info 는 첫 호출 때 만들어진다
  }
  const target = live ? yellow("운영 Supabase") : `SQLite ${path.basename(config.DB_PATH)}`;
  const now = await dbbackup.current_counts();
  const want = dbbackup.summarize(bf);
  rule("복원 미리보기");
  print(`  파일   ${path.basename(file)}  (만든 시각 ${bf.created_at}, 원본 ${bf.source})`);
  print(`  대상   ${target}`);
  print(dim(`  ${ljust("테이블", 18)}${rjust("지금", 7)}${rjust("복원 후", 9)}`));
  for (const tb of dbbackup.BACKUP_TABLES) {
    if (!(tb in want)) continue;
    print(`  ${ljust(tb, 18)}${rjust(now[tb] ?? "-", 7)}${rjust(want[tb], 9)}`);
  }
  print(yellow("  위 테이블의 지금 내용은 전부 지워지고 파일 내용으로 바뀝니다. (operator_secret 은 건드리지 않습니다)"));
  print(dim("  복원 전에 워커·웹 서버를 멈추는 것이 안전합니다 (run_all_servers 를 끄세요)."));

  if (!(args.yes && !live)) {           // --yes 는 운영이 아닐 때만 통한다
    const word = live ? "운영복원" : "복원";
    const ans = await (args._ask ?? ask)(`\n계속하려면 '${word}' 를 입력하세요: `);
    if (ans !== word) { print("취소했습니다. 아무것도 바꾸지 않았습니다."); return; }
  }
  if (live) {
    const snap = dbbackup.write_backup(await dbbackup.snapshot_supabase(), dbbackup.BEFORE_RESTORE_PREFIX);
    print(dim(`  복원 직전 상태를 저장했습니다: ${path.basename(snap)}`));
  }
  const done = await dbbackup.restore(bf);
  print(green(`복원했습니다 — ${Object.keys(done).length}개 테이블, ${sumValues(done)}행`));
}

async function cmd_db(args: Args): Promise<void> {
  if (args.what === "restore") { await cmd_db_restore(args); return; }
  const conn = await db.connect();
  if (args.what === "tables") {
    rule("테이블");
    for (const t of TABLES) {
      try {
        const n = (await conn.execute(`SELECT COUNT(*) c FROM ${t}`)).fetchone()!.c;
        print(`  ${ljust(t, 20)}${rjust(n, 7)}행`);
      } catch {
        print(dim(`  ${ljust(t, 20)}      -`));
      }
    }
    print();
  } else if (args.what === "log") {
    rule(`에이전트 활동 로그 (최근 ${args.limit})`);
    for (const g of [...(await db.recent_logs(args.limit))].reverse()) {
      const lat = g.latency_ms ? `${g.latency_ms}ms` : "";
      print(`  ${dim(String(g.created_at).slice(11, 19))} ${ljust(cyan(g.agent), _COLOR ? 18 + 9 : 18)} ${ljust(g.action, 22)} ${dim(lat)}`);
      if (g.output_summary) print(dim(`      → ${String(g.output_summary).slice(0, 90)}`));
    }
    print();
  } else if (args.what === "feed") {
    rule(`최근 민원 (최근 ${args.limit})`);
    for (const f of await db.recent_feedback(args.limit)) {
      const label = f.label ? (config.LABELS[f.label] ?? "분류중") : "분류중";
      print(`  #${ljust(f.id, 4)} ${dim(String(f.ingested_at).slice(11, 19))} ${ljust(bold(label), _COLOR ? 12 + 8 : 12)} ${ljust(f.zone || config.ZONE_UNKNOWN, 16)} ${String(f.raw_text).slice(0, 40)}`);
    }
    print();
  } else if (args.what === "show") {
    await show_feedback(args.target);
  } else {  // dump
    if (!TABLES.includes(args.what)) {
      print(red(`모르는 테이블: ${args.what}`));
      print(dim("  " + TABLES.join(" / ")));
      return;
    }
    rule(args.what);
    const rows = (await conn.execute(`SELECT * FROM ${args.what} ORDER BY rowid DESC LIMIT ?`, [args.limit])).fetchall();
    if (!rows.length) { print(dim("  (비어 있음)")); return; }
    const cols = Object.keys(rows[0]);
    print("  " + dim(cols.join(" | ")));
    for (const r of [...rows].reverse()) print("  " + cols.map((k) => String(r[k]).slice(0, 28)).join(" | "));
    print();
  }
}

// ── reset ─────────────────────────────────────────────────────────
async function cmd_reset(args: Args): Promise<void> {
  const conn = await db.connect();
  if (args.all) {
    for (const t of ["feedback", "classification", "severity", "alert", "action_request", "agent_log", "briefing", "issue", "classify_cache"]) {
      await conn.execute(`DELETE FROM ${t}`);
    }
    await conn.execute("DELETE FROM replay_state");
    print("전체 초기화 완료 (구역·축제 설정은 유지)");
  } else {
    await conn.execute("DELETE FROM severity");
    await conn.execute("DELETE FROM alert");
    await conn.execute("DELETE FROM briefing");
    await conn.execute("UPDATE classification SET status='pending', label=NULL, sentiment=NULL, is_safety=NULL, confidence=NULL");
    print(`판정 초기화 완료 · 대기열 ${await db.pending_count()}건`);
  }
  await conn.commit();
}

// ── demo ──────────────────────────────────────────────────────────
/** 시드 CSV가 몇 분치인지. 창 기본값을 데이터에 맞추는 데 쓴다. */
function _seed_span_minutes(p: string): number {
  const text = fs.readFileSync(p, "utf-8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = parseCsvLine(lines[0]);
  const idx = head.indexOf("posted_at");
  const ts = lines.slice(1).map((l) => parseCsvLine(l)[idx]).filter(Boolean);
  if (ts.length < 2) return config.DEFAULT_WINDOW_MIN;
  const ms = ts.map((t) => Date.parse(t));
  const lo = Math.min(...ms), hi = Math.max(...ms);
  return Math.max(config.DEFAULT_WINDOW_MIN, Math.floor((hi - lo) / 1000 / 60) + 60);
}
function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function cmd_demo(args: Args): Promise<void> {
  // E2E 한 번에 — 시드 투입 → 분류 → 판정 → 조치 → 브리핑.
  const seed = path.join(BASE_DIR, "seed", args.file);
  if (!fs.existsSync(seed)) {
    print(red(`시드 없음: ${seed}`));
    print(dim("  node server/scripts/make_dev_seed.ts  로 생성"));
    return;
  }

  print(bold("\n[1/5] 시드 투입"));
  await replay.start(seed, { speed: 1_000_000 });          // 전량 즉시 도달
  let total = 0;
  for (let n = await replay.step(80); n; n = await replay.step(80)) total += n;
  print(`  ${total}건 투입 · 대기열 ${await db.pending_count()}건`);

  print(bold("\n[2/5] 분류"));
  {
    const { run_once } = await import("./agents/classifier.ts");
    while (await db.pending_count()) {
      const out = await run_once(20);
      print(`  ${out ? out.slice(0, 100) : ""}`);
    }
  }

  print(bold("\n[3/5] 심각도 판정"));
  const span = _seed_span_minutes(seed);
  const win = args.window || span;
  print(dim(`  시드가 ${Math.floor(Math.floor(span / 60) / 24)}일치라 창을 ${win}분으로 잡습니다 (실운영 기본값은 ${config.DEFAULT_WINDOW_MIN}분)`));
  const [ranked] = await ranked_now(win);
  for (const r of ranked.slice(0, 5)) {
    const col = GRADE_COLOR[r.grade] ?? ident;
    print(col(`  ${ljust(config.LABELS[r.label] ?? r.label, 10)}${rjust(num(r.score), 6)}  ${ljust(r.grade, 10)}${rjust(r.freq, 4)}건`));
  }
  if (ranked.length) {
    const counts = await db.label_counts(win);
    const top_count = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a));
    if (top_count !== ranked[0].label) {
      print(green(`\n  ★ 역전: 건수 1위는 ${config.LABELS[top_count]}(${counts[top_count]}건)이지만, 심각도 1위는 ${config.LABELS[ranked[0].label]}(${ranked[0].freq}건)`));
      print(dim(`    ${ranked[0].formula}`));
    }
  }

  print(bold("\n[4/5] 조치요청서"));
  await cmd_dispatch({ label: null, limit: 1 });

  print(bold("\n[5/5] 통합 브리핑"));
  await cmd_brief(args);
  print(dim("\n완료.  node server/cli.ts status  로 확인"));
}

// ── watch ─────────────────────────────────────────────────────────
const BAR = "█";

function _bar(n: number, top: number, width = 18): string {
  if (top <= 0) return "";
  return n ? BAR.repeat(Math.max(1, pyRound((n / top) * width))) : "";
}
/** Python round() — 짝수 반올림 */
function pyRound(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

async function _frame(win: number, drive: boolean): Promise<string> {
  // 한 프레임을 문자열로 만든다. watch 와 스냅샷이 같은 것을 쓴다.
  const out: string[] = [];
  const A = (s: string) => out.push(s);
  if (drive) {
    await replay.step();
    if (await db.pending_count()) {
      const { run_once } = await import("./agents/classifier.ts");
      await run_once(30);
    }
  }

  const counts = await db.label_counts(win);
  const ranked = (await ranked_now(win))[0];
  const pending = await db.pending_count();
  const prog = await replay.progress();

  const conn = await db.connect();
  const fest = (await conn.execute("SELECT name FROM festival LIMIT 1")).fetchone();
  const brief = (await conn.execute("SELECT * FROM briefing ORDER BY id DESC LIMIT 1")).fetchone();
  const alerts = (await conn.execute("SELECT * FROM alert ORDER BY id DESC LIMIT 3")).fetchall();

  A(`${bold(fest ? fest.name : "축제")}  ${dim(hhmmss(new Date()))}  ${(await _backend_line()).trim()}`);

  let line = `  분류완료 ${rjust(sumValues(counts), 4)}  대기 ${rjust(pending, 4)}`;
  const reviewN = await db.review_count();
  if (reviewN) {
    line += `  확인필요 ${rjust(reviewN, 3)}`;     // 신뢰도 낮아 유형 미정 — 순위·알림 제외
    const rs = await db.review_safety_count();
    if (rs) line += ` (안전의심 ${rs})`;
  }
  if (prog && prog.total) {
    const pct = prog.cursor / prog.total;
    const state = prog.active ? "재생중" : "정지";
    line += `   재생 [${ljust(BAR.repeat(pyRound(pct * 20)), 20)}] ${prog.cursor}/${prog.total} ${state}`;
    if (prog.active) line += `  시뮬 ${prog.sim_now}`;
  }
  A(dim(line));
  A("");

  const cvals = Object.values(counts);
  const top_c = cvals.length ? Math.max(...cvals) : 0;
  const top_s = ranked.length ? Math.max(...ranked.map((r) => r.score)) : 0;
  A(`  ${ljust("건수 순위", 26)}심각도 순위`);
  A(dim("  " + "─".repeat(62)));
  const cl = Object.entries(counts);
  for (let i = 0; i < Math.max(cl.length, ranked.length, 1); i++) {
    let left = "", right = "";
    if (i < cl.length) {
      const [k, v] = cl[i];
      left = `${ljust(config.LABELS[k] ?? k, 9)}${rjust(v, 4)} ${_bar(v, top_c, 10)}`;
    }
    if (i < ranked.length) {
      const r = ranked[i];
      const col = GRADE_COLOR[r.grade] ?? ident;
      right = col(`${GRADE_MARK[r.grade]}${ljust(config.LABELS[r.label] ?? r.label, 9)}${rjust(num(r.score), 6)} ${_bar(Math.trunc(r.score), Math.trunc(top_s), 10)}`);
    }
    A(`  ${ljust(left, 26)}${right}`);
  }

  if (ranked.length && cl.length && ranked[0].label !== cl[0][0]) {
    A("");
    A(green(`  ★ 역전  건수 1위 ${config.LABELS[cl[0][0]]}(${cl[0][1]}건) → 심각도 1위 ${config.LABELS[ranked[0].label]}(${ranked[0].freq}건)`));
    A(dim(`    ${ranked[0].formula}`));
  }

  if (alerts.length) {
    A("");
    A(bold("  알림"));
    const kind: Record<string, string> = { spike: "급증", safety_threshold: "안전 임계", grade_up: "등급 상승" };
    for (const a of alerts) {
      A(`  ${red("▲")} ${kind[a.kind] ?? a.kind} ${config.LABELS[a.label] ?? a.label} ${dim(String(a.created_at).slice(11, 19))}`);
    }
  }

  if (brief) {
    A("");
    A(bold("  통합 브리핑") + dim(`  ${String(brief.created_at).slice(11, 19)}`));
    const text: string = brief.text;
    for (let i = 0; i < text.length; i += 60) A(`  ${cyan(text.slice(i, i + 60))}`);
  }

  A("");
  A(bold("  에이전트 활동"));
  for (const g of [...(await db.recent_logs(6))].reverse()) {
    const lat = g.latency_ms ? `${g.latency_ms}ms` : "";
    A(`  ${dim(String(g.created_at).slice(11, 19))} ${ljust(cyan(g.agent), _COLOR ? 18 + 9 : 18)}${ljust(g.action, 22)}${dim(lat)}`);
  }
  return out.join("\n");
}

async function cmd_watch(args: Args): Promise<void> {
  // 실시간 모니터. 화면을 지우고 다시 그린다.
  const win = args.window || config.DEFAULT_WINDOW_MIN;
  if (args.once) { print(await _frame(win, args.drive)); return; }

  print(dim("Ctrl+C 로 종료"));
  process.on("SIGINT", () => { print("\n종료"); process.exit(0); });
  for (;;) {
    const frame = await _frame(win, args.drive);
    // 커서를 원점으로 옮기고 화면을 지운다 (깜빡임 없이 다시 그리기)
    process.stdout.write("\x1b[H\x1b[J");
    process.stdout.write(frame + "\n");
    await sleep(args.interval * 1000);
  }
}

// ── todo ──────────────────────────────────────────────────────────
const _time = () => hhmmss(new Date());

async function cmd_todo(args: Args): Promise<void> {
  // 할 일 목록을 시스템 상태에서 다시 판정해 그린다.
  const todo = await import("./core/todo.ts");
  if (args.show) { print(await todo.render()); return; }

  const once = async () => {
    const [done, total, changed] = await todo.refresh();
    const mark = changed ? green("갱신") : dim("변경 없음");
    const pct = total ? pyRound((done / total) * 100) : 0;
    print(`  ${mark}  진행 ${done}/${total} (${pct}%)  ${dim(String(todo.TODO_PATH))}`);
  };
  if (!args.watch) { await once(); return; }

  const mtime = () => (fs.existsSync(todo.TODO_PATH) ? fs.statSync(todo.TODO_PATH).mtimeMs : 0);
  print(dim(`${todo.TODO_PATH} 감시 중 · Ctrl+C 로 종료`));
  await once();
  let last = mtime();
  process.on("SIGINT", () => { print("\n종료"); process.exit(0); });
  for (;;) {
    await sleep(args.interval * 1000);
    const now = mtime();
    if (now !== last) {                      // 사람이 고쳤다
      print(dim(`  ${_time()} 파일 변경 감지`));
      await once();
      last = mtime();
    } else {                                 // 시스템 상태가 바뀌었을 수 있다
      const [done, total, changed] = await todo.refresh();
      if (changed) { print(`  ${_time()} ${green("상태 변화 반영")}  진행 ${done}/${total}`); last = mtime(); }
    }
  }
}

// ── main ──────────────────────────────────────────────────────────
// 명령별 옵션 (argparse 의 서브파서와 같은 이름·기본값). 전역 --window 는 명령 앞에 둔다.
type OptSpec = Record<string, { type: "string" | "boolean"; default?: string | boolean }>;
const COMMANDS: Record<string, { help: string; options: OptSpec; positionals?: string[]; run: (a: Args) => Promise<void> }> = {
  status: { help: "현재 상태", options: {}, run: cmd_status },
  check: { help: "API 키 확인 (최소 비용)", options: {}, run: cmd_check },
  todo: { help: "할 일 목록 자동 갱신", options: { watch: { type: "boolean" }, show: { type: "boolean" }, interval: { type: "string", default: "2.0" } }, run: cmd_todo },
  watch: { help: "실시간 모니터", options: { interval: { type: "string", default: "2.0" }, drive: { type: "boolean" }, once: { type: "boolean" } }, run: cmd_watch },
  submit: { help: "민원 접수", options: { zone: { type: "string" } }, positionals: ["text"], run: cmd_submit },
  classify: { help: "①분류 에이전트", options: { batch: { type: "string", default: "20" } }, run: cmd_classify },
  monitor: { help: "②심각도·감시 에이전트", options: {}, run: cmd_monitor },
  dispatch: { help: "③조치 에이전트", options: { label: { type: "string" }, limit: { type: "string", default: "1" } }, run: cmd_dispatch },
  brief: { help: "④통합 에이전트", options: {}, run: cmd_brief },
  cycle: { help: "①②③④ 한 바퀴", options: { batch: { type: "string", default: "20" }, label: { type: "string" }, limit: { type: "string", default: "1" } }, run: cmd_cycle },
  replay: { help: "리플레이 제어", options: { file: { type: "string", default: "dev_sample.csv" }, speed: { type: "string", default: "60.0" } }, positionals: ["action"], run: cmd_replay },
  db: { help: "DB 조회", options: { limit: { type: "string", default: "20" }, "live-db": { type: "boolean" }, yes: { type: "boolean" } }, positionals: ["what?", "target?"], run: cmd_db },
  reset: { help: "초기화", options: { all: { type: "boolean" } }, run: cmd_reset },
  demo: { help: "E2E 자동 실행", options: { file: { type: "string", default: "dev_sample.csv" }, window: { type: "string" }, batch: { type: "string", default: "20" }, label: { type: "string" }, limit: { type: "string", default: "1" } }, run: cmd_demo },
};
const NUMERIC = new Set(["interval", "batch", "limit", "speed", "window"]);

function usage(): void {
  console.error("사용: node server/cli.ts [--window 분] <명령> [옵션]\n");
  for (const [k, v] of Object.entries(COMMANDS)) console.error(`  ${ljust(k, 10)}${v.help}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let window: number | undefined;
  let i = 0;
  while (i < argv.length && argv[i].startsWith("--")) {
    if (argv[i] === "--window") { window = Number(argv[i + 1]); i += 2; } else break;
  }
  const cmdName = argv[i];
  const spec = COMMANDS[cmdName];
  if (!spec) { usage(); process.exit(2); }
  const { values, positionals } = parseArgs({ args: argv.slice(i + 1), options: spec.options as any, allowPositionals: true });
  const args: Args = { window };
  for (const [k, sv] of Object.entries(spec.options)) {
    let v: any = (values as Args)[k] ?? sv.default;
    if (v !== undefined && NUMERIC.has(k) && sv.type === "string") v = Number(v);
    if (v === undefined && sv.type === "boolean") v = false;
    if (v === undefined) v = null;
    args[k === "window" ? "window" : k] = k === "window" && v === null ? window : v;   // demo 의 --window 는 명령 뒤에 온 것이 우선
  }
  (spec.positionals ?? []).forEach((name, n) => {
    const key = name.replace("?", "");
    const val = positionals[n];
    if (val === undefined && !name.endsWith("?")) { usage(); console.error(`\n필요한 값: ${key}`); process.exit(2); }
    args[key] = val ?? (key === "what" ? "tables" : null);
  });
  if (cmdName === "replay" && !["start", "stop", "step", "status"].includes(args.action)) { usage(); console.error("\naction 은 start | stop | step | status"); process.exit(2); }

  // 운영 DB 복원은 init_db·replay.ensure 의 시드 쓰기도 하지 않는다 (복원이 바꾸기 전에 운영 DB 에 아무것도 쓰지 않는다)
  const skip_init = cmdName === "db" && args.what === "restore" && db.is_pg();
  if (!skip_init) {
    await db.init_db();
    await replay.ensure();
  }
  await spec.run(args);
  await db.close_all();
}

// 직접 실행할 때만 돈다 (import 만 하면 돌지 않는다 — 시험이 함수만 가져다 쓴다)
if (import.meta.main) {
  process.on("SIGINT", () => { console.log("\n중단"); process.exit(0); });
  main().catch((e) => { console.error(e); process.exit(1); });
}
