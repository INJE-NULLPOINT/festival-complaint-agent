// 할 일 목록을 시스템 상태에서 자동 갱신한다. (이 파일이 기준본)
//
// 두 종류의 항목이 있다.
//
//   auto    시스템을 직접 들여다보고 판정한다. 파일 존재, DB 기록, 환경변수 등.
//           사람이 체크를 바꿔도 다음 갱신 때 증거대로 되돌아간다.
//   manual  사람이 직접 체크한다. 갱신해도 체크 상태와 메모가 보존된다.
//
// worker.ts 가 Agent Path 를 한 바퀴 돌 때마다 이 파일을 다시 그린다.
// `node server/cli.ts todo` (다시 그리기) · `node server/cli.ts todo --watch` 로 파일을 편집하는 즉시 반영되게 볼 수도 있다.
//
// 고치는 법 (이 파일 안의 목록만 고치면 된다)
//   · 끝난 항목을 진행현황.md 로 옮길 때:   node server/core/todo.ts --archive D5-54 [D5-55 …]   (ARCHIVED 에 id 를 덧붙인다)
//   · 키·사람만 남은 항목:                    WAITING 에 "id": "이유" 한 줄
//   · 새 항목:                                TASKS 에 { id, title, phase, check?, note? } — check 는 아래 CHK 에 id 로 함수를 단다
//   · 결과만 미리 보기(파일 안 씀):           node server/core/todo.ts [--path <파일>]
//
// 구현 메모
//   - DB 를 읽는 판정이 있어 render·refresh 는 async 이다.
//   - 텍스트 파일 줄바꿈: 읽을 때 \r\n→\n, 쓸 때 \n→os.linesep(Windows 는 \r\n) 로 맞췄다(readText/writeText).
//   - render 에 선택 인자 opts.saveState(기본 true)가 있다. false 면 .todo_state.json 을 쓰지 않는다(미리 보기용).
import { existsSync, readFileSync, statSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, BASE_DIR } from "./config.ts";
import * as db from "./db.ts";
import { dict_reader } from "./csv.ts";
import { fixed, round } from "./pyfmt.ts";

export const ROOT = BASE_DIR;                                   // festival_agent/
export const PROJECT = path.dirname(ROOT);                      // "ai 대회" 폴더
export const TODO_PATH = path.join(PROJECT, "할일.md");
export const STATE_PATH = path.join(ROOT, ".todo_state.json");  // 최초 달성 시각. DB 초기화에도 남는다

const DONE_RE = /^- \[(x| )\]\s+`([A-Z0-9\-]+)`\s+(.*)$/;

type Check = () => Promise<[boolean, string]> | [boolean, string];

export interface Task {
  id: string;
  title: string;
  phase: string;
  check?: Check;          // (완료여부, 증거)
  note?: string;
}
const is_auto = (t: Task): boolean => t.check !== undefined;

