// 심각도 계산 — 이 과제의 심장. (core/severity.py 와 1:1)
//
// ★ 여기에는 LLM이 없다. 에이전트는 이 함수를 '도구'로 호출만 한다. 같은 입력 → 항상 같은 점수.
//    계산식 문자열을 함께 돌려주므로 화면에 근거를 그대로 띄울 수 있다.
//
// 규칙 (설계 문서 S-01 ~ S-06)
//   S-01 기본점수 = 윈도우 내 빈도 60% + 부정강도 40%
//   S-02 안전 관련 ×2.0        (안전 = 민원의 is_safety=true 또는 라벨 safety. 혼잡(crowd)이라도 is_safety=false 면 비안전, D5-59)
//   S-03 급증 ×1.5      (최근 15분 유입률 >= 직전 60분 평균 × 2)
//   S-04 안전 N건 이상이면 점수와 무관하게 immediate   (N 은 창 전체의 안전 민원 수 — 유형 건수가 아니다. 혼잡·안전 유형에 갈려 들어온 위험 신고도 합쳐 센다.
//        즉시는 안전 민원이 든 유형에만 붙는다: 안전 민원이 없는 유형은 창 전체 건수가 N 이상이어도 즉시가 되지 않는다)
//   S-05 positive 는 심각도에서 제외
//   S-06 미조치 30분 경과 ×1.2
//
// 경계 규칙 (한가한 창에서 1건이 100점·즉시가 되지 않게)
//   B-01 빈도비 = freq / max(창 전체 건수, MIN_WINDOW_TOTAL)
//   B-02 급증은 최근 구간에 SPIKE_MIN_RECENT(3)건 이상일 때만
//   B-03 비안전 유형이 5건 미만이면 점수를 79.9 로 자른다 (최고 high). formula 끝에 표시
//   B-04 안전 유형은 1건이라도 점수 하한 60 (최소 high)
//
// 즉시(immediate) 규칙 (D5-83) — 세 가지만 즉시가 된다:
//   ① 명시적 생명위험어(압사·질식·쓰러짐·의식 없음·불/화재·물에 빠짐·감전 등, rules.LIFE_DANGER_TERMS)가 든 안전 민원이 1건이라도 있으면 즉시
//   ② 일반 안전 민원이 1~2건이면 높음까지 — 점수를 79.9 로 자른다 (B-03 과 같은 상한, 안전도 하한 60 은 그대로)
//   ③ 창 전체의 안전 민원이 3건 이상이면, 안전 민원이 든 유형은 즉시 (S-04)
import { config } from "./config.ts";
import { fromisoformat, minutes, plus } from "./datetime.ts";
import { fixed, floatstr, round } from "./pyfmt.ts";
import { life_danger } from "./rules.ts";

export type Row = Record<string, any>;

export const GRADE_ORDER: Record<string, number> = { immediate: 0, high: 1, mid: 2, low: 3 };

export function grade_of(score: number): string {
  for (const [cutoff, name] of config.GRADE_CUTOFF) {
    if (score >= cutoff) return name;
  }
  return "low";
}

/** 판정 근거를 말로 — 점수·계산식 없이 등급·건수·가중 이유(안전·급증·미조치)만 (요청서·화면용). */
export function basis_ko(grade: string, freq: number, formula: string): string {
  const why: string[] = [];
  const f = formula || "";
  if (f.includes("안전2.0")) why.push("안전 관련 민원이라 가중치가 적용됐습니다");
  if (f.includes("급증1.5")) why.push("최근 유입이 급증했습니다");
  if (f.includes("미조치1.2")) why.push("조치 없이 일정 시간이 지났습니다");
  const text = `심각도 등급 ${config.GRADE_KO[grade] ?? grade}, 접수 ${freq}건`;
  return text + (why.length ? " — " + why.join(", ") : "") + ".";
}

/**
 * 라벨 1개의 심각도. 결정적 함수 — 무작위성 없음. (키워드 인자 is_safety·spiked·unhandled·safety_freq 는 마지막 객체)
 * safety_freq: S-04 에 세는 안전(is_safety=true) 민원 수 (rank_labels 는 창 전체 값을 준다). 생략하면 is_safety 일 때 freq 전체로 본다 (유형 전체가 안전인 호출).
 */
