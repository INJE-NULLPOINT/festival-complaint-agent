// 관제 '지금 조치할 일' 카드 (D5-29). (core/issues.py 와 1:1)
//
// 카드 = (유형, 구역). 심각도 창 안의 status='done' 민원만 쓴다 (positive·review 제외).
// 구역이 없는 민원(zone_id NULL)은 '구역 미상' 카드 하나로 모은다.
//
// 결정적인 것 (이 모듈이 계산 — 같은 입력이면 같은 결과)
//   등급      유형 등급을 그대로 물려받는다 (S-04·B-01~B-04). 안전 3건이 세 구역에 흩어져도 세 카드 모두 즉시.
//   카드 점수 P = 유형 심각도 S × 집중 C × 최근 R
//             C = 0.5 + 0.5 × (구역 건수 / 유형 건수)     0.5~1.0   ('구역 미상'은 0.5 고정)
//             R = 1 − 0.5 × min(마지막 민원 경과분 / 창 길이, 1)   0.5~1.0
//   정렬      ① 조치 그룹(본 목록 → 조치 중 → 조치 완료; 완료 뒤 새 민원이 오면 본 목록 복귀,
//                요청서 이후 새로 생긴 구역의 카드는 '조치 중'이어도 본 목록에 남고 new_since_request 표시)
//             ② 등급 ③ 안전 계열(안전·혼잡) 먼저 ④ 카드 점수 ⑤ 마지막 민원 시각(최신 우선)
//   노출      유형 등급이 mid 이상이거나 안전 유형. 본 목록은 상위 5장, 나머지는 '그 밖'.
//   건수·마지막 시각·최신 민원(latest_quotes)은 매 주기 LLM 없이 바로 갱신한다.
//
// AI 가 정하는 것 (④통합이 기존 1회 호출 안에서)
//   문제 한 줄(title) · 해야 할 일(2~4개, 각각 근거 민원 quote_id 1개). 숫자(건수·시각·점수)는 코드가 넣는다.
//   저장 전에 결정적으로 검사하고, 실패한 카드는 템플릿으로 채운다. 조치 목록(config.ACTION_CATALOG)은 '참고 예시'일 뿐이다.
//   문구는 카드마다 최소 CARD_TEXT_MIN_INTERVAL 초 간격으로만 다시 쓴다 (등급·조치 그룹이 바뀌면 즉시).
//
// 저장은 issue 테이블 한 행 = 카드 한 장. 계산 열은 refresh() 가, 문장 열은 apply_entries() 가 따로 갱신한다.
import { config } from "./config.ts";
import * as db from "./db.ts";
import { fromisoformat } from "./datetime.ts";
import * as privacy from "./privacy.ts";
import { fixed, round } from "./pyfmt.ts";

export type Row = Record<string, any>;

export const GRADE_ORDER: Record<string, number> = { immediate: 0, high: 1, mid: 2, low: 3 };
export const GROUP_ORDER: Record<string, number> = { main: 0, in_progress: 1, done: 2 };

export const TOP_N = 3;               // ④가 문장을 만드는 카드 수
export const MAIN_MAX = 5;            // 본 목록 최대 장수 (넘치면 group='more')
export const CANDIDATES = 5;          // 카드마다 근거 후보 민원 수 (최신 순, 지시문 형태 민원은 뺀 것)
export const INJECTED_KEEP = 2;       // 지시문 형태 민원은 근거가 못 되고, 원문 복사 검사와 투명한 표시용으로만 뒤에 붙여 둔다
export const LATEST_SHOWN = 3;        // latest_quotes 에 담는 최신 민원 수
export const TITLE_MAX = 40;
export const ACTION_MIN = 2;
export const ACTION_MAX = 4;
export const ACTION_LEN = 50;
export const MAX_FAIL = 2;            // 같은 서명에서 AI 문장이 이만큼 실패하면 템플릿으로 두고 다시 부르지 않는다
export const COPY_RUN = 12;           // 조치 문장이 민원 원문과 연속 이만큼 같으면 거부