// ── 텍스트 파일 입출력 (줄바꿈 처리) ──────────────────────────
const IS_WIN = process.platform === "win32";
/** Path.read_text(encoding="utf-8") — 줄바꿈을 \n 으로 (universal newlines) */
const readText = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n?/g, "\n");
/** Path.write_text(text, encoding="utf-8") — \n 을 os.linesep 으로 (Windows 는 \r\n) */
const writeText = (p: string, text: string): void => writeFileSync(p, IS_WIN ? text.replace(/\n/g, "\r\n") : text, "utf-8");
const isFile = (p: string): boolean => existsSync(p);
/** 경로 비교 (Windows 는 대소문자 무시 — pathlib.PureWindowsPath 와 같게) */
const samePath = (a: string, b: string): boolean => {
  const x = path.resolve(a), y = path.resolve(b);
  return IS_WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const count = (s: string, sub: string): number => s.split(sub).length - 1;

// ── 판정 함수들 ───────────────────────────────────────────────────

export function _env_has(key: string): [boolean, string] {
  if (process.env[key]) return [true, "환경변수 설정됨"];
  const envf = path.join(ROOT, ".env");
  // \s 는 줄바꿈까지 먹어서 빈 값 다음 줄의 주석을 값으로 오인했다 — 같은 줄의 공백만 허용
  if (isFile(envf) && new RegExp(`^${key}[ \\t]*=[ \\t]*[^\\s#]`, "m").test(readText(envf))) return [true, ".env 에 설정됨"];
  return [false, "미설정"];
}

export function _file(p: string, label = ""): [boolean, string] {
  if (isFile(p)) {
    const kb = statSync(p).size / 1024;
    return [true, `${label || path.basename(p)} (${fixed(kb, 1)}KB)`];
  }
  return [false, `${path.basename(p)} 없음`];
}

/** 실제 모델로 에이전트가 돈 흔적이 있는가.
 *  실제 API 를 부를 때마다 llm 이 action='api_call' 행을 남긴다. local 대역·캐시 적중은 이 행을 남기지 않는다. */
export async function _anthropic_ran(): Promise<[boolean, string]> {
  const conn = await db.connect();
  const row = (await conn.execute(
    `SELECT COUNT(*) c FROM agent_log
               WHERE action='api_call'
                 AND agent IN ('classifier','monitor','dispatcher','supervisor')`,
  )).fetchone()!;
  const n = Number(row.c);
  return [n > 0, n ? `실제 모델 API 호출 ${n}회` : "local 대역 기록만 있음"];
}

export function _accuracy_measured(): [boolean, string] {
  const p = path.join(ROOT, "tests", "accuracy_report.md");
  if (!isFile(p)) return [false, "accuracy_report.md 없음"];
  const text = readText(p);
  let m = /^## anthropic\s*$[\s\S]*?\*\*정확도 ([\d.]+%)/m.exec(text);
  if (m) return [true, `실제 모델 정확도 ${m[1]}`];
  m = /\*\*정확도 ([\d.]+%)/.exec(text);
  return [false, `local 대역만 측정됨 (${m ? m[1] : "?"}) — --backend anthropic 필요`];
}

export function _scenarios_live(): [boolean, string] {
  const p = path.join(ROOT, "tests", "testcase_report.md");
  if (!isFile(p)) return [false, "리포트 없음"];
  const t = readText(p);
  const live = t.includes("--live") && t.includes("실제 LLM 호출");
  const b = /^- 백엔드: (\S+)/m.exec(t);
  const be = b ? b[1] : "?";
  const passed = /\*\*(\d+)\/(\d+) 통과\*\*/.exec(t);
  const score = passed ? `${passed[1]}/${passed[2]} 통과` : "결과 미상";
  if (!live) return [false, `구조 검증 모드 ${score}`];
  // 제출 검증은 API(anthropic) 만 인정. claude_code 는 참고값.
  if (be !== "anthropic") return [false, `live ${score} (백엔드 ${be} — 참고값, anthropic 필요)`];
  return [true, `live 모드 ${score}`];
}

/** 〔 〕 빈칸이 남아 있는지. */
export function _blanks(p: string, label: string): [boolean, string] {
  if (!isFile(p)) return [false, `${label} 없음`];
  const n = count(readText(p), "〔");
  return [n === 0, n === 0 ? "빈칸 없음" : `빈칸 ${n}곳 남음`];
}

export const REAL_SEED_MIN = 100;

/** 실제 수집 시드: seed/ 의 CSV 중 출처 URL 이 채워진 행이 100개 이상인 파일.
 *  CSV 가 있기만 하면 통과로 보면 빈 템플릿·합성 파일에도 체크가 붙는다.
 *  템플릿은 scripts/templates/. */
export function _real_seed(): [boolean, string] {
  let best: [string, number] = ["", -1];
  const seedDir = path.join(ROOT, "seed");
  const csvs = existsSync(seedDir)
    ? readdirSync(seedDir).filter((n) => (IS_WIN ? /\.csv$/i : /\.csv$/).test(n))
        // sorted(Path) — Windows 는 대소문자를 무시하고 비교한다
        .sort((a, b) => { const x = IS_WIN ? a.toLowerCase() : a, y = IS_WIN ? b.toLowerCase() : b; return x < y ? -1 : x > y ? 1 : 0; })
    : [];
  for (const name of csvs) {
    if (name === "dev_sample.csv") continue;
    const n = dict_reader(path.join(seedDir, name)).filter((r) => (r.text || "").trim() && (r.source_url || "").trim()).length;
    if (n > best[1]) best = [name, n];
  }
  if (best[1] >= REAL_SEED_MIN) return [true, `실제 시드 ${best[0]} (출처 있는 행 ${best[1]})`];
  if (best[0]) return [false, `${best[0]} 출처 있는 행 ${best[1]}/${REAL_SEED_MIN}`];
  return [false, "dev_sample.csv(합성) 만 있음"];
}

// llm.ts 는 필요할 때 불러온다 (이 판정을 쓰는 곳에서만 로드)
async function _llm_backend(): Promise<string> {
  const llm = await import("./llm.ts") as { backend: () => string };
  return llm.backend();
}

export async function _backend_is_anthropic(): Promise<[boolean, string]> {
  const b = await _llm_backend();
  return [b === "anthropic", `현재 백엔드 ${b}`];
}

/** 접수→분류→심각도→조치→브리핑이 실제로 한 번 관통했는가. */
export async function _e2e_done(): Promise<[boolean, string]> {
  const conn = await db.connect();
  const one = async (sql: string): Promise<number> => Number((await conn.execute(sql)).fetchone()!.c);
  const cls = await one("SELECT COUNT(*) c FROM classification WHERE status='done'");
  const sev = await one("SELECT COUNT(*) c FROM severity");
  const act = await one("SELECT COUNT(*) c FROM action_request");
  const brf = await one("SELECT COUNT(*) c FROM briefing");
  const ok = cls && sev && act && brf;
  return [!!ok, `분류 ${cls} · 심각도 ${sev} · 조치 ${act} · 브리핑 ${brf}`];
}

/** 웹 '조치요청서 생성' 버튼 요청이 워커를 거쳐 미리보기까지 만들어졌는가. */
export async function _web_doc_done(): Promise<[boolean, string]> {
  let n: number;
  try {
    const conn = await db.connect();
    n = Number((await conn.execute(
      `SELECT COUNT(*) c FROM doc_job j JOIN action_request a
                   ON a.id = j.action_request_id
                   WHERE j.status='done' AND a.doc_json IS NOT NULL`,
    )).fetchone()!.c);
  } catch {
    return [false, "doc_job 테이블 없음 (node server/worker.ts 한 번 실행)"];
  }
  return [n > 0, n ? `웹 요청 조치요청서 ${n}건` : "웹 요청 이력 없음"];
}

export function _web_env_has(...keys: string[]): boolean {
  const envf = path.join(ROOT, "web", ".env");
  const text = isFile(envf) ? readText(envf) : "";
  return keys.every((k) => new RegExp(`^${k}\\s*=\\s*\\S`, "m").test(text));
}

/** 워커(.env)와 웹(web/.env) 둘 다 Supabase 를 가리키는가.
 *  webapi.ts 는 지우지 않는다. 키가 있으면 웹이 알아서 Supabase 로 붙고 local 대역은 쓰이지 않는다 (web/src/data.ts). */
export function _supabase_linked(): [boolean, string] {
  const worker = _env_has("SUPABASE_DB_URL")[0];
  const web = _web_env_has("VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY");
  const ok = worker && web;
  return [ok, `워커 ${worker ? "Supabase" : "SQLite"} · 웹 ${web ? "Supabase" : "local 대역"}`];
}

/** Supabase 키가 연결돼 local 대역이 비활성인가. */
export function _stand_in_removed(): [boolean, string] {
  const [ok, ev] = _supabase_linked();
  return [ok, (ok ? "local 대역 비활성 · " : "") + ev];
}

/** 제출본에 local 대역이 쓰이지 않는가 (LLM · 웹 둘 다). */
export async function _no_stand_in(): Promise<[boolean, string]> {
  const b = await _llm_backend();
  const [linked, ev] = _supabase_linked();
  return [b === "anthropic" && linked, `LLM ${b} · ${ev}`];
}

export function _user_validation(): [boolean, string] {
  return _blanks(path.join(PROJECT, "제출_준비", "실사용자_검증_확인서.md"), "확인서");
}

export function _submission_file(name: string): Check {
  return () => _file(path.join(PROJECT, "제출_준비", name));
}

// ── 항목 정의 ─────────────────────────────────────────────────────
// 항목 뒤의 check 는 아래 CHK 에서 id 로 찾는다.
const sub = (...p: string[]): string => path.join(...p);
const CHK: Record<string, Check> = {
  "D5-1": () => _env_has("ANTHROPIC_API_KEY"),
  "D5-2": _anthropic_ran,
  "D5-5": () => _env_has("TOURAPI_KEY"),
  "D5-6": () => _env_has("SUPABASE_DB_URL"),
  "D5-7": () => _file(sub(ROOT, "web", "src", "main.ts")),
  "D5-8": _web_doc_done,
  "D5-9": _stand_in_removed,
  "D6-1": _scenarios_live,
  "D6-2": () => _file(sub(ROOT, "server", "scripts", "measure_accuracy.ts")),
  "D6-3": _accuracy_measured,
  "D6-4": _user_validation,
  "D6-5": () => _file(sub(PROJECT, "제출_준비", "원가측정.md")),
  "D6-6": _real_seed,
  "D7-1": () => _file(sub(PROJECT, "제출_준비", "시연영상.mp4")),
  "D7-2": _submission_file("개발완료보고서.md"),
  "D7-3": _submission_file("기술설명서.md"),
  "D7-4": _submission_file("발표자료.md"),
  "D7-5": () => _blanks(sub(PROJECT, "제출_준비", "비즈니스모델.md"), "비즈니스모델"),
  "D7-6": _submission_file("출처신고서.md"),
  "D8-2": _backend_is_anthropic,
  "D8-5": _no_stand_in,
  "E2E": _e2e_done,
};

export const TASKS: Task[] = [
  { id: "D5-1", title: "`.env` 에 ANTHROPIC_API_KEY 설정", phase: "D5 오류수정·안정화", check: CHK["D5-1"] },
  { id: "D5-2", title: "실제 모델로 에이전트 한 바퀴 (`node server/cli.ts cycle`)", phase: "D5 오류수정·안정화", check: CHK["D5-2"], note: "지금까지 검증은 전부 규칙 기반 대역입니다. 제출본은 실제 모델이어야 합니다." },
  { id: "D5-3", title: "역할 프롬프트 4종 튜닝 (실제 출력 보고 조정)", phase: "D5 오류수정·안정화" },
  { id: "D5-4", title: "Streamlit 제거 — 화면은 웹 하나로 (사용자 결정 10/1)", phase: "D5 오류수정·안정화" },
  { id: "D5-5", title: "TourAPI 키 발급 (Tool 4점 보강)", phase: "D5 오류수정·안정화", check: CHK["D5-5"], note: "없어도 동작하지만 외부 API 연동 근거가 약해집니다." },
  { id: "D5-6", title: "Supabase 이전 (SQLite→Postgres)", phase: "D5 오류수정·안정화", check: CHK["D5-6"], note: "없으면 local 대역(SQLite + webapi.ts)으로 동작합니다. 전환 절차는 README '웹 앱' 절." },
  { id: "D5-7", title: "웹 앱 기초 UI (TS 단일 페이지: 접수·관제·조치)", phase: "D5 오류수정·안정화", check: CHK["D5-7"] },
  { id: "D5-8", title: "웹에서 심각도 기반 조치요청서 생성·미리보기 확인", phase: "D5 오류수정·안정화", check: CHK["D5-8"], note: "실시간 용도라 화면은 단순하게 유지합니다." },
  { id: "D5-9", title: "Supabase 키 연결 시 local 대역 비활성", phase: "D5 오류수정·안정화", check: CHK["D5-9"], note: "web/.env 에 URL·anon 키를 넣으면 웹은 자동으로 Supabase 로 붙습니다. webapi.ts 는 남겨 둡니다." },
  { id: "D5-10", title: "Supabase 로컬 대역 완성 (DOCX 서빙 · 공용 쿼리 · RPC 검증 일치)", phase: "D5 오류수정·안정화" },
  { id: "D5-11", title: "todo 판정 수정 (webapi.py 삭제 대신 Supabase 키 설정 여부)", phase: "D5 오류수정·안정화" },
  { id: "D5-12", title: "Supabase 전환 절차 문서화 (README · .env.example)", phase: "D5 오류수정·안정화" },
  { id: "D5-13", title: "모델 ID claude-opus-5 → claude-opus-5-5 전환", phase: "D5 오류수정·안정화" },
  { id: "D5-14", title: "Claude Code CLI 백엔드(LLM_BACKEND=claude_code)", phase: "D5 오류수정·안정화" },
  { id: "D5-15", title: "웹 화면 가독성 개선", phase: "D5 오류수정·안정화" },
  { id: "D5-16", title: "실시간 테스트 결함 수정", phase: "D5 오류수정·안정화" },
  { id: "D5-17", title: "통합 에이전트 조치상태 오판 수정", phase: "D5 오류수정·안정화" },
  { id: "D5-18", title: "휴대폰 사용 시 화면 깨짐 점검", phase: "D5 오류수정·안정화" },
  { id: "D5-19", title: "에이전트 실행 중 새 민원 접수·분류 지연", phase: "D5 오류수정·안정화" },
  { id: "D5-21", title: "분류 기준 조정 (혼잡↔안전 경계)", phase: "D5 오류수정·안정화" },
  { id: "D5-20", title: "방문객 앱 디자인 적용 (Stitch 3화면)", phase: "D5 오류수정·안정화" },
  { id: "D5-23", title: "관리자 화면(관제·조치) 흑백 디자인 — 방문객 앱과 같은 톤", phase: "D5 오류수정·안정화" },
  { id: "D5-24", title: "방문객 접수: 119 박스 제거 · 접수 완료를 모달로", phase: "D5 오류수정·안정화" },
  { id: "D5-25", title: "내용 없는 민원(\"...\") 접수·오분류·거짓 즉시 알림", phase: "D5 오류수정·안정화" },
  { id: "D5-26", title: "유형 아이콘 · 전체 애니메이션", phase: "D5 오류수정·안정화" },
  { id: "D5-27", title: "구형 폰 브라우저에서 화면이 안 뜸 (JS 미실행)", phase: "D5 오류수정·안정화" },
  { id: "D5-28", title: "민원 신청(방문객) 페이지 둥근 디자인", phase: "D5 오류수정·안정화" },
  { id: "D5-29", title: "관제를 '조치할 일' 중심으로 — 문제·위치·우선순위·해야 할 일", phase: "D5 오류수정·안정화" },
  { id: "D5-30", title: "관제 민원 지우기 버튼 (숨김·되돌리기)", phase: "D5 오류수정·안정화" },
  { id: "D5-31", title: "관리자 기능 보호 — 방문객이 지우기·상태변경·요청서 호출 못 하게", phase: "D5 오류수정·안정화" },
  { id: "D5-32", title: "확인 필요 민원 처리 (유형 지정·닫기·지우기)", phase: "D5 오류수정·안정화" },
  { id: "D5-33", title: "접수 도배 방지 (같은 기기·구역 연속 접수 제한)", phase: "D5 오류수정·안정화" },
  { id: "D5-34", title: "서버·워커 멈춤 대비 — 자동 재시작·DB 손상 대비 백업", phase: "D5 오류수정·안정화" },
  { id: "D5-35", title: "Streamlit 화면에 조치할 일 카드·확인 필요 반영", phase: "D5 오류수정·안정화" },
  { id: "D5-36", title: "연결 끊김·서버 다운 시 화면 표시와 자동 재연결", phase: "D5 오류수정·안정화" },
  { id: "D5-37", title: "대량 데이터(민원 1,000건) 화면·API 속도", phase: "D5 오류수정·안정화" },
  { id: "D5-38", title: "접근성 점검 (키보드·스크린리더·대비)", phase: "D5 오류수정·안정화" },
  { id: "D5-39", title: "빈 화면·오류 화면 문구와 모양 다듬기", phase: "D5 오류수정·안정화" },
  { id: "D5-40", title: "보안·입력 점검 (webapi 입력 크기·CORS·오류 노출)", phase: "D5 오류수정·안정화" },
  { id: "D5-41", title: "사용설명서 2종 최신화 (카드·지우기·확인 필요·배지·운영자 코드)", phase: "D5 오류수정·안정화" },
  { id: "D5-42", title: "지운 민원 목록·복구 (5초 토스트 뒤에도 되돌리기)", phase: "D5 오류수정·안정화" },
  { id: "D5-43", title: "출처 판정 위조 방지 (X-Forwarded-For 는 믿는 프록시가 붙인 마지막 값만)", phase: "D5 오류수정·안정화" },
  { id: "D5-44", title: "SSE 변경 감지를 개수 대신 최신 수정 시각으로 (되돌리기·삭제가 1초 안에 겹치면 놓침)", phase: "D5 오류수정·안정화" },
  { id: "D5-45", title: "admin_flow '코드 보관 새로고침' 점검 간헐 실패", phase: "D5 오류수정·안정화" },
  { id: "D5-46", title: "admin_flow '다시 그려도 펼침 유지' 점검 간헐 실패", phase: "D5 오류수정·안정화" },
  { id: "D5-47", title: "TS 이전 ① core (config·db·심각도·카드·접수·개인정보 등) — server/README.md", phase: "D5 오류수정·안정화" },
  { id: "D5-48", title: "TS 이전 ② llm 루프·에이전트 4종·요청서 DOCX", phase: "D5 오류수정·안정화" },
  { id: "D5-49", title: "TS 이전 ③ webapi·worker·run_all_servers·cli·final_check", phase: "D5 오류수정·안정화" },
  { id: "D5-50", title: "TS 이전 ④ 테스트 이전 + 전환 판정 후 Python 삭제", phase: "D5 오류수정·안정화" },
  { id: "D5-51", title: "카드 왼쪽 굵은 색 막대(AI 느낌) 없애기", phase: "D5 오류수정·안정화" },
  { id: "D5-52", title: "같은 초·같은 부서 요청서 DOCX 파일명 겹쳐 덮어씀 → 밀리초 추가", phase: "D5 오류수정·안정화" },
  { id: "D5-53", title: "local 대역 여러 프로세스 동시 접수 시 같은 글이 안 합쳐짐 (BEGIN IMMEDIATE)", phase: "D5 오류수정·안정화" },
  { id: "D5-54", title: "worker.ts --sqlite (운영 Supabase 무시) — 실행표 8단계 원가 측정 전제", phase: "D5 오류수정·안정화" },
  { id: "D5-55", title: "남은 JS(tests/ui/*.mjs 9개 · web/scripts/phone.mjs) → TS 로 통일", phase: "D5 오류수정·안정화" },
  { id: "D5-56", title: "server/·tests/ui 에 tsc 타입 검사 도입 + 오류 0 (final_check 에 포함)", phase: "D5 오류수정·안정화" },
  { id: "D5-57", title: "운영 Supabase 30분 백업(JSON) + 복원 명령", phase: "D5 오류수정·안정화" },
  { id: "D5-58", title: "테스트가 운영 Storage 에 DOCX 업로드 (SQLite 모드면 업로드 금지)", phase: "D5 오류수정·안정화" },
  { id: "D5-59", title: "혼잡이지만 위험 없음(is_safety=false, 예: 줄이 길다) 인데 카드가 즉시로 올라감", phase: "D5 오류수정·안정화" },
  { id: "D5-60", title: "관제 한 줄 요약의 건수가 카드와 다름 ('유등터널 혼잡 5건' ↔ 카드 3건)", phase: "D5 오류수정·안정화" },
  { id: "D5-61", title: "알림 목록 '최근 3건' 에 안전·혼잡 즉시 알림이 빠지고 보통 알림만 보임", phase: "D5 오류수정·안정화" },
  { id: "D5-62", title: "관리자 '개발자 보기' — 내부 AI 동작(에이전트 기록·판단 근거·점수·토큰) 켜고 끄기", phase: "D5 오류수정·안정화" },
  { id: "D5-63", title: "[심사] 문서 숫자 통일 — 정확도·지연·도구 수·기준 날짜", phase: "D5 오류수정·안정화" },
  { id: "D5-64", title: "[심사] 보고서 A4 5p · 기술설명서 1p 분량 맞추기", phase: "D5 오류수정·안정화" },
  { id: "D5-65", title: "[심사] Planning — 통합 에이전트가 이번 주기 계획(볼 구간·부를 에이전트)을 세우고 기록", phase: "D5 오류수정·안정화" },
  { id: "D5-66", title: "[심사] Memory — 분류가 과거 유사 사례를 실제로 조회·반영하고 기록", phase: "D5 오류수정·안정화" },
  { id: "D5-67", title: "[심사] 비즈니스 모델 빈칸 — 공개 자료·실사례 근거로 채우기(원가는 API 실측 뒤)", phase: "D5 오류수정·안정화" },
  { id: "D5-68", title: "[심사] 출처신고서 — AI 도구가 만든 부분과 팀이 정한 부분 구분", phase: "D5 오류수정·안정화" },
  { id: "D5-69", title: "[심사] 분류 지연 단축 (목표 10초) — 호출 수·프롬프트 줄이기", phase: "D5 오류수정·안정화" },
  { id: "D5-70", title: "[심사] 숫자 자동 갱신 도구 sync_numbers.ts — 키 도착 후 한 명령으로 문서 숫자 통일", phase: "D5 오류수정·안정화" },
  { id: "D5-71", title: "[심사] 접수→분류 대기(워커 3초 폴링) 줄이기 — 최댓값 10초 안", phase: "D5 오류수정·안정화" },
  { id: "D5-72", title: "[심사] 🔴 기억 직접 반영이 안전 민원을 놓침 (뒤에 위험 내용 붙이면 LLM 생략)", phase: "D5 오류수정·안정화" },
  { id: "D5-73", title: "[심사] 바뀐 프롬프트로 재측정 — final_check·정확도(CLI)·TC --live·계획 CLI 한 바퀴 → sync_numbers", phase: "D5 오류수정·안정화" },
  { id: "D5-74", title: "요청서 DOCX 저장 경로가 DOCS_DIR 무시 — 테스트가 운영 output/ 에 씀", phase: "D5 오류수정·안정화" },
  { id: "D5-75", title: "[심사] 위험 신호 사전 보강 — 물에 빠짐·익수·전선·누전 등 (수면 개최 축제)", phase: "D5 오류수정·안정화" },
  { id: "D5-76", title: "[심사] 첫 호출 콜드스타트 — 워커 시작 때 준비 호출", phase: "D5 오류수정·안정화" },
  { id: "D5-77", title: "[심사] 조치 에이전트(요청서) 느림 — 6회 호출 67초 줄이기", phase: "D5 오류수정·안정화" },
  { id: "D5-78", title: "구조 검증 실행이 실제 모델 TC 리포트를 덮어씀 — 파일 분리", phase: "D5 오류수정·안정화" },
  { id: "D5-79", title: "[심사] 감시·통합은 agent 모드 유지(판단은 모델) — prefetch 확대 취소, 호출 낭비만 줄이기", phase: "D5 오류수정·안정화" },
  { id: "D5-80", title: "[심사] local 규칙 안전어 오탐 — 물에 젖은·구명조끼·빠짐없이 (구 단위로 좁히기)", phase: "D5 오류수정·안정화" },
  { id: "D5-81", title: "[심사] local 안전어에 불꽃 계열 — 불꽃이 떨어·불똥·파편", phase: "D5 오류수정·안정화" },
  { id: "D5-82", title: "[심사6] 같은 민원 등급이 관제(즉시)·조치(높음) 화면마다 다름", phase: "D5 오류수정·안정화" },
  { id: "D5-83", title: "[심사6] 즉시 규칙 명확화 — 생명위험어 1건 즉시 / 일반 안전 1~2건 높음 / 오탐 처리 제외", phase: "D5 오류수정·안정화" },
  { id: "D5-84", title: "[심사6] 이태원 112 공개 녹취 시간순 재현 — 18:34 첫 신고에서 즉시", phase: "D5 오류수정·안정화" },
  { id: "D5-85", title: "[심사6] 가중치 ±20% 민감도 스크립트 + 결과 파일", phase: "D5 오류수정·안정화" },
  { id: "D5-86", title: "[심사6] 관제 '마지막 갱신 N분 전' + 에이전트 멈춤 경고", phase: "D5 오류수정·안정화" },
  { id: "D5-87", title: "[심사6] 화면 내부 용어·예시 번호·119 안내·라벨 모호 정리", phase: "D5 오류수정·안정화" },
  { id: "D5-88", title: "[심사6] 출처·신규개발 정의 통일 + 근거 없는 수치 정리 + 문서 일관성", phase: "D5 오류수정·안정화" },
  { id: "D5-89", title: "[심사6] 시연 시드를 실제 모델로 미리 분류해 캐시 (역전 장면에 AI)", phase: "D5 오류수정·안정화" },
  { id: "D5-90", title: "관리자 '설정'(도구) — 축제 정보·구역·부서·연락처를 운영자가 직접 입력", phase: "D5 오류수정·안정화" },
  { id: "D6-1", title: "Test Case 5종 `--live` 수행", phase: "D6 테스트·검증", check: CHK["D6-1"], note: "현재 리포트는 구조 검증 모드 결과입니다." },
  { id: "D6-2", title: "분류 정확도 측정 스크립트 작성", phase: "D6 테스트·검증", check: CHK["D6-2"] },
  { id: "D6-3", title: "정확도 측정 실행 (대역 vs 실제 모델)", phase: "D6 테스트·검증", check: CHK["D6-3"], note: "신청서에 적은 '85% 이상' 목표의 근거가 됩니다." },
  { id: "D6-4", title: "실사용자 3명 검증 (+1점 가점)", phase: "D6 테스트·검증", check: CHK["D6-4"], note: "QR 접수폼은 일반인이 바로 쓸 수 있어 동기 3명이면 충족됩니다." },
  { id: "D6-5", title: "민원 1건 처리 원가 실측 (agent_log 토큰 기록)", phase: "D6 테스트·검증", check: CHK["D6-5"], note: "비즈니스 모델 10점의 핵심 숫자입니다." },
  { id: "D6-6", title: "실제 수집 리뷰로 시드 교체", phase: "D6 테스트·검증", check: CHK["D6-6"], note: "dev_sample.csv 는 합성 데이터입니다. 실제 수집분으로 제출해야 합니다." },
  { id: "D6-7", title: "테스트 공백 메우기 — 감시·알림 규칙, 요청서 내용 검증", phase: "D6 테스트·검증" },
  { id: "D6-8", title: "동시 접수·벽시계 지연 자동 측정", phase: "D6 테스트·검증" },
  { id: "D7-1", title: "시연영상 3분", phase: "D7 제출물", check: CHK["D7-1"], note: "1:30~2:00 역전 구간이 핵심. node server/cli.ts watch 또는 관제 화면 사용." },
  { id: "D7-2", title: "개발완료보고서 A4 5p", phase: "D7 제출물", check: CHK["D7-2"] },
  { id: "D7-3", title: "기술설명서 1p", phase: "D7 제출물", check: CHK["D7-3"], note: "설계 문서 말미에 대응표가 있습니다." },
  { id: "D7-4", title: "발표자료 10장", phase: "D7 제출물", check: CHK["D7-4"], note: "본선 6분 구성: 문제30초/Agent1분/구조1분/시연2분30초/성과30초/발전계획30초" },
  { id: "D7-5", title: "비즈니스 모델 빈칸 채우기 (10점)", phase: "D7 제출물", check: CHK["D7-5"], note: "단가·시장규모. 근거 없는 숫자는 쓰지 말 것." },
  { id: "D7-6", title: "별지2 출처·AI 활용 신고서", phase: "D7 제출물", check: CHK["D7-6"] },
  { id: "D7-7", title: "소스 저장소 정리 (접근 권한·비밀키 제거)", phase: "D7 제출물" },
  { id: "D8-1", title: "회귀 테스트 (node server/scripts/final_check.ts — 단위·시나리오·웹 tsc/빌드)", phase: "D8 최종 제출" },
  { id: "D8-2", title: "백엔드가 anthropic 인지 확인", phase: "D8 최종 제출", check: CHK["D8-2"] },
  { id: "D8-3", title: "`.env` · `web/.env` · `festival.db` 제출물에서 제외 확인", phase: "D8 최종 제출" },
  { id: "D8-4", title: "구글폼 제출 (10/6 낮 12시 마감)", phase: "D8 최종 제출" },
  { id: "D8-5", title: "제출본에 local 대역 없음 (LLM · 웹)", phase: "D8 최종 제출", check: CHK["D8-5"] },
];

// 이미 끝난 것도 남겨 둔다. 되돌아갈 수 있기 때문이다.
export const DONE_TASKS: Task[] = [
  { id: "E2E", title: "접수→분류→심각도→조치→브리핑 관통", phase: "완료 (자동 확인)", check: CHK["E2E"] },
  { id: "DOCX", title: "조치요청서 DOCX 생성 (server/tests 가 내용까지 검사)", phase: "완료 (자동 확인)" },
];

// 끝나서 진행현황.md 로 옮긴 항목. 할 일 목록에는 그리지 않고 완료로만 센다.
// auto 항목은 판정이 다시 실패하면(되돌아가면) 목록에 다시 나타난다.
export const ARCHIVED: Set<string> = new Set([
  "E2E", "DOCX", "D5-3", "D5-7", "D5-8", "D5-10", "D5-11", "D5-12", "D5-13", "D5-15", "D5-16", "D5-17", "D5-19", "D5-20", "D5-21", "D5-23", "D5-24", "D5-25", "D5-26", "D5-27", "D5-28", "D5-29", "D5-30", "D5-32", "D5-35", "D5-34", "D5-36", "D5-37", "D5-40", "D5-41", "D5-43", "D5-33", "D5-38", "D5-39", "D5-42", "D5-31", "D5-44", "D5-45", "D5-4", "D5-51", "D5-46", "D5-47", "D5-48", "D5-52", "D5-53", "D5-6", "D5-9", "D6-2", "D6-7", "D6-8", "D5-54", "D5-49", "D5-50", "D5-55", "D5-56", "D5-57", "D5-58", "D5-60", "D5-61", "D5-59", "D5-62", "D5-70", "D5-65", "D5-66", "D5-63", "D5-64", "D5-69", "D5-68", "D5-67", "D5-71", "D5-72", "D5-73", "D5-74", "D5-75", "D5-76", "D5-77", "D5-78", "D5-79", "D5-80", "D5-81", "D5-90", "D5-83", "D5-88", "D5-89", "D5-84", "D5-14", "D5-85", "D5-18", "D5-82", "D5-86", "D5-87",
]);

// AI 가 할 수 있는 일은 끝났고 키나 사람만 남은 항목. 한 줄로 모아 '대기' 절에 그린다.
// 판정(auto)이 통과하면 자동으로 완료 처리된다. 준비된 것은 진행현황.md 에 있다.
export const WAITING: Record<string, string> = {
  "D5-1": "건너뜀(사용자 결정 10/5) — API 키 없이 claude_code 로 제출·시연.",
  "D5-2": "건너뜀(사용자 결정 10/5) — claude_code 로 통과.",
  "D5-5": "건너뜀(사용자 결정 10/5) — TourAPI 없이 수기 시드 사용.",
  "D6-1": "건너뜀(사용자 결정 10/5) — claude_code 5/5 통과.",
  "D6-3": "건너뜀(사용자 결정 10/5) — claude_code 96.9%·31/32.",
  "D6-4": "건너뜀(사용자 결정 10/5) — 실사용자 검증 안 함, 보고서 한계에 명시.",
  "D6-5": "건너뜀(사용자 결정 10/5) — claude_code 실측값 사용(제출_준비/원가측정_참고.md).",
  "D6-6": "건너뜀(사용자 결정 9/30) — 합성 시드 사용을 보고서에 명시.",
};


// ── 파싱 · 렌더링 ─────────────────────────────────────────────────

function _load_state(): Record<string, string> {
  if (isFile(STATE_PATH)) {
    try {
      return JSON.parse(readText(STATE_PATH));
    } catch {
      return {};
    }
  }
  return {};
}

function _save_state(state: Record<string, string>): void {
  writeText(STATE_PATH, JSON.stringify(state, null, 2));
}

/** 기존 파일에서 체크 상태와 사람이 쓴 메모를 읽어온다. */
export function parse_existing(p: string = TODO_PATH): Map<string, [boolean, string[]]> {
  const state = new Map<string, [boolean, string[]]>();
  if (!isFile(p)) return state;
  let current: string | null = null;
  for (const line of readText(p).split("\n")) {
    const m = DONE_RE.exec(line);
    if (m) {
      current = m[2];
      state.set(current, [m[1] === "x", []]);
    } else if (current && line.startsWith("      > ")) {      // 사람이 쓴 메모
      state.get(current)![1].push(line.slice(8));
    } else if (line.trim() === "" || line.startsWith("#")) {
      current = null;
    }
  }
  return state;
}

/** 기존 파일의 항목 제목. TASKS 에 없는 항목을 보존할 때 쓴다. */
function _titles(p: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!isFile(p)) return out;
  for (const line of readText(p).split("\n")) {
    const m = DONE_RE.exec(line);
    if (m) out.set(m[2], m[3]);
  }
  return out;
}

