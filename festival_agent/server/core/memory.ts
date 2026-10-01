// 분류 기억 — 과거에 비슷한 민원을 어떻게 분류했는지(특히 운영자가 고친 유형)를 찾아 다음 분류에 반영한다. (신규, D5-66)
//
// 왜: 심사 지적 — lookup_similar 호출이 0회였다(모델이 스스로 안 불렀다). 그래서 코드가 애매한 민원에 대해 먼저 조회해서
//   ① 프롬프트에 '비슷한 과거 사례'로 넣어 주고(get_pending·prefetch),  ② 거의 같은 글이면 LLM 없이 바로 반영하고(apply_memory),
//   ③ local 대역은 애매한 민원에서 조회 결과를 실제로 채택한다.  조회는 agent_log 에 lookup_similar / memory_hit 로 남는다.
// 기억의 출처: classification 중 status='done' — 운영자가 지정한 것(decided_by='operator')이 가장 강하고, 모델이 확신(0.7 이상)한 것이 그다음.
//   (classify_cache 는 글자 그대로 같을 때만 맞는 정확 일치 캐시라 그대로 둔다 — 여기는 '비슷한' 글을 찾는다.)
// 유사도: 한글·영숫자만 남긴 글자 2-gram 의 Dice 계수 (0~1). 형태소 분석 없이도 '쓰레기통이 가득 찼어요' ~ '쓰레기통이 넘쳐요' 가 잡힌다.
import { config } from "./config.ts";
import * as db from "./db.ts";
import * as privacy from "./privacy.ts";
import * as rules from "./rules.ts";

export type Row = Record<string, any>;

export const SIM_CONSULT = 0.3;        // 운영자가 지정한 사례를 '참고'로 내놓는 최소 유사도 (애매한 민원에서만 쓴다)
export const SIM_MODEL = 0.5;          // 모델이 분류한 사례는 더 비슷해야 내놓는다
// LLM 없이 그대로 반영하는 것(직접 반영)은 '기호·공백·대소문자만 다른 사실상 같은 글'뿐이다 (norm 이 같을 때, D5-72).
// 유사도 문턱으로는 하지 않는다 — 기준 사례 뒤에 '불났어요' 같은 위험 내용을 붙인 글이 문턱을 넘어 안전 민원이 놓쳤다 (0.79~0.87).
const OPERATOR_BONUS = 0.25;           // 같은 유사도면 운영자 사례를 앞에 둔다
const MODEL_MIN_CONFIDENCE = 0.7;
const POOL = 400;                      // 비교할 과거 사례 수 (운영자 사례 먼저, 그다음 최근 순)

export interface Case {
  feedback_id: number; raw_text: string; label: string; sentiment: number; is_safety: number; confidence: number;
  by: "operator" | "model"; similarity: number;
}

/** 한글·영숫자만 남긴 소문자. 공백·기호·느낌표 차이는 같은 글로 본다. */
export function norm(text: string): string {
  return String(text ?? "").toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < s.length; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/**
 * 글자 2-gram Dice 계수 × 길이 비율. 한쪽에만 내용이 더 붙어 있으면(길이가 다르면) 그만큼 깎인다 — 앞을 그대로 두고 뒤에 내용을 붙여도
 * 유사도가 올라가지 않게 (D5-72). 짧은 검색어(8자 이하)가 통째로 들어 있으면 0.6 이상 ('쓰레기통' 같은 lookup_similar 키워드).
 */
export function similarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const gx = bigrams(x), gy = bigrams(y);
  let inter = 0, nx = 0, ny = 0;
  for (const [g, n] of gx) { nx += n; inter += Math.min(n, gy.get(g) ?? 0); }
  for (const n of gy.values()) ny += n;
  const dice = nx + ny ? (2 * inter) / (nx + ny) : 0;
  const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
  const short = Math.min(x.length, y.length);
  const keyword_hit = short >= 3 && short <= 8 && (x.includes(y) || y.includes(x));
  return keyword_hit ? Math.max(dice * ratio, 0.6) : dice * ratio;
}