// 한글 수사 + 단위("세 명", "오십 대", "열 분")도 숫자와 같은 '수치 약속'으로 보고 거부한다.
// "이번"·"한 건물"·"한 장소"·"분명" 같은 평범한 말과 겹치지 않게: 한 글자 한자어 수사(이·삼·오…)와 단위 건·장·마리·배는
// 제외하고, 대·개·회·분 뒤에 흔한 글자(기·선·의·명 …)가 이어지면 단위로 보지 않는다.
const _NATIVE_NUM = String.raw`(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스물|서른|마흔|쉰|예순|일흔|여든|아흔)`;
const _SINO_NUM = String.raw`(?:(?:이|삼|사|오|육|칠|팔|구)?십|백|천|만)`;
const _UNIT = String.raw`(?:명|곳|번|차례|군데|시간` +
  String.raw`|대(?!기|표|체|책|응|학|원|략)|개(?!선|소|방|최|인|념)|회(?!의|사|원|복|전)|분(?!명|야|석|리|위|량)` +
  String.raw`|배(?!치|려|경|달|출|정|포|송|분|급|열|수|상|우|움))`;      // '두 배로 늘림' 같은 배수 표현도 수량 약속
export const NUMBER_WORDS_RE = new RegExp(String.raw`(?:${_NATIVE_NUM}|${_SINO_NUM})\s?${_UNIT}`);
const _ONCE = /한\s?(?:번|차례)/g;     // '한 번 더 안내방송' 은 수량 약속이 아니다

/** NUMBER_WORDS.search(text) — '한 번'·'한 차례'는 빼고 찾는다. */
export const NUMBER_WORDS = {
  search(text: string | null | undefined): RegExpExecArray | null {
    return NUMBER_WORDS_RE.exec((text ?? "").replace(_ONCE, ""));
  },
};

// 계산 열 — refresh() 가 바꾼다
export const _COMPUTED = ["rank_no", "grp", "label", "zone_id", "zone_name", "grade", "is_safety", "type_score",
  "conc", "rec", "card_score", "formula", "freq", "type_freq", "last_at",
  "same_zone_others", "recurred", "new_since_request", "action_status", "action_request_id", "department",
  "contact", "signature", "latest_quotes"];

function _zone_key(zone_id: number | null | undefined): string {
  return zone_id === null || zone_id === undefined ? "x" : String(zone_id);
}

export function issue_key(label: string, zone_id: number | null | undefined): string {
  return `${label}:${_zone_key(zone_id)}`;
}

const _dumps = (v: unknown): string => JSON.stringify(v);

// ── 카드 계산 (결정적) ──

/** 지금 상태에서 카드 목록을 만든다. 정렬·rank_no·grp 까지 채워 돌려준다. */
export async function build_cards(window_min: number | null = null): Promise<Row[]> {
  const win = window_min || config.DEFAULT_WINDOW_MIN;
  const rows = (await db.window_rows(win)).map((r) => ({ ...r }));
  const ranked = await db.ranked(win);
  const ref = await db.data_now();
  const zone_names = new Map<number, string>((await db.zones()).map((z) => [z.id as number, z.name as string]));
  const actions = await db.latest_actions();

  const groups = new Map<string, { label: string; zone_id: number | null; items: Row[] }>();
  for (const r of rows) {
    if (config.EXCLUDED_FROM_SEVERITY.has(r.label)) continue;
    const k = `${r.label}|${r.zone_id}`;
    if (!groups.has(k)) groups.set(k, { label: r.label, zone_id: r.zone_id ?? null, items: [] });
    groups.get(k)!.items.push(r);
  }

  const cards: Row[] = [];
  for (const sev of ranked) {
    const label = sev.label as string;
    if (sev.grade === "low" && !(sev.safety_w > 1)) continue;     // 노출 조건: mid 이상 또는 안전
    for (const g of groups.values()) {
      if (g.label === label) cards.push(_card(sev, g.zone_id, g.items, win, ref, zone_names, actions[label] ?? null));
    }
  }

  // 같은 구역의 다른 문제 수 (구역 미상은 위치가 아니므로 세지 않는다)
  const per_zone = new Map<number, number>();
  for (const c of cards) {
    if (c.zone_id !== null) per_zone.set(c.zone_id, (per_zone.get(c.zone_id) ?? 0) + 1);
  }
  for (const c of cards) c.same_zone_others = c.zone_id !== null ? per_zone.get(c.zone_id)! - 1 : 0;

  cards.sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));        // 마지막 시각 최신 우선 (동점 처리)
  cards.sort((a, b) =>
    (GROUP_ORDER[a.raw_group] - GROUP_ORDER[b.raw_group]) ||
    (GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade]) ||
    (b.is_safety - a.is_safety) ||
    (b.card_score - a.card_score));
  let main_seen = 0;
  cards.forEach((c, idx) => {
    c.rank_no = idx + 1;
    if (c.raw_group === "main") {
      main_seen += 1;
      c.grp = main_seen <= MAIN_MAX ? "main" : "more";
    } else {
      c.grp = c.raw_group;
    }
  });
  return cards;
}

