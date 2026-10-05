// 개발자 보기 데이터 (D5-62) — 관리자 화면이 내부 AI 동작을 보여 줄 때 쓰는 한 덩어리. (신규, Python 원본 없음)
//
// 심사위원이 에이전트가 도는 모습을 보는 용도라 **공개 읽기 전용**이다 (webapi 의 RPC dev_feed · GET /api/dev,
// Supabase 는 schema.sql 의 dev_feed 가 같은 모양을 돌려준다). 공개로 나가도 안전하게:
//   · 모든 문자열을 redact() 로 가린다 — 개인정보(접수 때 이미 마스킹한 것에 한 번 더)·파일 경로·주소의 ?뒤·DB 주소·키·토큰·해시·IP,
//     그리고 .env 에 든 비밀값(서비스 키·API 키·DB 주소) 자체.
//   · 응답은 로그 200행·분류 40건까지, 호출은 출처별로 제한한다 (webapi 가 센다).
//   · 읽는 것은 agent_log·classification·severity·issue·worker_status 뿐 — 출처 해시 표는 건드리지 않는다.
// 점수·계산식이 들어 있으므로 방문객용 응답(/api/control)에는 계속 넣지 않는다. 관리자 동작(지우기·상태 변경)은 그대로 코드가 필요하다.
//
// 응답 { ok, now, max_log_id, max_cls_id, logs[], classifications[], severity[], cards[], status{backend_llm, loops{}, tokens_today{}} }
//   logs             id > since_log 오래된 것부터 최대 200건. since_log=0 이면 가장 최근 200건. 다음 호출에 max_log_id 를 넘긴다.
//   classifications  가장 최근 40건(최신 먼저, 지운 민원 제외). since_cls 는 받기만 한다 (상태가 바뀌므로 매번 40건).
//   severity         가장 최근 스냅샷의 유형별 내부값 (score·formula·grade·spike_w·spike_mult·safety_w·safety_freq …)
//   cards            활성 카드의 내부값 (card_score·formula·text_source·fail_count …)
//   status           워커가 루프마다 남기는 worker_status 와 오늘 토큰 합계
import { config } from "./config.ts";
import * as db from "./db.ts";
import * as privacy from "./privacy.ts";

export type Row = Record<string, any>;

export const MAX_LOGS = 200;
export const MAX_CLS = 40;
const RAW_TEXT_MAX = 120;

/** .env 의 비밀값 — 글자 그대로 나오면 가린다 (4자 미만은 오탐이 커서 제외). */
function secret_values(): string[] {
  const vals = [config.SUPABASE_SERVICE_KEY, config.SUPABASE_DB_URL, process.env.ANTHROPIC_API_KEY, process.env.TOURAPI_KEY];
  return vals.filter((v): v is string => typeof v === "string" && v.length >= 4);
}