// ── LLM 을 건너뛰면 안 되는 글 (D5-72) ──
// 안전·긴급 신호: rules 의 안전 키워드 + 혼잡 위험 키워드 + 아래 긴급 용어. 공백을 뺀 글에서 찾는다. 놓치는 것(거짓 음성)이 비싸고
// 잘못 잡는 것(거짓 양성)은 LLM 호출 1번이 늘 뿐이라 넓게 잡는다.
const URGENT_TERMS = ["불났", "불이났", "불이붙", "불길", "불똥", "파편", "불티", "폭죽이사람", "화재", "연기", "탄내", "타는냄새", "가스", "폭발", "다쳤", "다침", "다칠", "부상",
  "피가나", "피를흘", "피흘", "출혈", "쓰러", "기절", "실신", "의식", "응급", "구급", "119", "112", "경찰", "사고", "추락", "떨어져", "감전", "누전",
  "붕괴", "무너", "깔렸", "끼였", "끼임", "압사", "밀려", "밀치", "넘어", "미끄", "난간", "위험", "흔들", "깨진", "파손", "어두", "깜깜", "조명",
  "술취", "싸움", "폭행", "흉기", "실종", "미아", "잃어버", "헛디",
  // D5-75: 유등축제는 남강 수면에서 열린다 (물) · 전기 설비가 많다 (전선)
  "빠졌", "빠짐", "빠져", "익수", "물에", "떠내려", "구명", "전선", "누전", "스파크", "합선", "감전",
  // D5-86: '큰일 날 것 같아요' 류 — 구절 단위 (띄어쓰기는 norm 이 지운다)
  "큰일날것", "큰일날거", "큰일나겠", "큰일이날"];
const PII_MARK = /\[(?:주민번호|카드번호|연락처|이메일|차량번호)\]/;

/** 글에 안전·긴급 / 지시문(인젝션) / 개인정보 신호가 있으면 그 이름들. 하나라도 있으면 LLM 이 봐야 한다 (직접 반영·과거 사례 채택 금지). */
export function risk_signals(text: string): string[] {
  const out: string[] = [];
  const flat = norm(text);
  const safety = [...new Set([
    ...(rules.KEYWORDS.find(([l]) => l === "safety")?.[1] ?? []).map(norm), ...rules.CROWD_DANGER.map(norm), ...URGENT_TERMS.map(norm),
  ])].filter((k) => k && flat.includes(k));
  if (rules.FIREWORK_DANGER.test(text)) safety.push("불꽃 낙하");           // D5-81: '불꽃이 관람석으로 떨어져요' 같은 구
  if (safety.length) out.push(`안전·긴급(${safety.slice(0, 3).join(",")})`);
  if (privacy.looks_like_injection(text)) out.push("지시문");
  if (PII_MARK.test(text) || privacy.mask(text) !== text) out.push("개인정보");
  return out;
}

/** 비슷한 과거 사례 최대 k 건 (운영자 지정이 우선). 꺼져 있으면(config.MEMORY_ENABLED=false) 빈 목록. */
export async function similar_cases(text: string, k = 3, opts: { exclude_id?: number | null } = {}): Promise<Case[]> {
  if (!config.MEMORY_ENABLED || !norm(text)) return [];
  const conn = await db.connect();
  const rows = (await conn.execute(
    `SELECT c.feedback_id, f.raw_text, c.label, c.sentiment, c.is_safety, c.confidence, c.decided_by
     FROM classification c JOIN feedback f ON f.id = c.feedback_id
     WHERE c.status='done' AND c.label IS NOT NULL AND f.deleted_at IS NULL
       AND (c.decided_by = 'operator' OR c.confidence >= ?)
     ORDER BY CASE WHEN c.decided_by = 'operator' THEN 0 ELSE 1 END, c.feedback_id DESC LIMIT ?`,
    [MODEL_MIN_CONFIDENCE, POOL])).fetchall();
  const out: Case[] = [];
  for (const r of rows) {
    if (opts.exclude_id !== undefined && opts.exclude_id !== null && r.feedback_id === opts.exclude_id) continue;
    const by = r.decided_by === "operator" ? "operator" : "model";
    const sim = similarity(text, r.raw_text);
    if (sim < (by === "operator" ? SIM_CONSULT : SIM_MODEL)) continue;
    out.push({
      feedback_id: r.feedback_id, raw_text: r.raw_text, label: r.label, sentiment: Number(r.sentiment ?? 0),
      is_safety: Number(Boolean(r.is_safety)), confidence: Number(r.confidence ?? 0), by, similarity: Math.round(sim * 100) / 100,
    });
  }
  out.sort((a, b) => (b.similarity + (b.by === "operator" ? OPERATOR_BONUS : 0)) - (a.similarity + (a.by === "operator" ? OPERATOR_BONUS : 0)));
  return out.slice(0, k);
}

/** 사례와 '기호·공백만 다른 같은 글'이고 위험·지시문·개인정보 신호가 없을 때만 LLM 없이 그대로 반영해도 된다. */
export const is_direct = (c: Case, text: string): boolean =>
  norm(text) === norm(c.raw_text) && risk_signals(text).length === 0;

/** 프롬프트용 한 줄 요약 (짧게). */
export function brief(c: Case): string {
  return `${c.by === "operator" ? "운영자 지정" : "모델 분류"} ${c.label} · 유사도 ${c.similarity} · ${JSON.stringify(c.raw_text.slice(0, 40))}`;
}
