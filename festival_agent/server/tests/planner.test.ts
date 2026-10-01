// D5-65 계획(Planner) — 주기 시작 때 계획을 세우고 워커가 그 계획대로 부른다. 전부 local 대역 + 임시 SQLite.
// 심사는 "호출했다"가 아니라 "결과가 달라졌다"를 본다 → 첫 테스트가 계획 때문에 알림이 달라지는 사례를 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, withLocalBackend, seed, all, rejects } from "./_helpers.ts";

/** 60분 창에는 주차 민원이 많고(기준선), 화장실 민원이 최근 8분 안에 몰려 들어온 상황. */
async function burstScenario(db: any) {
  const items: Array<[number | null, string, number, number, boolean, string]> = [];
  for (let i = 0; i < 40; i++) items.push([1, "parking", 30 + (i % 25), -0.5, false, `주차장 민원 번호 ${i} 주차할 곳이 없어요`]);
  for (let i = 0; i < 6; i++) items.push([7, "restroom", 1 + i, -0.7, false, `임시 화장실 줄이 길고 휴지가 없어요 ${i}`]);
  await seed(db, items);
}

const alertsOf = async (db: any) => (await all(db, "SELECT label, kind, detail FROM alert ORDER BY id")).map((a: any) => `${a.label}/${a.kind}`);

test("test_급증이_의심되면_계획이_15분_창을_다시_보게_해서_알림이_달라진다", async (t) => {
  const m = await need(t, "agents/planner.ts", "worker.ts"); if (!m) return;
  const [planner, worker] = m;

  // A) 계획 없이(예전 고정 순서 = 60분 창만) — 화장실 급증은 '급증' 알림뿐이고 즉시 알림은 없다
  let fixed: string[] = [];
  await withLocalBackend(async () => withTempDb(async (db) => {
    await burstScenario(db);
    await worker.agent_path(60, planner.fallback_plan(await planner.observe(60), "예전 고정 순서"));
    fixed = await alertsOf(db);
  }));

  // B) 계획이 '최근 유입이 몰렸다'를 보고 15분 창을 고른다 → 그 창에서 화장실이 즉시 등급으로 올라와 알림이 더 나온다
  let planned: string[] = [];
  let plan: any;
  await withLocalBackend(async () => withTempDb(async (db) => {
    await burstScenario(db);
    plan = await planner.run_once(60);
    assert.equal(plan.window_min, 15);
    assert.ok(plan.focus_labels.includes("restroom"));
    assert.equal(plan.source, "local");
    await worker.agent_path(60, plan);
    planned = await alertsOf(db);
    // 재확인은 기록(severity 스냅샷)을 15분 창으로 덮어쓰지 않는다
    const windows = (await all(db, `SELECT DISTINCT "window" w FROM severity`)).map((r: any) => r.w);
    assert.deepEqual(windows, ["60min"]);
  }));

  assert.ok(!fixed.includes("restroom/safety_threshold"), `고정 순서에서는 즉시 알림이 없어야 한다: ${fixed}`);
  assert.ok(planned.includes("restroom/safety_threshold"), `계획이 고른 15분 재확인에서 즉시 알림이 나와야 한다: ${planned}`);
  assert.ok(planned.length > fixed.length);
});

test("test_계획은_plan_으로_agent_log_에_남고_이유가_보인다", async (t) => {
  const m = await need(t, "agents/planner.ts"); if (!m) return;
  const [planner] = m;
  await withLocalBackend(async () => withTempDb(async (db) => {
    await burstScenario(db);
    await planner.run_once(60);
    const logs = await all(db, "SELECT agent, action, output_summary, reasoning FROM agent_log WHERE agent='planner' AND action='plan'");
    assert.equal(logs.length, 1);
    assert.ok(logs[0].reasoning.includes("15분") && logs[0].output_summary.includes('"window_min":15'));
    assert.ok(logs[0].output_summary.includes('"must_run":["classify","monitor"]'));
  }));
});

test("test_안전_규칙상_필수_단계는_계획이_건너뛰지_못한다", async (t) => {
  const m = await need(t, "agents/planner.ts"); if (!m) return;
  const [planner] = m;
  await withLocalBackend(async () => withTempDb(async (db) => {
    // 즉시 등급(안전 3건)인데 요청서가 없다
    await seed(db, [4, 4, 4].map((z, i): [number, string, number, number, boolean, string] => [z, "safety", 3 + i, -0.9, true, `계단 난간이 흔들려 위험해요 ${i}`]));
    planner._STATE.obs = await planner.observe(60);
    assert.ok(planner._STATE.obs.pending_actions.some((p: any) => p.label === "safety" && p.grade === "immediate"));

    // 분류·감시를 끄는 인자는 없다 — 주면 거부된다
    for (const bad of ["skip_classify", "skip_monitor", "skip_severity"]) {
      await rejects(() => planner.plan_cycle.invoke({ window_min: 60, run_dispatcher: true, run_supervisor: true, reason: "x", [bad]: true }),
        (e) => assert.ok(String(e.message).includes("unexpected keyword")));
    }
    // 끄려 해도 코드가 켠다 (③·④) — 보정 내용이 기록된다
    const r = await planner.plan_cycle.invoke({ window_min: 60, focus_labels: [], run_dispatcher: false, run_supervisor: false, reason: "쉬자" });
    assert.equal(r.plan.run_dispatcher, true);
    assert.equal(r.plan.run_supervisor, true);
    assert.deepEqual(r.plan.must_run, ["classify", "monitor"]);
    assert.ok(r.plan.focus_labels.includes("safety"));
    assert.equal(r.plan.overrides.length, 2);
    // 허용되지 않는 창은 기본(60)으로
    assert.equal(planner.enforce({ window_min: 30 }, null).window_min, 60);
    assert.ok(planner.enforce({ window_min: 30 }, null).overrides[0].includes("60"));
  }));
});

test("test_계획이_안_나오면_예전_고정_순서로_돈다", async (t) => {
  const m = await need(t, "agents/planner.ts", "core/llm.ts"); if (!m) return;
  const [planner, llm] = m;
  await withTempDb(async (db) => {
    const prev = process.env.LLM_BACKEND;
    process.env.LLM_BACKEND = "anthropic";                                   // 모델 호출이 실패하는 상황 (가짜 클라이언트)
    llm.set_client({ messages: { create: async () => { throw new Error("네트워크 오류"); } } });
    try {
      const p = await planner.run_once(60);
      assert.equal(p.source, "fallback");
      assert.deepEqual([p.window_min, p.run_dispatcher, p.run_supervisor], [60, true, true]);
      const errs = await all(db, "SELECT action FROM agent_log WHERE agent='planner'");
      assert.ok(errs.some((e: any) => e.action === "error") && errs.some((e: any) => e.action === "plan"));
    } finally {
      llm.set_client(null);
      if (prev === undefined) delete process.env.LLM_BACKEND; else process.env.LLM_BACKEND = prev;
    }
  });
});