function _card(sev: Row, zone_id: number | null, items: Row[], win: number, ref: Date,
               zone_names: Map<number, string>, act: Row | null): Row {
  const label = sev.label as string;
  const fz = items.length;
  const fl = sev.freq as number;
  const S = sev.score as number;
  const C = zone_id === null ? 0.5 : 0.5 + 0.5 * (fl ? fz / fl : 0.0);
  const ordered = [...items].sort((a, b) => {
    const pa = a.posted_at || "";
    const pb = b.posted_at || "";
    return pa < pb ? 1 : pa > pb ? -1 : b.feedback_id - a.feedback_id;
  });
  const last_at: string = ordered[0].posted_at || "";
  let elapsed: number;
  try {
    elapsed = Math.max((ref.getTime() - fromisoformat(last_at).getTime()) / 1000 / 60.0, 0.0);
  } catch {
    elapsed = Number(win);
  }
  const R = 1.0 - 0.5 * Math.min(elapsed / win, 1.0);
  const P = round(S * C * R, 1);
  let zone_name = zone_id !== null ? zone_names.get(zone_id) : null;
  zone_name = zone_name || config.ZONE_UNKNOWN;
  const conc_note = zone_id === null ? "구역 미상 고정" : `${fz}/${fl}건`;
  const formula = `유형 ${fixed(S, 1)} × 집중 ${fixed(C, 2)}(${conc_note}) × 최근 ${fixed(R, 2)}` +
    `(${Math.trunc(elapsed)}분 전/창 ${win}분) = ${fixed(P, 1)}`;

  // 조치 그룹 — 조치 상태는 1차에서 유형 단위 요청서 상태를 쓴다
  const status: string | null = act ? act.status : null;
  let recurred = false;
  let new_since = false;
  let raw_group = "main";
  if (status === "in_progress") {
    // 유형 단위 요청서라 다른 구역에서 새로 생긴 같은 유형 카드도 '조치 중'으로 접히는 문제:
    // 이 카드의 민원이 전부 요청서를 만든 뒤에 들어왔으면 본 목록에 두고 '요청서 이후 새 구역'을 표시한다.
    let first_in = "";
    if (items.length) first_in = items.map((i) => i.ingested_at || "").reduce((m, x) => (x < m ? x : m));
    new_since = Boolean(act!.created_at) && first_in > act!.created_at;
    raw_group = new_since ? "main" : "in_progress";
  } else if (status === "done") {
    const closed = act!.closed_at || act!.created_at || "";
    recurred = items.some((i) => (i.ingested_at || "") > closed);        // 적재 시각(실제 시계)으로 비교
    raw_group = recurred ? "main" : "done";
  }

  const [dept, contact] = config.DEPARTMENT_MAP[label] ?? ["미지정", "-"];
  // 지시문 형태 민원("AI 에게: … 조치에 넣어라")은 근거 후보에서 빼고 맨 뒤로 보낸다. 근거로 인정하면 공격 원문에 적힌
  // 시설명·조치가 그대로 통과하기 때문이다. 원문 복사 검사에는 계속 쓰인다 (injection=true).
  const bad = ordered.filter((i) => privacy.looks_like_injection(i.raw_text || ""));
  const ok = ordered.filter((i) => !privacy.looks_like_injection(i.raw_text || ""));
  const cands: Row[] = ok.slice(0, CANDIDATES).map((i) => ({ id: i.feedback_id, text: i.raw_text, posted_at: i.posted_at, injection: false }));
  cands.push(...bad.slice(0, INJECTED_KEEP).map((i) => ({ id: i.feedback_id, text: i.raw_text, posted_at: i.posted_at, injection: true })));
  // 최신 민원 표시에도 지시문 형태는 뺀다 (지시문뿐인 카드만 그대로 보여 준다)
  const clean = cands.filter((c) => !c.injection).slice(0, LATEST_SHOWN);
  const shown = (clean.length ? clean : cands.slice(0, LATEST_SHOWN)).map((c) => ({ id: c.id, text: c.text, posted_at: c.posted_at }));
  return {
    key: issue_key(label, zone_id), label, zone_id, zone_name,
    grade: sev.grade, is_safety: Number(sev.safety_w > 1), type_score: S,
    conc: round(C, 2), rec: round(R, 2), card_score: P, formula,
    freq: fz, type_freq: fl, last_at, same_zone_others: 0,
    recurred: Number(recurred), new_since_request: Number(new_since), raw_group,
    action_status: status || "none", action_request_id: act ? act.id : null,
    department: dept, contact,
    signature: `${label}|${_zone_key(zone_id)}|${sev.grade}|${raw_group}`,
    member_ids: items.map((i) => i.feedback_id),
    candidates: cands, latest_quotes: _dumps(shown),
    rank_no: 0, grp: raw_group,
  };
}

