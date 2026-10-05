// D5-79 ② 감시·④ 통합 에이전트 — agent 모드(모델이 도구를 직접 골라 부르는 루프). 호출 수는 판단을 코드로 넘기지 않는 범위에서만 줄인다:
// 같은 도구·같은 인자의 재호출은 결과를 재사용하고, 서로 독립인 호출은 한 응답에서 동시에 부르게 한다. 가짜 모델 클라이언트 + 임시 SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, withEnv, seed, all } from "./_helpers.ts";

type Req = { system: any; tools: any[]; messages: any[] };
const sysText = (r: Req): string => (typeof r.system === "string" ? r.system : r.system.map((b: any) => b.text).join(""));

function fakeClient(script: Array<(req: Req) => { stop: string; blocks: any[] }>, seen: Req[]) {
  return { messages: { create: async (req: Req) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    const step = script[Math.min(seen.length - 1, script.length - 1)](req);
    const content = step.blocks.map((b, i) => (b.type ? b : { type: "tool_use", id: `t${seen.length}_${i}`, ...b }));
    return { stop_reason: step.stop, content, usage: { input_tokens: 1, output_tokens: 1 }, model: "fake" };
  } } };
}
const tool = (name: string, input: any) => ({ stop: "tool_use", blocks: [{ name, input }] });
const tools = (...b: Array<[string, any]>) => ({ stop: "tool_use", blocks: b.map(([name, input]) => ({ name, input })) });

/** 안전 3건(즉시 등급) + 주차 6건. */
async function situation(db: any) {
  await seed(db, [
    ...[0, 1, 2].map((i): [number, string, number, number, boolean, string] => [4, "safety", 8 - i, -0.9, true, `유등터널 계단 난간이 흔들려서 위험해요 ${i}번째`]),
    ...[0, 1, 2, 3, 4, 5].map((i): [number, string, number, number, boolean, string] => [1, "parking", 30 + i, -0.5, false, `주차장이 만차라 차를 못 댔어요 ${i}번째`]),
  ]);
}

test("test_감시_통합은_모델이_도구를_직접_고르는_agent_모드다", async (t) => {
  const m = await need(t, "agents/monitor.ts", "agents/supervisor.ts", "core/llm.ts"); if (!m) return;
  const [monitor, supervisor, llm] = m;
  await withTempDb(async (db) => {
    await situation(db);
    const seen: Req[] = [];
    llm.set_client(fakeClient([() => ({ stop: "end_turn", blocks: [{ type: "text", text: "끝" }] })], seen));
    try {
      await withEnv("LLM_BACKEND", "anthropic", async () => { await monitor.run_once(); await supervisor.run_once(); });
    } finally { llm.set_client(null); }
    assert.deepEqual(seen[0].tools.map((x: any) => x.name), ["get_window_stats", "score_label", "save_snapshot", "raise_alert"]);
    assert.deepEqual(seen[1].tools.map((x: any) => x.name), ["read_agent_results", "rank_actions", "rank_issues", "write_briefing"]);
    assert.ok(sysText(seen[0]).includes("동시에"));                              // 서로 독립인 호출은 한 응답에서 동시에 (라운드 수를 줄인다)
  });
});

test("test_감시_같은_도구를_같은_인자로_다시_부르면_결과를_재사용하고_다른_인자는_실행한다", async (t) => {
  const m = await need(t, "agents/monitor.ts", "core/llm.ts"); if (!m) return;
  const [monitor, llm] = m;
  await withTempDb(async (db) => {
    await situation(db);
    const seen: Req[] = [];
    await withEnv("LLM_BACKEND", "anthropic", async () => {
      llm.set_client(fakeClient([
        () => tools(["get_window_stats", {}], ["score_label", { label: "safety" }]),
        () => tools(["get_window_stats", {}], ["score_label", { label: "safety" }], ["score_label", { label: "parking" }]),   // 앞의 둘은 이미 안 결과
        () => tool("raise_alert", { label: "safety", kind: "safety_threshold", detail: "안전 3건 — 즉시 조치 등급입니다." }),
        () => ({ stop: "end_turn", blocks: [{ type: "text", text: "끝" }] }),
      ], seen));
      try { await monitor.run_once(); } finally { llm.set_client(null); }
    });
    assert.equal(seen.length, 4);                                                  // 어떤 도구를 부를지는 그대로 모델이 정한다
    const logs = await all(db, "SELECT action, input_summary, reasoning FROM agent_log WHERE agent='monitor' AND action IN ('get_window_stats','score_label')");
    const reused = logs.filter((l: any) => l.reasoning.includes("재사용"));
    assert.equal(reused.length, 2);                                                // get_window_stats(60)·score_label(safety) 두 번째 호출
    assert.ok(logs.filter((l: any) => !l.reasoning.includes("재사용")).some((l: any) => l.action === "score_label" && l.input_summary.includes("parking")));   // 새 인자는 실제 실행
    assert.equal((await all(db, "SELECT kind FROM alert")).length, 1);
  });
});
