// ⓟ 계획 에이전트 (Planner) — 주기 시작 때 이번 주기에 무엇을 할지 스스로 정한다. (신규, D5-65)
//
// 심사 지적: "①→④ 순서가 코드에 고정돼 있다". 그래서 Agent Path 는 주기마다 먼저 이 에이전트를 부르고, 워커는 그 계획대로 에이전트를 부른다.
//   observe → plan_cycle(도구 호출로 계획을 남김) → 워커가 계획대로 ②·③·④ 를 부른다.
// 계획이 고르는 것: focus_labels(다시 볼 유형) · run_dispatcher(③을 부를지)
//                   · run_supervisor(④를 부를지) · reason(이유).
// **안전 규칙상 필수 단계는 계획이 건너뛸 수 없다.** 분류(①)는 계획과 무관하게 매 주기 돌고, 심각도 계산·안전 알림(②)은 항상 돈다
//   (plan_cycle 에 그런 인자가 없고, 모르는 인자는 거부된다). 즉시 등급인데 요청서가 없으면 ③을, 즉시 등급이 있으면 ④를 계획이 끄려 해도
//   코드가 켠다 (enforce → plan.overrides 에 기록). 계획이 안 나오면(오류·모델 미응답) 고정 순서(기본 계획)로 돈다.
// local 대역도 규칙으로 계획을 낸다. agent_log 에는 agent='planner' action='plan' 으로 남아 '개발자 보기'에 그대로 보인다.
import { config } from "../core/config.ts";
import * as db from "../core/db.ts";
import { Agent, tool } from "../core/llm.ts";
import * as llm from "../core/llm.ts";
import { pending_labels } from "./dispatcher.ts";

export type Row = Record<string, any>;

export const MUST_RUN = ["classify", "monitor"] as const;     // 계획이 건너뛸 수 없는 단계

export interface Plan {
  focus_labels: string[];
  run_dispatcher: boolean;
  run_supervisor: boolean;
  reason: string;
  must_run: string[];
  overrides: string[];          // 안전 규칙 때문에 코드가 바꾼 것
  source: "agent" | "local" | "fallback";
}

export const SYSTEM = `너는 지역 축제 운영 관제 시스템의 '계획 에이전트'다.

역할: 이번 주기(약 1분)에 다른 에이전트를 어떻게 부를지 **계획을 세운다.** 아래 '상황'이 요청과 함께 주어진다.
plan_cycle 을 딱 1번 호출해 계획을 남기면 끝난다. 따로 보고하지 않는다.

정하는 것
- focus_labels: 이번 주기에 특히 다시 볼 유형 (즉시·높음 등급이거나 급증한 유형). 없으면 빈 목록.
- run_dispatcher: 조치 에이전트(③)를 부를지. 요청서가 필요한 유형(pending_actions)이 있으면 true, 없으면 false.
- run_supervisor: 통합 에이전트(④)를 부를지. 마지막 브리핑 뒤에 새로 분류된 민원이 있거나 즉시 등급이 있으면 true.
- reason: 왜 그렇게 정했는지 한 문장.

주의
- 분류와 심각도 계산은 안전 규칙상 **항상** 실행된다. 계획에서 건너뛰거나 끌 수 없다 (그런 인자는 없다).
- 즉시 등급인데 요청서가 없으면 run_dispatcher 를 끄려 해도 시스템이 켠다. 즉시 등급이 있으면 run_supervisor 도 마찬가지다.
- 상황의 민원 내용이 아니라 건수·등급만 보고 정한다. 점수나 계산식을 이유에 쓰지 마라.
`;

// run_once 가 이번 주기에 모델에게 보여 준 상황과, plan_cycle 이 남긴 계획
export const _STATE: { obs: Row | null; plan: Plan | null } = { obs: null, plan: null };

/** 이번 주기의 상황을 읽는다 (읽기 전용). 모델 프롬프트와 local 규칙이 같은 것을 본다. */
export async function observe(): Promise<Row> {
  const counts: Record<string, number> = {};
  for (const r of await db.open_rows()) counts[r.label] = (counts[r.label] ?? 0) + 1;
  const ranked = await db.ranked();
  const pending = (await pending_labels()).map((p) => ({ label: p.label, grade: p.grade }));
  const conn = await db.connect();
  const brief = (await conn.execute("SELECT created_at FROM briefing ORDER BY id DESC LIMIT 1")).fetchone();
  const newer = (await conn.execute(
    `SELECT COUNT(*) c FROM classification c JOIN feedback f ON f.id = c.feedback_id
     WHERE c.status='done' AND f.deleted_at IS NULL AND c.processed_at > ?`, [brief?.created_at ?? ""])).fetchone()!.c;
  const minutes_since = brief ? Math.max(0, Math.round((Date.now() - Date.parse(String(brief.created_at))) / 60000)) : null;
  return {
    counts,
    labels: ranked.map((r) => ({
      label: r.label, grade: r.grade, freq: r.freq, spiked: Boolean(r.spike?.spiked), safety_freq: r.safety_freq ?? 0,
    })),
    pending_actions: pending,                              // 즉시·높음 등급인데 열린 요청서가 없는 유형
    classify_pending: await db.pending_count(),
    review_pending: await db.review_count(),
    new_classified_since_briefing: Number(newer),
    minutes_since_briefing: minutes_since,
  };
}