// ── 문장: 템플릿 · 결정적 검사 ──

/** 프롬프트의 '참고 예시'이자 템플릿 조치의 재료. 고르도록 강제하지 않는다. */
export function catalog_examples(label: string): string[] {
  return [...(config.ACTION_CATALOG[label] ?? [])];
}

/** 중단·폐쇄·대피 같은 고위험 표현은 안전 유형 카드이면서 즉시 등급일 때만 허용. */
export function escalation_allowed(card: Row): boolean {
  return Boolean(card.is_safety) && card.grade === "immediate";
}

/** 고위험 표현이 든 것. 공백은 무시하고 비교한다 ('진입  통제' 도 잡는다). '통제선' 같은 평범한 말은 잡지 않는다. */
export function escalation_hits(text: string): string[] {
  const flat = _flat(text);
  return config.ESCALATION_WORDS.filter((w) => flat.includes(_flat(w)));
}

/** AI 문장이 없거나 검사에 실패한 카드의 기본 문장. 제목 '{구역} — {유형} 민원', 조치는 참고 예시 앞 2개, 근거는 가장 최근 민원 1건. */
export function template_entry(card: Row): Row {
  const label_ko = config.LABELS[card.label] ?? card.label;
  const ok = escalation_allowed(card);
  let acts = catalog_examples(card.label).filter((a) => ok || !escalation_hits(a).length).slice(0, 2);
  if (!acts.length) acts = ["담당 부서 현장 확인 후 조치 방안 수립"];
  const usable = _usable(card);
  const qid = usable.length ? usable[0].id : card.candidates[0].id;
  return { issue_key: card.key, title: `${card.zone_name} — ${label_ko} 민원`, actions: acts.map((a) => ({ text: a, quote_id: qid })) };
}

/** 근거로 쓸 수 있는 후보 — 지시문 형태 민원은 제외. */
function _usable(card: Row): Row[] {
  return card.candidates.filter((c: Row) => !c.injection);
}

function _as_int(v: unknown): number | null {
  if (typeof v === "boolean") return Number(v);
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

function _flat(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, "");
}

/** a 와 b 가 공백을 뺀 채 연속 n자 이상 같은가. */
function _shares_run(a: string, b: string, n = COPY_RUN): boolean {
  const fa = _flat(a);
  const fb = _flat(b);
  if (fa.length < n) return false;
  for (let i = 0; i <= fa.length - n; i++) {
    if (fb.includes(fa.slice(i, i + n))) return true;
  }
  return false;
}

// 사람이 읽는 문장에 점수가 새지 않게 막는 표현: '60.0점' · '점수' · 영어 등급 · 계산식 기호. 건수(숫자+건)는 허용한다.
export const SCORE_LEAK = /\d+(?:\.\d+)?\s*점(?!검)|점수|\b(?:immediate|high|mid|low)\b|×|formula|계산식/i;

/** 사람이 읽는 문장(브리핑·알림·카드)에 점수·영어 등급·계산식이 있으면 그 표현, 없으면 null. */
export function score_leak(text: string | null | undefined): string | null {
  const m = SCORE_LEAK.exec(text ?? "");
  return m ? m[0] : null;
}

const py_repr = (v: unknown): string => (typeof v === "string" ? `'${v}'` : v === null || v === undefined ? "None" : String(v));

/**
 * AI 가 만든 카드 문장을 저장 전에 결정적으로 검사한다. [오류 목록, 정리된 문장]. 오류가 없으면 통과.
 *
 * ① 조치마다 quote_id 1개, 이 카드의 근거 후보 안에 있어야 함
 * ② 조치는 2~4개, 각 50자 이하. title 은 2~40자
 * ③ 숫자 없음 + 점수·영어 등급·계산식 표현 없음 (title·조치. 한글 수사+단위 포함, 긴급 전화 119·112 는 예외), title 에 다른 구역 이름 없음
 * ④ title·조치의 장소·시설 단어(config.PLACE_WORDS)는 이 카드의 근거 민원 원문(후보 전체)이나 구역 이름에 있어야 함
 * ⑤ 조치가 근거 민원 원문과 연속 12자 이상 같으면 거부
 * ⑥ 고위험 표현: 안전 유형 + 즉시 등급 카드에서만 허용하고 needs_judgment=1. 그 밖의 카드에서는 그 조치만 뺀다
 */
