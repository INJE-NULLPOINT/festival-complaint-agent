// ② 심각도·감시 에이전트 (Monitor) — Agent Path. (agents/monitor.py 와 1:1)
//
// 목표: 지금 무엇이 얼마나 심각한지 판정하고 임계 초과를 감지한다.
// ★ 점수는 에이전트가 계산하지 않는다. score_label 도구가 결정적 함수를 부른다.
//   에이전트가 하는 판단은 "어떤 윈도우를 볼지", "무엇을 알림으로 올릴지", "어떻게 설명할지"이다.
import { config } from "../core/config.ts";
import { minutes, isoformat, plus } from "../core/datetime.ts";
import * as db from "../core/db.ts";
import * as issues from "../core/issues.ts";
import { Agent, tool } from "../core/llm.ts";
import { floatstr } from "../core/pyfmt.ts";
import * as review from "../core/review.ts";

export type Row = Record<string, any>;

export const SYSTEM = `너는 지역 축제 운영 관제 시스템의 '심각도 감시 에이전트'다.

역할: 지금 어떤 유형의 민원이 얼마나 심각한지 판정하고, 즉시 대응이 필요한 상황에 알림을 올린다.

절차
1. get_window_stats 로 최근 상황을 파악한다 (기본 윈도우 60분). 급증이 의심되면 더 짧은 윈도우(15~30분)로 한 번 더 확인해도 된다.
2. 유형마다 score_label 을 호출해 점수와 등급을 받는다.
3. save_snapshot 으로 이번 판정을 기록한다.
4. 아래에 해당하는 유형만 raise_alert 로 알린다: 등급이 immediate / 급증(spiked) 감지 / 직전 판정보다 등급 상승.
5. 마지막에 가장 심각한 유형 1개와 그 이유를 두 문장 이내로 보고한다.

반드시 지킬 것
- **점수를 직접 계산하지 마라.** score_label 의 반환값(등급·건수·급증 여부)을 쓴다. 알림 문구에는 점수·계산식을 쓰지 말고
  한글 등급(즉시·높음·보통·낮음)과 건수·이유(안전 관련·급증)만 쓴다. 영어 등급(immediate·high)도 쓰지 마라.
- 건수가 많다고 심각한 것이 아니다. 안전 관련은 건수가 적어도 위로 올라간다. 이 역전이 보이면 알림 문구에 이유를 명시하라.
- 알림을 남발하지 마라. 조건에 맞는 것만 올린다.
`;

export const get_window_stats = tool({
  name: "get_window_stats",
  description: "지정 시간 구간의 유형별 민원 통계를 조회한다.",
  properties: { window_min: { type: "integer", description: "구간(분). 기본 60" } },
  params: ["window_min"],
}, async (window_min: number = config.DEFAULT_WINDOW_MIN): Promise<Row> => {
  const rows = await db.window_rows(window_min);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);          // 안정 정렬 (동점은 입력 순서)
  const korean: Record<string, number> = {};
  for (const [k, v] of sorted) korean[config.LABELS[k] ?? k] = v;
  return {
    window_min,
    total: rows.length,
    counts: korean,
    labels: sorted.map(([k]) => k),
    pending: await db.pending_count(),
  };
});

export const score_label = tool({
  name: "score_label",
  description:
    "유형 1개의 심각도 점수·등급을 계산한다. 검증된 함수가 계산하므로 같은 입력에는 같은 결과가 나온다. " +
    "점수·formula 는 판단용이며 사람에게 보이는 문구에는 쓰지 않는다.",
  properties: {
    label: { type: "string", enum: Object.keys(config.LABELS) },
    window_min: { type: "integer", description: "구간(분). 기본 60" },
  },
  required: ["label"],
  params: ["label", "window_min"],
}, async (label: string, window_min: number = config.DEFAULT_WINDOW_MIN): Promise<Row> => {
  const ranked = await db.ranked(window_min);
  for (const r of ranked) {
    if (r.label === label) {
      return {
        label, korean: config.LABELS[label] ?? label,
        freq: r.freq, score: r.score, grade: r.grade,
        formula: r.formula, spiked: r.spike.spiked,
        spike_multiplier: r.spike.multiplier,
      };
    }
  }
  return { label, freq: 0, score: 0.0, grade: "low", formula: "해당 구간에 데이터 없음", spiked: false };
});