const p2 = (n: number): string => String(n).padStart(2, "0");
/** datetime.strftime('%Y-%m-%d %H:%M:%S') / ('%Y-%m-%d %H:%M') */
const stamp = (d: Date, sec: boolean): string =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}${sec ? ":" + p2(d.getSeconds()) : ""}`;

export async function render(p: string = TODO_PATH, opts: { saveState?: boolean } = {}): Promise<string> {
  const prev = parse_existing(p);
  const state = _load_state();
  let state_dirty = false;
  const now = new Date();

  const lines: string[] = [
    "# 할 일",
    "",
    "제4회 경남 AI·SW 경진대회 · 실시간 축제 민원 관제 AI Agent",
    "",
    `자동 갱신: ${stamp(now, true)} · ` +
      `제출 마감 2026-10-06(수) 12:00 (D-${Math.floor((new Date(2026, 9, 6).getTime() - now.getTime()) / 86_400_000)})`,
    "",
    "`auto` 항목은 시스템을 직접 확인해 표시합니다. 체크를 바꿔도 다음 갱신 때",
    "증거대로 돌아갑니다. 그 외 항목은 직접 체크하시면 그대로 보존됩니다.",
    "항목 아래 `      > 메모` 형식으로 쓴 줄도 보존됩니다.",
    "",
  ];

  const groups = new Map<string, Task[]>();
  for (const t of [...DONE_TASKS, ...TASKS]) {
    if (!groups.has(t.phase)) groups.set(t.phase, []);
    groups.get(t.phase)!.push(t);
  }

  let total = 0, done_n = 0, archived_n = 0;
  let body: string[] = [];
  let waiting: string[] = [];
  for (const [phase, tasks] of groups) {
    const section: string[] = [];
    for (const t of tasks) {
      if (ARCHIVED.has(t.id) && (!is_auto(t) || (await t.check!())[0])) {
        total += 1;
        done_n += 1;
        archived_n += 1;
        continue;
      }
      let ok: boolean;
      let tag: string;
      if (is_auto(t)) {
        let evidence: string;
        [ok, evidence] = await t.check!();
        if (ok && !(t.id in state)) {
          state[t.id] = stamp(now, false);
          state_dirty = true;
        } else if (!ok && t.id in state) {
          // 한 번 달성했는데 지금은 아니다. DB 초기화 등으로 증거가
          // 사라진 경우다. 지금 상태를 정직하게 보여주되 이력은 남긴다.
          evidence = `${evidence} (이전 달성 ${state[t.id].slice(5, 10)})`;
        }
        tag = `  \`auto\` ${evidence}`;
      } else {
        ok = (prev.get(t.id) ?? [false, []])[0];
        tag = "";
      }
      if (t.id in WAITING) {
        total += 1;
        if (ok) {                     // 키·사람이 채워 통과하면 끝난 것으로
          done_n += 1;
          archived_n += 1;
        } else {
          waiting.push(`- [ ] \`${t.id}\` ${t.title} — ${WAITING[t.id]}`);
          // 대기 항목에도 준비·설계 메모가 붙는다. 지우지 않는다.
          waiting = waiting.concat((prev.get(t.id) ?? [false, []])[1].map((m) => `      > ${m}`));
        }
        continue;
      }
      total += 1;
      done_n += ok ? 1 : 0;
      section.push(`- [${ok ? "x" : " "}] \`${t.id}\` ${t.title}${tag}`);
      if (t.note) section.push(`      ${t.note}`);
      for (const memo of (prev.get(t.id) ?? [false, []])[1]) section.push(`      > ${memo}`);
    }
    if (section.length) body = body.concat([`## ${phase}`, ""], section, [""]);
  }

  if (state_dirty && opts.saveState !== false) _save_state(state);

  const bar = total ? "█".repeat(round(done_n / total * 24)) : "";
  lines.push(`진행 ${done_n}/${total}  \`${bar.padEnd(24)}\``, "");
  if (archived_n) lines.push(`끝난 ${archived_n}개는 \`진행현황.md\` 로 옮겼습니다.`, "");
  if (waiting.length) lines.push("## 대기 — 키나 사람이 있어야 끝남 (AI 작업은 끝남)", "", ...waiting, "");
  lines.push(...body);
  lines.push(
    "## 갱신 방법",
    "",
    "```bash",
    "node server/cli.ts todo        # 지금 상태로 다시 그리기",
    "node server/cli.ts todo --watch # 파일을 고칠 때마다 자동 반영",
    "node server/worker.ts          # 에이전트가 한 바퀴 돌 때마다 자동 갱신",
    "```",
    "",
  );
  return lines.join("\n");
}