// schema.sql 의 dev_redact() 와 같은 규칙 (순서도 같다)
const REDACT: [RegExp, string][] = [
  // 로그는 저장할 때 글자 수에서 잘리므로 키의 앞부분만 남아 있을 수 있다 → 앞 8자만 보여도 가린다
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{8,}/g, "[해시]"],                                // bcrypt 해시
  [/eyJ[A-Za-z0-9_.-]{8,}/g, "[키]"],                                                 // JWT (Supabase 키)
  [/(?:sk|sb|pk)[-_][A-Za-z0-9_-]{8,}/g, "[키]"],                                     // API 키 모양
  [/postgres(?:ql)?:\/\/[^\s"']+/g, "[DB주소]"],
  [/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, "$1?[숨김]"],                                // 주소의 ?뒤 (serviceKey 등)
  [/[A-Za-z]:\\+(?:[^"'\\]+\\+)*[^"'\\]*/g, "[경로]"],                              // Windows 경로 (공백 포함)
  [/\/(?:Users|home)\/[^\s"']*/g, "[경로]"],
];
const REDACT_AFTER: [RegExp, string][] = [
  [/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g, "[IP]"],
  [/(?<![0-9A-Za-z])[0-9a-fA-F]{12,}(?![0-9A-Za-z])/g, "[해시]"],                        // 출처 해시(16자)·sha 해시 (잘린 앞부분 포함)
];

/** 공개 응답에 나가는 글자를 가린다. 문자열이 아니면 그대로. */
export function redact(v: unknown): any {
  if (typeof v !== "string") return v;
  let s = v;
  for (const secret of secret_values()) {
    // 전체뿐 아니라 잘려서 남은 앞부분(8자 이상)도 가린다 — 긴 것부터
    for (let k = secret.length; k >= 8; k--) s = s.split(secret.slice(0, k)).join("[숨김]");
    if (secret.length < 8) s = s.split(secret).join("[숨김]");
  }
  for (const [re, to] of REDACT) s = s.replace(re, to);
  s = privacy.mask(s);
  for (const [re, to] of REDACT_AFTER) s = s.replace(re, to);
  return s;
}
const redact_row = (r: Row, keys: string[]): Row => {
  const o = { ...r };
  for (const k of keys) if (k in o) o[k] = redact(o[k]);
  return o;
};

const num = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export async function dev_feed(p_since_log: unknown = 0, p_since_cls: unknown = 0): Promise<Row> {
  const since = num(p_since_log);
  num(p_since_cls);                                     // 받기만 한다 (분류 행은 상태가 바뀌어 매번 최근 40건)
  const conn = await db.connect();
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await conn.execute(sql, params)).fetchall().map((r) => ({ ...r }));

  // ① agent_log
  const cols = `id, created_at, agent, action, input_summary, output_summary, reasoning, latency_ms,
                COALESCE(input_tokens, 0) tokens_in, COALESCE(output_tokens, 0) tokens_out, COALESCE(cache_read_tokens, 0) tokens_cache`;
  let logs = since > 0
    ? await q(`SELECT ${cols} FROM agent_log WHERE id > ? ORDER BY id ASC LIMIT ${MAX_LOGS}`, [since])
    : (await q(`SELECT ${cols} FROM agent_log ORDER BY id DESC LIMIT ${MAX_LOGS}`)).reverse();
  const max_log_id = logs.length ? Number(logs[logs.length - 1].id) : since;
  logs = logs.map((r) => ({ ...redact_row(r, ["input_summary", "output_summary", "reasoning"]), id: Number(r.id) }));

  // ② 최근 분류
  const classifications = (await q(
    `SELECT c.feedback_id, f.raw_text, c.label, c.status, c.is_safety, c.confidence, c.agent_note, c.suggested_label, c.processed_at
     FROM classification c JOIN feedback f ON f.id = c.feedback_id
     WHERE f.deleted_at IS NULL ORDER BY c.feedback_id DESC LIMIT ${MAX_CLS}`))
    .map((r) => redact_row({ ...r, raw_text: String(r.raw_text ?? "").slice(0, RAW_TEXT_MAX) }, ["raw_text", "agent_note"]));
  const max_cls_id = Number((await q("SELECT COALESCE(MAX(feedback_id), 0) m FROM classification"))[0]?.m ?? 0);

  // ③ 유형별 심각도 내부값 (가장 최근 스냅샷)
  const severity = (await q(
    "SELECT * FROM severity WHERE as_of = (SELECT MAX(as_of) FROM severity) ORDER BY score DESC"))
    .map(({ id: _id, festival_id: _fid, ...r }) => r);

  // ④ 카드 내부값
  const cards = await q(
    `SELECT issue_key, label, zone_name, grade, is_safety, card_score, formula, freq, type_freq, text_source, fail_count, grp, rank_no
     FROM issue WHERE active = 1 ORDER BY rank_no`);

  // ⑤ 워커 상태
  let loops: Record<string, Row> = {};
  let backend_llm: string | null = null;
  try {
    for (const r of await q("SELECT name, last_at, took_ms, ok, note FROM worker_status")) {
      if (r.name === "_backend") backend_llm = r.note ?? null;
      else loops[r.name] = { last_at: r.last_at, took_ms: r.took_ms, ok: r.ok, note: redact(r.note) };
    }
  } catch {
    loops = {};                                          // worker_status 표가 아직 없는 DB
  }
  const today = db.now().slice(0, 10);
  const t = (await q(
    `SELECT COALESCE(SUM(input_tokens), 0) i, COALESCE(SUM(output_tokens), 0) o, COALESCE(SUM(cache_read_tokens), 0) c
     FROM agent_log WHERE created_at >= ?`, [today]))[0] ?? {};

  return {
    ok: true, now: db.now(), max_log_id, max_cls_id,
    logs, classifications, severity, cards,
    status: { backend_llm, loops, tokens_today: { input: Number(t.i ?? 0), output: Number(t.o ?? 0), cache: Number(t.c ?? 0) } },
  };
}