export function check_entry(card: Row, entry: unknown): [string[], Row] {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [["문장을 주지 않음"], {}];
  const e = entry as Row;
  const errs: string[] = [];
  const pool = _usable(card);                          // 지시문 형태 민원은 근거도, 장소 단어의 출처도 아니다
  const cand = new Map<number, Row>(pool.map((c) => [c.id as number, c]));
  const zone = card.zone_name as string;
  const all_text = pool.map((c) => c.text || "").join(" ") + " " + zone;
  if (!pool.length) errs.push("근거로 쓸 수 있는 민원이 없음 (지시문 형태 민원뿐)");

  const grounded = (word: string): boolean =>
    all_text.includes(word) || (config.PLACE_ALIASES[word] ?? []).some((a) => all_text.includes(a));

  const title = typeof e.title === "string" ? e.title.trim() : "";
  if (!(title.length >= 2 && title.length <= TITLE_MAX)) errs.push(`title 은 2~${TITLE_MAX}자여야 함 (지금 ${title.length}자)`);
  if (/\d/.test(title) || NUMBER_WORDS.search(title)) errs.push("title 에 숫자(한글 수사 포함)가 있음");
  if (score_leak(title)) errs.push(`title 에 점수·영어 등급 표현 '${score_leak(title)}' 이 있음 (점수는 사람에게 보이지 않는다)`);
  for (const z of config.ZONES) {                      // 다른 구역 이름 금지
    if (z !== zone && title.includes(z)) errs.push(`title 에 다른 구역 이름 '${z}' 이 있음`);
  }
  for (const w of config.PLACE_WORDS) {
    if (title.includes(w) && !grounded(w)) errs.push(`title 의 '${w}' 가 근거 민원·구역 이름에 없음 (지어낸 장소·시설 의심)`);
  }
  if (escalation_hits(title).length && !escalation_allowed(card)) {
    errs.push(`title 에 고위험 표현 ${py_list(escalation_hits(title))} (안전·즉시 카드만 허용)`);
  }

  let raw: unknown = e.actions;
  if (!Array.isArray(raw) || raw.length > ACTION_MAX) {
    errs.push(`actions 는 ${ACTION_MIN}~${ACTION_MAX}개 목록이어야 함`);
    raw = Array.isArray(raw) ? raw.slice(0, ACTION_MAX) : [];
  }
  const kept: Row[] = [];
  let judged = 0;
  const dropped: string[] = [];
  for (const a of raw as unknown[]) {
    if (a === null || typeof a !== "object" || Array.isArray(a)) {
      errs.push("조치는 {text, quote_id} 형식이어야 함");
      continue;
    }
    const ar = a as Row;
    const text = typeof ar.text === "string" ? ar.text.trim() : "";
    const qid = _as_int(ar.quote_id);
    if (!text || text.length > ACTION_LEN) {
      errs.push(`조치 문장은 1~${ACTION_LEN}자여야 함: ${text.slice(0, 15)}…`);
      continue;
    }
    if (qid === null || !cand.has(qid)) {
      errs.push(`조치 '${text.slice(0, 12)}…' 의 quote_id ${py_repr(ar.quote_id)} 가 근거 후보 ${py_list([...cand.keys()].sort((x, y) => x - y))} 밖에 있음`);
      continue;
    }
    if (/\d/.test(text.replace(/119|112/g, "")) || NUMBER_WORDS.search(text)) {
      errs.push(`조치 문장에 숫자(한글 수사 포함)가 있음: ${text.slice(0, 15)}…`);
      continue;
    }
    if (score_leak(text)) {
      errs.push(`조치 문장에 점수·영어 등급 표현 '${score_leak(text)}' 이 있음: ${text.slice(0, 15)}…`);
      continue;
    }
    const bad = config.PLACE_WORDS.filter((w) => text.includes(w) && !grounded(w));
    if (bad.length) {
      errs.push(`조치 '${text.slice(0, 12)}…' 의 ${py_list(bad)} 가 이 카드의 근거 민원·구역 이름에 없음 (지어낸 장소·시설 의심)`);
      continue;
    }
    if (card.candidates.some((c: Row) => _shares_run(text, c.text))) {      // 지시문 민원도 포함해서 본다
      errs.push(`조치 '${text.slice(0, 12)}…' 가 민원 원문과 연속 ${COPY_RUN}자 이상 같음 (원문을 옮겨 적음)`);
      continue;
    }
    if (escalation_hits(text).length) {
      if (escalation_allowed(card)) {
        judged = 1;
      } else {
        dropped.push(text);
        continue;                                      // 허용되지 않는 카드 — 그 조치만 뺀다
      }
    }
    kept.push({ text, quote_id: qid });
  }
  if (kept.length < ACTION_MIN) {
    errs.push(`통과한 조치가 ${kept.length}개뿐 (2개 이상 필요)` + (dropped.length ? `, 고위험 표현으로 뺀 조치 ${dropped.length}개` : ""));
  }
  return [errs, { title, actions: kept, needs_judgment: judged, dropped }];
}