/** 비교용으로 타임스탬프 줄을 뺀다. 그 줄은 매번 달라지므로 넣고 비교하면 항상 '변경됨'이 된다. */
export function _comparable(text: string): string {
  return text.split("\n").filter((l) => !l.startsWith("자동 갱신:")).join("\n");
}

/** 파일을 다시 그린다. (완료, 전체, 기록여부) 를 돌려준다.
 *
 *  내용이 그대로면 쓰지 않는다. 워커가 주기마다 호출해도 mtime 이 흔들리지
 *  않아야 --watch 가 자기 쓰기를 변경으로 오인하지 않는다.
 *
 *  테스트·측정 스크립트는 임시 DB(DB_PATH)를 쓴다. 그 상태로 할일.md 를 그리면
 *  '웹 요청 이력 없음' 같은 거짓 판정이 운영 목록에 들어가므로, 운영 DB 가
 *  아니면 기본 파일에는 쓰지 않는다. */
export async function refresh(p: string = TODO_PATH): Promise<[number, number, boolean]> {
  if (samePath(p, TODO_PATH) && !config.SUPABASE_DB_URL && !samePath(config.DB_PATH, path.join(ROOT, "festival.db"))) {
    return [0, 0, false];
  }
  const text = await render(p);
  let changed = true;
  if (isFile(p)) changed = _comparable(readText(p)) !== _comparable(text);
  if (changed) writeText(p, text);

  const m = /진행 (\d+)\/(\d+)/.exec(text);
  const [done, total] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  return [done, total, changed];
}