export function compute_severity(freq: number, avg_sentiment: number, total: number,
                                 opts: { is_safety?: boolean; spiked?: boolean; unhandled?: boolean; safety_freq?: number; life_freq?: number } = {}): Row {
  const { is_safety = false, spiked = false, unhandled = false } = opts;
  const safety_freq = opts.safety_freq ?? (is_safety ? freq : 0);
  const life_freq = opts.life_freq ?? 0;                          // 명시적 생명위험어가 든 안전 민원 수 (D5-83)
  const freq_ratio = freq ? freq / Math.max(total, config.MIN_WINDOW_TOTAL) : 0.0;   // B-01
  const intensity = Math.max(0.0, -avg_sentiment);          // 부정일수록 커짐 (0.0~1.0)

  const base = freq_ratio * config.W_FREQ + intensity * config.W_INTENSITY;   // S-01
  const safety_w = is_safety ? config.W_SAFETY : 1.0;                         // S-02
  const spike_w = spiked ? config.W_SPIKE : 1.0;                              // S-03
  const pending_w = unhandled ? config.W_PENDING : 1.0;                       // S-06

  let score = Math.min(100.0, base * safety_w * spike_w * pending_w);

  let note = "";
  if (is_safety) {
    if (freq >= 1 && score < config.SAFETY_FLOOR) {                           // B-04
      score = config.SAFETY_FLOOR;
      note = ` (안전 → 하한 ${fixed(config.SAFETY_FLOOR, 0)})`;
    }
    if (life_freq < 1 && safety_freq < config.SAFETY_THRESHOLD && score > config.NONSAFETY_CAP) {    // D5-83 ②: 일반 안전 1~2건은 높음까지
      score = config.NONSAFETY_CAP;
      note += ` (안전 ${safety_freq}건 < ${config.SAFETY_THRESHOLD}건 → 상한 ${floatstr(config.NONSAFETY_CAP)})`;
    }
  } else if (freq < config.NONSAFETY_IMMEDIATE_MIN && score > config.NONSAFETY_CAP) {   // B-03
    score = config.NONSAFETY_CAP;
    note = ` (비안전 ${config.NONSAFETY_IMMEDIATE_MIN}건 미만 → 상한 ${floatstr(config.NONSAFETY_CAP)})`;
  }

  if (life_freq >= 1) {                    // D5-83 ①: 생명위험어 1건 → 즉시 (점수도 즉시 구간으로)
    score = Math.max(score, config.GRADE_CUTOFF[0][0]);
    note += " (생명위험 신호 → 즉시)";
  }
  const grade = life_freq >= 1 || (is_safety && safety_freq >= config.SAFETY_THRESHOLD) ? "immediate" : grade_of(score);   // ① 생명위험 / ③ S-04

  const formula =
    `(${fixed(freq_ratio, 2)}×${fixed(config.W_FREQ, 0)} + ${fixed(intensity, 2)}×${fixed(config.W_INTENSITY, 0)})` +
    ` × 안전${floatstr(safety_w)} × 급증${floatstr(spike_w)} × 미조치${floatstr(pending_w)} = ${fixed(score, 1)}${note}`;
  return {
    freq, avg_sentiment: round(avg_sentiment, 3),
    base_score: round(base, 2), safety_w,
    spike_w, pending_w,
    score: round(score, 1), grade, formula,
  };
}