/** Python 리스트 repr — 오류 문구가 Python 과 글자까지 같게 */
function py_list(a: unknown[]): string {
  return "[" + a.map(py_repr).join(", ") + "]";
}

/** 조치가 인용한 민원 (중복 없이, 조치 순서대로). 스냅샷이라 문구를 다시 쓸 때만 바뀐다. */
function _evidence(card: Row, actions: Row[]): Row[] {
  const cand = new Map<number, Row>(card.candidates.map((c: Row) => [c.id as number, c]));
  const seen = new Map<number, Row>();
  for (const a of actions) {
    const q = cand.get(a.quote_id);
    if (q && !seen.has(q.id)) seen.set(q.id, { id: q.id, text: q.text, posted_at: q.posted_at });
  }
  return [...seen.values()];
}

function _text_columns(card: Row, cleaned: Row, source: string): Row {
  const acts = cleaned.actions.map((a: Row) => ({ text: a.text, quote_id: a.quote_id, source }));
  return {
    title: cleaned.title, actions: _dumps(acts),
    evidence_quotes: _dumps(_evidence(card, cleaned.actions)),
    needs_judgment: Number(cleaned.needs_judgment ?? 0),
  };
}

/** 문구가 실제로 같은가 — 제목과 조치 문장만 본다 (근거·시각은 제외). */
function _same_text(old: Row, neu: Row): boolean {
  const texts = (s: string | null | undefined): string[] => {
    try {
      return JSON.parse(s || "[]").map((a: Row) => a.text);
    } catch {
      return [];
    }
  };
  const a = texts(old.actions);
  const b = texts(neu.actions);
  return old.title === neu.title && a.length === b.length && a.every((x, i) => x === b[i]);
}

// ── 저장 ──

function _computed_values(c: Row): unknown[] {
  return _COMPUTED.map((k) => c[k]);
}

/**
 * 카드를 다시 계산해 issue 테이블에 반영한다. [바뀐 행 수, 카드 목록].
 * 새 카드는 템플릿 문장으로 넣는다. 계산 열(건수·마지막 시각·최신 민원 포함)만 갱신하고,
 * AI 문장(title·actions·evidence_quotes)은 text_source 가 'template' 인 행만 다시 쓴다. 값이 그대로면 쓰지 않는다.
 */
