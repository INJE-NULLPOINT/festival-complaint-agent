// 공개 112 신고 기록의 시간순 재현 엔진 (D5-84). 순수 계산 — DB·모델·시계를 쓰지 않는다.
// 각 신고를 규칙(local) 분류기로 분류한 뒤, 1분 간격으로 '그 시각까지 들어온 신고'만 가지고 등급을 계산한다 (core/severity 와 같은 규칙).
// 실제 에이전트의 분류가 아니라 규칙 대역이므로, 분류 결과를 따로 주면(label·sentiment·is_safety) 그것을 쓴다.
import { config } from "../core/config.ts";
import * as rules from "../core/rules.ts";
import * as severity from "../core/severity.ts";
import { fromisoformat, isoformat, minutes, plus } from "../core/datetime.ts";

type Row = Record<string, any>;
export type Call = { posted_at: string; zone?: string; text: string; label?: string; sentiment?: number; is_safety?: boolean };
export type Moment = { at: string; label: string; grade: string; score: number; freq: number; safety_freq: number; spiked: boolean };
export type Timeline = {
  rows: Row[];
  first_immediate: Record<string, string>;     // 유형 → 처음 immediate 가 된 분 (S-04 또는 생명위험)
  first_s04: Record<string, string>;           // 유형 → 창 전체 안전 N건(S-04)이 채워지고 그 유형에 안전 민원이 있게 된 첫 분
  first_spike: Record<string, string>;         // 유형 → 급증(S-03)이 처음 잡힌 분
  moments: Moment[];                           // 분마다·유형마다 한 줄
};

function to_row(c: Call): Row {
  const r = c.label
    ? { label: c.label, sentiment: c.sentiment ?? rules.SENTIMENT[c.label] ?? -0.5, is_safety: c.is_safety ?? config.SAFETY_LABELS.has(c.label) }
    : rules.classify(c.text);
  return { ...r, raw_text: c.text, posted_at: c.posted_at };
}

/** calls 를 시간순으로 훑는다. 첫 신고 ~ 마지막 신고 + tail_min 분까지 step_min 간격. */
export function timeline(calls: Call[], opts: { window_min?: number; step_min?: number; tail_min?: number } = {}): Timeline {
  const window_min = opts.window_min ?? config.DEFAULT_WINDOW_MIN, step_min = opts.step_min ?? 1, tail_min = opts.tail_min ?? 0;
  const rows = calls.map(to_row).sort((a, b) => String(a.posted_at).localeCompare(String(b.posted_at)));
  const out: Timeline = { rows, first_immediate: {}, first_s04: {}, first_spike: {}, moments: [] };
  if (!rows.length) return out;
  const floor_min = (d: Date): Date => { const x = new Date(d); x.setSeconds(0, 0); return x; };
  const t0 = floor_min(fromisoformat(rows[0].posted_at));
  const t1 = plus(fromisoformat(rows[rows.length - 1].posted_at), minutes(tail_min));
  for (let t = t0; t <= t1; t = plus(t, minutes(step_min))) {
    const end = plus(t, 59_000);                                              // 그 분이 끝나기 전(59초)까지 들어온 신고
    const since = plus(t, -minutes(window_min));
    const win = rows.filter((r) => { const p = fromisoformat(r.posted_at); return p <= end && p > since; });
    const at = isoformat(t).slice(0, 16);
    for (const r of severity.rank_labels(win, null, { ref: end })) {
      out.moments.push({ at, label: r.label, grade: r.grade, score: r.score, freq: r.freq, safety_freq: r.safety_freq, spiked: Boolean(r.spike?.spiked) });
      if (r.grade === "immediate") out.first_immediate[r.label] ??= at;
      if (r.safety_freq > 0 && r.window_safety >= config.SAFETY_THRESHOLD) out.first_s04[r.label] ??= at;
      if (r.spike?.spiked) out.first_spike[r.label] ??= at;
    }
  }
  return out;
}