/** 최근 window_min 유입률이 baseline_min 평균의 N배 이상인가. (S-03) 기준 시각(ref)은 민원 발생 시간선을 따른다. */
export function detect_spike(rows: Row[], label: string,
                             opts: { window_min?: number; baseline_min?: number; ref?: Date | null } = {}): Row {
  const window_min = opts.window_min ?? config.SPIKE_WINDOW_MIN;
  const baseline_min = opts.baseline_min ?? config.SPIKE_BASELINE_MIN;
  const nowt = opts.ref ?? new Date();
  const w_cut = plus(nowt, -minutes(window_min));
  const b_cut = plus(nowt, -minutes(baseline_min));

  let recent = 0;
  let base = 0;
  for (const r of rows) {
    if (r.label !== label) continue;
    let t: Date;
    try {
      if (r.posted_at === null || r.posted_at === undefined) continue;
      t = fromisoformat(String(r.posted_at));
    } catch {
      continue;
    }
    if (t >= b_cut) base += 1;
    if (t >= w_cut) recent += 1;
  }

  const rate = recent / window_min;                       // 분당 유입
  const baseline = base ? base / baseline_min : 0.0;
  const spiked = baseline > 0 && rate >= baseline * config.SPIKE_MULTIPLIER && recent >= config.SPIKE_MIN_RECENT;   // B-02
  return {
    label, recent, rate: round(rate, 3),
    baseline: round(baseline, 3),
    multiplier: baseline ? round(rate / baseline, 2) : 0.0,
    spiked: Boolean(spiked),
  };
}

/**
 * 윈도우 행들을 받아 라벨별 심각도를 계산하고 정렬해 돌려준다.
 * rows: db.window_rows() 결과. unhandled_fn: label → bool (S-06, 없으면 전부 false). opts.ref: 기준 시각.
 * 정렬: 등급 → 안전 가중이 붙은 유형 먼저 → 점수.
 */
export function rank_labels(rows: Row[],
                            unhandled_arg: ((label: string) => boolean) | { unhandled_fn?: ((label: string) => boolean) | null; ref?: Date | null } | null = null,
                            opts_arg: { ref?: Date | null } = {}): Row[] {
  // Python rank_labels(rows, unhandled_fn=None, ref=None) — 위치 인자(함수, {ref}) 와 키워드 객체({unhandled_fn, ref}) 둘 다 받는다
  const kw = typeof unhandled_arg === "function" || unhandled_arg === null ? { unhandled_fn: unhandled_arg, ...opts_arg } : unhandled_arg;
  const unhandled_fn = kw.unhandled_fn ?? null;
  const opts = { ref: kw.ref ?? null };
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    if (config.EXCLUDED_FROM_SEVERITY.has(r.label)) continue;   // S-05
    if (!buckets.has(r.label)) buckets.set(r.label, []);
    buckets.get(r.label)!.push(r);
  }

  let total = 0;
  for (const v of buckets.values()) total += v.length;
  const is_safe_item = (i: Row): boolean => Boolean(i.is_safety) || config.SAFETY_LABELS.has(i.label);
  const window_safety = [...buckets.values()].reduce((n, v) => n + v.filter(is_safe_item).length, 0);   // S-04: 창 전체의 안전 민원 수
  const out: Row[] = [];
  for (const [label, items] of buckets) {
    let sum = 0;
    for (const i of items) sum += i.sentiment || 0.0;
    const avg = sum / items.length;
    // 안전 민원 = is_safety=true 이거나 라벨이 safety. 혼잡이어도 is_safety=false(줄이 길다 같은 단순 불편)면 비안전이다 (D5-59).
    const safety_freq = items.filter(is_safe_item).length;
    const is_safety = safety_freq > 0;
    // 명시적 생명위험어가 든 안전 민원 수 (D5-83 ①) — 안전 플래그가 있거나 안전·혼잡 유형인 민원만 센다
    const life_freq = items.filter((i) => (Boolean(i.is_safety) || config.SAFETY_LABELS.has(i.label) || i.label === "crowd") && life_danger(i.raw_text)).length;
    const spike = detect_spike(rows, label, { ref: opts.ref });
    const unhandled = unhandled_fn ? Boolean(unhandled_fn(label)) : false;

    const res = compute_severity(items.length, avg, total, { is_safety: is_safety || life_freq > 0, spiked: spike.spiked, unhandled, safety_freq: safety_freq > 0 ? window_safety : 0, life_freq });
    Object.assign(res, { label, spike, safety_freq, life_freq, window_safety });          // safety_freq: 안전(is_safety) 민원 수 — 알림이 '혼잡 6건(안전 의심 3건)'처럼 쓴다
    out.push(res);
  }

  out.sort((a, b) =>
    (GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade]) ||
    (Number(b.safety_w > 1) - Number(a.safety_w > 1)) ||
    (b.score - a.score));
  return out;
}