export async function refresh(window_min: number | null = null): Promise<[number, Row[]]> {
  const cards = await build_cards(window_min);
  const now = db.now();
  let changed = 0;
  const cols = _COMPUTED.join(", ");
  const marks = _COMPUTED.map(() => "?").join(",");
  const conn = await db.connect();
  const rows = new Map<string, Row>((await conn.execute("SELECT * FROM issue")).fetchall().map((r) => [r.issue_key as string, { ...r }]));
  const deleted_ids = new Set<number>((await conn.execute("SELECT id FROM feedback WHERE deleted_at IS NOT NULL")).fetchall().map((r) => r.id as number));
  for (const c of cards) {
    const old = rows.get(c.key);
    const tpl = _text_columns(c, template_entry(c), "template");
    if (old === undefined) {
      await conn.execute(
        `INSERT OR IGNORE INTO issue (festival_id, issue_key, active, updated_at,
           title, actions, evidence_quotes, needs_judgment, text_source, fail_count,
           gen_max_id, text_updated_at, ${cols})
         VALUES (?,?,1,?,?,?,?,?,'template',0,0,?,${marks})`,
        [await db.festival_id(), c.key, now, tpl.title, tpl.actions, tpl.evidence_quotes, tpl.needs_judgment, now, ..._computed_values(c)]);
      changed += 1;
      continue;
    }
    let touched = false;
    const cv = _computed_values(c);
    if (!(old.active === 1 && _COMPUTED.every((k, i) => old[k] === cv[i] || (old[k] === null && cv[i] === null)))) {
      await conn.execute(`UPDATE issue SET ${_COMPUTED.map((k) => `${k}=?`).join(", ")}, active=1, updated_at=? WHERE issue_key=?`,
        [...cv, now, c.key]);
      touched = true;
    }
    // 문장 열은 ④ 가 같은 때 쓸 수 있다. 읽은 값 그대로일 때만 덮어써서 서로의 쓰기를 지우지 않는다.
    if (old.text_source !== "template" && deleted_ids.size) {
      // 운영자가 지운 민원은 문구의 근거 인용에서도 바로 뺀다 (문구는 다음 재생성 때 고친다)
      let ev: Row[];
      try {
        ev = JSON.parse(old.evidence_quotes || "[]");
      } catch {
        ev = [];
      }
      const kept = ev.filter((e) => !deleted_ids.has(e.id));
      if (kept.length !== ev.length) {
        await conn.execute("UPDATE issue SET evidence_quotes=?, updated_at=? WHERE issue_key=? AND evidence_quotes=?",
          [_dumps(kept), now, c.key, old.evidence_quotes]);
        touched = true;
      }
    }
    if (old.text_source === "template" && Object.keys(tpl).some((k) => old[k] !== tpl[k])) {
      const sets = Object.keys(tpl).map((k) => `${k}=?`);
      const vals: unknown[] = Object.values(tpl);
      if (!_same_text(old, tpl)) {
        sets.push("text_updated_at=?");
        vals.push(now);
      }
      await conn.execute(`UPDATE issue SET ${sets.join(", ")}, updated_at=? WHERE issue_key=? AND text_source='template'`,
        [...vals, now, c.key]);
      touched = true;
    }
    if (touched) changed += 1;
  }
  const live = new Set(cards.map((c) => c.key));
  for (const [k, r] of rows) {
    if (r.active === 1 && !live.has(k)) {        // 창 밖으로 나간 카드 — 문장은 남긴다
      await conn.execute("UPDATE issue SET active=0, updated_at=? WHERE issue_key=?", [now, k]);
      changed += 1;
    }
  }
  await conn.commit();
  return [changed, cards];
}

export async function stored(): Promise<Record<string, Row>> {
  const conn = await db.connect();
  const out: Record<string, Row> = {};
  for (const r of (await conn.execute("SELECT * FROM issue")).fetchall()) out[r.issue_key] = { ...r };
  return out;
}

function _age_sec(ts: string | null | undefined, now: Date): number {
  try {
    return (now.getTime() - fromisoformat(ts as string).getTime()) / 1000;
  } catch {
    return Infinity;
  }
}

/**
 * 이 카드의 문장을 AI 가 (다시) 만들어야 하는가.
 * ① 새 카드이거나 서명(유형·구역·등급·조치 그룹)이 바뀜 → 간격과 상관없이 바로
 * ② 마지막 생성 뒤 CARD_TEXT_MIN_INTERVAL 초가 지났고, 새 민원이 들어왔거나 저장한 근거가 창 밖으로 나감
 * ③ 템플릿으로 떨어진 카드는 MAX_FAIL 번까지만, 같은 간격으로 다시 시도
 */
export function needs_text(card: Row, row: Row | null | undefined, now: Date | null = null): boolean {
  if (!row || row.gen_signature !== card.signature) return true;
  if (_age_sec(row.gen_at, now ?? new Date()) < config.CARD_TEXT_MIN_INTERVAL) return false;
  if (row.text_source === "template") return (row.fail_count || 0) < MAX_FAIL;
  const max_id = card.member_ids.length ? Math.max(...card.member_ids) : 0;
  if (max_id > (row.gen_max_id || 0)) return true;
  let quote_ids: Set<number>;
  try {
    quote_ids = new Set(JSON.parse(row.evidence_quotes || "[]").map((q: Row) => q.id));
  } catch {
    quote_ids = new Set();
  }
  const members = new Set<number>(card.member_ids);
  return ![...quote_ids].every((q) => members.has(q));
}