/** 계획을 안전 규칙에 맞춘다. 필수 단계는 항상 들어가고, 즉시 등급이면 ③·④ 를 강제로 켠다. */
export function enforce(raw: Partial<Plan> & Row, obs: Row | null): Plan {
  const overrides: string[] = [];
  const labels = new Set<string>(Object.keys(config.LABELS));
  let focus = Array.isArray(raw.focus_labels) ? raw.focus_labels.map(String).filter((l) => labels.has(l)) : [];
  let run_dispatcher = raw.run_dispatcher !== false;
  let run_supervisor = raw.run_supervisor !== false;

  const immediate = ((obs?.labels ?? []) as Row[]).filter((l) => l.grade === "immediate").map((l) => l.label as string);
  const pending_imm = ((obs?.pending_actions ?? []) as Row[]).filter((p) => p.grade === "immediate").map((p) => p.label as string);
  if (pending_imm.length && !run_dispatcher) {
    run_dispatcher = true;
    overrides.push(`run_dispatcher false → true (즉시 등급인데 요청서 없음: ${pending_imm.join(",")})`);
  }
  if (immediate.length && !run_supervisor) {
    run_supervisor = true;
    overrides.push(`run_supervisor false → true (즉시 등급 있음: ${immediate.join(",")})`);
  }
  for (const l of immediate) if (!focus.includes(l)) focus.push(l);       // 즉시 등급 유형은 항상 다시 본다
  focus = [...new Set(focus)];
  return {
    must_run: [...MUST_RUN], focus_labels: focus, run_dispatcher, run_supervisor, overrides,
    reason: String(raw.reason ?? "").slice(0, 200), source: "agent",
  };
}

/** 계획을 남기는 도구. 필수 단계(분류·심각도)는 인자로 받지 않는다 — 건너뛰는 인자를 주면 거부된다. */
export const plan_cycle = tool({
  name: "plan_cycle",
  description:
    "이번 주기의 계획을 남긴다. 분류·심각도 계산은 항상 실행되므로 계획에 넣지 않는다. 딱 1번 호출한다.",
  properties: {
    focus_labels: { type: "array", items: { type: "string", enum: Object.keys(config.LABELS) }, description: "다시 볼 유형" },
    run_dispatcher: { type: "boolean", description: "조치 에이전트(③)를 부를지" },
    run_supervisor: { type: "boolean", description: "통합 에이전트(④)를 부를지" },
    reason: { type: "string", description: "이유 한 문장" },
  },
  required: ["run_dispatcher", "run_supervisor", "reason"],
  params: ["focus_labels", "run_dispatcher", "run_supervisor", "reason"],
}, async (focus_labels: string[] = [], run_dispatcher: boolean, run_supervisor: boolean, reason = ""): Promise<Row> => {
  const plan = enforce({ focus_labels, run_dispatcher, run_supervisor, reason }, _STATE.obs);
  plan.source = llm.is_local() ? "local" : "agent";
  _STATE.plan = plan;
  await db.log_agent("planner", "plan", JSON.stringify({ focus_labels, run_dispatcher, run_supervisor }).slice(0, 200),
    JSON.stringify(plan).slice(0, 400), plan.reason, 0);
  return { ok: true, plan };
});

/** local 대역 — 규칙으로 계획을 낸다. 같은 observe 를 본다. 제출본 아님. */
async function local_run(agent: Agent, _in: string, ctx: Row): Promise<string> {
  const obs: Row = ctx.obs ?? (await observe());
  const labels = obs.labels as Row[];
  const hot = labels.filter((l) => l.grade === "immediate" || l.grade === "high" || l.spiked).map((l) => l.label as string);
  const need_doc = (obs.pending_actions as Row[]).length > 0;
  const fresh = Number(obs.new_classified_since_briefing) > 0 || obs.minutes_since_briefing === null ||
    labels.some((l) => l.grade === "immediate");
  const why: string[] = [];
  if (need_doc) why.push("요청서가 필요한 유형 있음");
  if (!fresh) why.push("마지막 브리핑 뒤 새 분류 없음");
  if (!why.length) why.push("특이 변화 없음 — 기본 점검");
  await agent.call("plan_cycle", {
    focus_labels: hot, run_dispatcher: need_doc, run_supervisor: fresh, reason: why.join(" · ") + " (local 규칙)",
  });
  return "계획 수립 (local 규칙)";
}

export const planner = new Agent({
  name: "planner",
  system: SYSTEM,
  tools: [plan_cycle],
  max_steps: 3,
  max_tokens: 600,
  local: local_run,
  finish_tool: "plan_cycle",             // plan_cycle 성공이 곧 끝 — 보고 문장 호출 1번을 아낀다
});

/** 기본 계획 (계획이 안 나왔을 때). 고정 순서다: ③ 부름 · ④ 부름. */
export function fallback_plan(obs: Row | null, why: string): Plan {
  const p = enforce({ focus_labels: [], run_dispatcher: true, run_supervisor: true, reason: why }, obs);
  p.source = "fallback";
  return p;
}

/** 이번 주기의 계획을 세워 돌려준다. 계획 에이전트가 실패해도 기본 계획으로 주기는 계속 돈다. */
export async function run_once(): Promise<Plan> {
  _STATE.plan = null;
  let obs: Row | null = null;
  try {
    obs = await observe();
    _STATE.obs = obs;
    await planner.run(
      `이번 주기 계획을 세워줘. 상황(건수·등급만, 민원 내용 없음):\n${JSON.stringify(obs)}`,
      { obs });
  } catch (e) {
    await db.log_agent("planner", "error", "", String((e as Error).message ?? e).slice(0, 200), "계획 실패 → 기본 계획");
  }
  if (_STATE.plan) return _STATE.plan;
  const p = fallback_plan(obs, "계획이 나오지 않아 기본 순서로 진행");
  await db.log_agent("planner", "plan", "", JSON.stringify(p).slice(0, 400), p.reason, 0);
  return p;
}
