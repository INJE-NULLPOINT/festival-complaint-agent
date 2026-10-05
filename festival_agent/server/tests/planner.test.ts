// D5-65 계획(Planner) — 주기 시작 때 계획을 세우고 워커가 그 계획대로 부른다. 전부 local 대역 + 임시 SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, withLocalBackend, seed, all, rejects } from "./_helpers.ts";

/** 주차 민원이 많고(기준선), 화장실 민원이 최근 8분 안에 몰려 들어온 상황. */
async function burstScenario(db: any) {
  const items: Array<[number | null, string, number, number, boolean, string]> = [];
  for (let i = 0; i < 40; i++) items.push([1, "parking", 30 + (i % 25), -0.5, false, `주차장 민원 번호 ${i} 주차할 곳이 없어요`]);
  for (let i = 0; i < 6; i++) items.push([7, "restroom", 1 + i, -0.7, false, `임시 화장실 줄이 길고 휴지가 없어요 ${i}`]);
  await seed(db, items);
}

test("test_계획은_plan_으로_agent_log_에_남고_이유가_보인다", async (t) => {
  const m = await need(t, "agents/planner.ts"); if (!m) return;
  const [planner] = m;
  await withLocalBackend(async () => withTempDb(async (db) => {
    await burstScenario(db);
    await planner.run_once();
    const logs = await all(db, "SELECT agent, action, output_summary, reasoning FROM agent_log WHERE agent='planner' AND action='plan'");
    assert.equal(logs.length, 1);
    assert.ok(logs[0].reasoning.includes("local 규칙") && logs[0].output_summary.includes('"focus_labels"'));
    assert.ok(logs[0].output_summary.includes('"must_run":["classify","monitor"]'));
  }));
});

test("test_안전_규칙상_필수_단계는_계획이_건너뛰지_못한다", async (t) => {
  const m = await need(t, "agents/planner.ts"); if (!m) return;
  const [planner] = m;
  await withLocalBackend(async () => withTempDb(async (db) => {
    // 즉시 등급(안전 3건)인데 요청서가 없다
    await seed(db, [4, 4, 4].map((z, i): [number, string, number, number, boolean, string] => [z, "safety", 3 + i, -0.9, true, `계단 난간이 흔들려 위험해요 ${i}`]));
    planner._STATE.obs = await planner.observe();
    assert.ok(planner._STATE.obs.pending_actions.some((p: any) => p.label === "safety" && p.grade === "immediate"));

    // 분류·감시를 끄는 인자는 없다 — 주면 거부된다
    for (const bad of ["skip_classify", "skip_monitor", "skip_severity"]) {
      await rejects(() => planner.plan_cycle.invoke({ run_dispatcher: true, run_supervisor: true, reason: "x", [bad]: true }),
        (e) => assert.ok(String(e.message).includes("unexpected keyword")));
    }
    // 끄려 해도 코드가 켠다 (③·④) — 보정 내용이 기록된다
    const r = await planner.plan_cycle.invoke({ focus_labels: [], run_dispatcher: false, run_supervisor: false, reason: "쉬자" });
    assert.equal(r.plan.run_dispatcher, true);
    assert.equal(r.plan.run_supervisor, true);
    assert.deepEqual(r.plan.must_run, ["classify", "monitor"]);
    assert.ok(r.plan.focus_labels.includes("safety"));
    assert.equal(r.plan.overrides.length, 2);
  }));
});

test("test_계획이_안_나오면_고정_순서로_돈다", async (t) => {
  const m = await need(t, "agents/planner.ts", "core/llm.ts"); if (!m) return;
  const [planner, llm] = m;
  await withTempDb(async (db) => {
    const prev = process.env.LLM_BACKEND;
    process.env.LLM_BACKEND = "anthropic";                                   // 모델 호출이 실패하는 상황 (가짜 클라이언트)
    llm.set_client({ messages: { create: async () => { throw new Error("네트워크 오류"); } } });
    try {
      const p = await planner.run_once();
      assert.equal(p.source, "fallback");
      assert.deepEqual([p.run_dispatcher, p.run_supervisor], [true, true]);
      const errs = await all(db, "SELECT action FROM agent_log WHERE agent='planner'");
      assert.ok(errs.some((e: any) => e.action === "error") && errs.some((e: any) => e.action === "plan"));
    } finally {
      llm.set_client(null);
      if (prev === undefined) delete process.env.LLM_BACKEND; else process.env.LLM_BACKEND = prev;
    }
  });
});