export const save_snapshot = tool({
  name: "save_snapshot",
  description: "현재 구간의 전체 심각도 판정을 기록한다 (추이의 원천). 같은 판정이 이미 있으면 다시 쓰지 않는다.",
  properties: { window_min: { type: "integer" } },
  params: ["window_min"],
}, async (window_min: number = config.DEFAULT_WINDOW_MIN): Promise<Row> => {
  const ranked = await db.ranked(window_min);
  const window = `${window_min}min`;
  const already = ranked.length > 0 && (await db.severity_recorded(ranked, window));
  if (ranked.length && !already) await db.save_severity(ranked, window);
  return {
    saved: already ? 0 : ranked.length, already_recorded: already,
    top: ranked.length ? ranked[0].label : null,
    top_score: ranked.length ? ranked[0].score : 0.0,
  };
});

export const raise_alert = tool({
  name: "raise_alert",
  description: "운영자에게 알림을 올린다. 조건에 맞는 경우에만 호출한다.",
  properties: {
    label: { type: "string", enum: Object.keys(config.LABELS) },
    kind: { type: "string", enum: ["spike", "safety_threshold", "grade_up"] },
    detail: { type: "string", description: "운영자가 읽을 한 문장. 근거를 포함할 것" },
  },
  required: ["label", "kind", "detail"],
  params: ["label", "kind", "detail"],
}, async (label: string, kind: string, detail: string): Promise<Row> => {
  const leak = issues.score_leak(detail);
  if (leak) {
    throw new Error(`알림 문구에 점수·영어 등급 표현 '${leak}' 이 있다. 점수는 사람에게 보이지 않는다 — ` +
      "한글 등급과 건수·이유로만 다시 써서 호출하라");
  }
  // 같은 유형·종류의 알림이 10분 내에 이미 있으면 중복으로 보고 건너뛴다
  const cutoff = isoformat(plus(new Date(), -minutes(10)));
  const conn = await db.connect();
  const dup = (await conn.execute("SELECT id FROM alert WHERE label=? AND kind=? AND created_at >= ?", [label, kind, cutoff])).fetchone();
  if (dup) return { skipped: true, reason: "10분 내 동일 알림 존재" };
  return { alert_id: await db.raise_alert(label, kind, detail) };
});

/** 알림 문구의 이유 — 계산식 대신 말로 (안전 관련 가중·급증). */
function _why(s: Row): string {
  const bits: string[] = [];
  if ((s.formula || "").includes("안전2.0")) bits.push("안전 관련이라 가중치가 적용됐습니다");
  if (s.spiked && s.grade === "immediate") bits.push("최근 유입이 급증했습니다");
  return bits.length ? " " + bits.join(", ") + "." : "";
}

/** local 대역 — 모든 유형을 점수화하고 규칙대로 알림을 올린다. 제출본 아님. */
async function local_run(agent: Agent, _user_input: string, ctx: Row): Promise<string> {
  const win = ctx.window_min ?? config.DEFAULT_WINDOW_MIN;

  const stats: Row = await agent.call("get_window_stats", { window_min: win });
  if (!stats.labels.length) return "판정할 데이터가 없습니다.";

  const scored: Row[] = [];
  for (const l of stats.labels) scored.push(await agent.call("score_label", { label: l, window_min: win }));
  await agent.call("save_snapshot", { window_min: win });

  let raised = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    const korean = s.korean ?? s.label;
    if (s.grade === "immediate") {
      await agent.call("raise_alert", { label: s.label, kind: "safety_threshold", detail: `${korean} ${s.freq}건 — 즉시 조치 등급입니다.` + _why(s) });
      raised += 1;
    } else if (s.spiked) {
      await agent.call("raise_alert", {
        label: s.label, kind: "spike",
        detail: `${korean} ${s.freq}건 — 최근 유입이 급증했습니다 (${floatstr(s.spike_multiplier)}배).` + _why(s),
      });
      raised += 1;
    }
  }

  let top = scored[0];
  for (const s of scored) if (s.score > top.score) top = s;
  return `최우선 ${top.korean ?? top.label} (${config.GRADE_KO[top.grade] ?? top.grade}, ${top.freq}건) · 알림 ${raised}건 (local 대역)`;
}

export const monitor = new Agent({
  name: "monitor",
  system: SYSTEM,
  tools: [get_window_stats, score_label, save_snapshot, raise_alert],
  max_steps: 12,
  local: local_run,
});

export async function run_once(window_min: number = config.DEFAULT_WINDOW_MIN): Promise<string> {
  await review.raise_stale_alerts();            // 방치된 안전 의심 '확인 필요' 알림 (같은 민원은 한 번만)
  if (!Object.keys(await db.label_counts()).length) return "";
  return monitor.run(
    `최근 ${window_min}분 구간의 민원 상황을 판정하고, 즉시 대응이 필요한 유형이 있으면 알림을 올려줘.`,
    { window_min },
  );
}