/** ④ 호출 전 계획. 카드를 새로 계산·저장하고 상위 TOP_N 중 문장을 만들 카드를 고른다. */
export async function plan(window_min: number | null = null): Promise<Row> {
  const [, cards] = await refresh(window_min);
  const top = cards.slice(0, TOP_N);
  const rows = await stored();
  const now = new Date();
  const need = top.filter((c) => needs_text(c, rows[c.key], now));
  return { cards, top, need, sig: top.map((c) => c.signature).join("||"), rows };
}

/**
 * ④ 가 준 카드 문장을 검사해 저장한다. 문장이 필요한 카드(plan 의 need)만 받는다.
 * source='llm'   검사에 실패했거나 문장을 주지 않은 카드는 템플릿으로 저장하고 agent_log 에 사유를 남긴다.
 * source='local' 규칙 기반 대역 — 템플릿 문장을 그대로 저장한다 (검사 대상 아님).
 */
export async function apply_entries(entries: unknown, source = "llm", window_min: number | null = null): Promise<Row> {
  const p = await plan(window_min);
  const list = Array.isArray(entries) ? entries : [];
  const by_key = new Map<string, Row>();
  for (const e of list) {
    if (e !== null && typeof e === "object" && !Array.isArray(e)) by_key.set((e as Row).issue_key, e as Row);
  }
  const need_keys = new Set<string>(p.need.map((c: Row) => c.key));
  const out: Row = { saved: 0, template: 0, ignored: [...by_key.keys()].filter((k) => !need_keys.has(k)).map(String).sort(), errors: {} as Record<string, string[]> };
  const now = db.now();
  const conn = await db.connect();
  for (const c of p.need as Row[]) {
    const old: Row = p.rows[c.key] ?? {};
    let errs: string[] = [];
    let cleaned: Row;
    let src: string;
    if (source === "local") {
      cleaned = template_entry(c);
      src = "local";
      cleaned.needs_judgment = Number(cleaned.actions.some((a: Row) => escalation_hits(a.text).length));
    } else {
      [errs, cleaned] = check_entry(c, by_key.get(c.key));
      src = "llm";
    }
    let fails = 0;
    if (errs.length) {
      cleaned = template_entry(c);
      src = "template";
      cleaned.needs_judgment = Number(cleaned.actions.some((a: Row) => escalation_hits(a.text).length));
      fails = old.gen_signature === c.signature ? (old.fail_count || 0) + 1 : 1;
      out.template += 1;
      out.errors[c.key] = errs;
    } else {
      out.saved += 1;
    }
    const cols = _text_columns(c, cleaned, src);
    const sets = [...Object.keys(cols).map((k) => `${k}=?`), "text_source=?", "gen_signature=?", "gen_max_id=?", "gen_at=?", "fail_count=?", "updated_at=?"];
    const max_id = c.member_ids.length ? Math.max(...c.member_ids) : 0;
    const vals: unknown[] = [...Object.values(cols), src, c.signature, max_id, now, fails, now];
    if (!_same_text(old, cols) || !old.text_updated_at) {
      sets.push("text_updated_at=?");
      vals.push(now);
    }
    await conn.execute(`UPDATE issue SET ${sets.join(", ")} WHERE issue_key=?`, [...vals, c.key]);
  }
  await conn.commit();
  for (const [key, errs] of Object.entries(out.errors as Record<string, string[]>)) {
    await db.log_agent("supervisor", "issue_check_failed", key, errs.join("; ").slice(0, 200),
      "결정적 검사 실패 — 템플릿으로 저장, 다음 주기에 다시 시도");
  }
  return out;
}

/** 조치요청서(③)에 넘길 조치 — 그 유형의 관제 카드들에서 AI 가 정리한 조치를 카드 순서대로. 템플릿 카드의 조치는 쓰지 않는다. */
export async function actions_for_label(label: string, limit = ACTION_MAX): Promise<string[]> {
  const out: string[] = [];
  for (const r of await list_active()) {
    if (r.label !== label || !["llm", "local"].includes(r.text_source)) continue;
    try {
      for (const a of JSON.parse(r.actions || "[]")) {
        if (!out.includes(a.text)) out.push(a.text);
      }
    } catch {
      continue;
    }
  }
  return out.slice(0, limit);
}

/** API 용 — 지금 보이는 카드, 화면 순서대로. 표의 열 그대로 (JSON 열은 문자열). */
export async function list_active(): Promise<Row[]> {
  const conn = await db.connect();
  return (await conn.execute("SELECT * FROM issue WHERE active=1 ORDER BY rank_no")).fetchall().map((r) => ({ ...r }));
}