// 직접 실행
//   node server/core/todo.ts [--path <파일>]          할일.md 를 쓰지 않고 render() 결과만 표준출력에 낸다(미리 보기)
//   node server/core/todo.ts --archive <id> [<id>…]  ARCHIVED 에 id 를 덧붙인다(이 파일을 고친다). 모르는 id 는 거부한다.
/** ARCHIVED 목록에 id 를 덧붙인다 (소스 파일을 직접 고친다). 돌려주는 값: 새로 넣은 id 들 */
export function archive_ids(ids: string[]): string[] {
  const known = new Set([...DONE_TASKS, ...TASKS].map((t) => t.id));
  const bad = ids.filter((i) => !known.has(i));
  if (bad.length) throw new Error(`목록에 없는 id: ${bad.join(", ")}`);
  const added = ids.filter((i, k) => !ARCHIVED.has(i) && ids.indexOf(i) === k);
  if (!added.length) return [];
  const src = readFileSync(import.meta.filename, "utf-8");
  const m = /(export const ARCHIVED: Set<string> = new Set\(\[[\s\S]*?)(,?\n\]\);)/.exec(src);
  if (!m) throw new Error("ARCHIVED 목록을 찾지 못했습니다");
  const out = src.slice(0, m.index) + m[1] + added.map((i) => `, ${JSON.stringify(i)}`).join("") + (m[2].startsWith(",") ? m[2] : "," + m[2]) + src.slice(m.index + m[0].length);
  writeFileSync(import.meta.filename, out, "utf-8");
  return added;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const ai = argv.indexOf("--archive");
  if (ai >= 0) {
    const ids = argv.slice(ai + 1).filter((x) => !x.startsWith("--"));
    if (!ids.length) { console.error("사용: node server/core/todo.ts --archive <id> [<id>…]"); process.exit(2); }
    try {
      const added = archive_ids(ids);
      console.log(added.length ? `ARCHIVED 에 추가: ${added.join(", ")}` : "이미 모두 ARCHIVED 에 있습니다");
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  } else {
    const i = argv.indexOf("--path");
    process.stdout.write(await render(i >= 0 ? argv[i + 1] : TODO_PATH, { saveState: false }));
    await db.close_all();
  }
}
