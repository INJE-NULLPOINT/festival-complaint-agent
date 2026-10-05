// D5-77 ③조치 에이전트 호출 수 — 예전: 모델이 도구 4개를 차례로 불러 5~6회(67초), 지금: 코드가 미리 조회하고 모델은 write_request 1회.
// 요청서의 내용과 규칙(인용은 원문 그대로, 카드 조치 그대로, 건수·부서·연락처·판정 근거는 코드가 채움)은 그대로다. 가짜 모델 클라이언트 + 임시 SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, withLocalBackend, withEnv, withConfig, seed, all, one } from "./_helpers.ts";

type Req = { system: any; tools: any[]; messages: any[] };
const sysText = (r: Req): string => (typeof r.system === "string" ? r.system : r.system.map((b: any) => b.text).join(""));
const size = (r: Req): number => sysText(r).length + JSON.stringify(r.tools).length + JSON.stringify(r.messages[0].content).length;

function fakeClient(script: Array<(req: Req) => { stop: string; blocks: any[] }>, seen: Req[]) {
  return { messages: { create: async (req: Req) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    const step = script[Math.min(seen.length - 1, script.length - 1)](req);
    const content = step.blocks.map((b, i) => (b.type ? b : { type: "tool_use", id: `t${seen.length}_${i}`, ...b }));
    return { stop_reason: step.stop, content, usage: { input_tokens: 1, output_tokens: 1 }, model: "fake" };
  } } };
}

const CROWD = Array.from({ length: 6 }, (_, i): [number, string, number, number, boolean, string] =>
  [4 + (i % 2), "crowd", 12 - i, -0.8, true, `유등터널 입구에 사람이 몰려 밀려요 ${i}번째 불편`]);

/** 카드 조치까지 만들어 둔 상태에서 fn 을 돈다 (supervisor 는 local 대역으로). */
async function withCards<T>(mods: any[], fn: (db: any) => Promise<T>): Promise<T> {
  const supervisor = mods[1];
  return withTempDb(async (db) => {
    await seed(db, CROWD);
    await withLocalBackend(() => supervisor.run_once());
    return fn(db);
  });
}

async function dispatch(mods: any[], script: any[], opts: { mode?: string } = {}) {
  const [dispatcher, , llm] = mods;
  const seen: Req[] = [];
  llm.set_client(fakeClient(script, seen));
  try {
    const entry = (await (await import("../core/db.ts")).ranked()).filter((r: any) => r.label === "crowd")[0];
    await withEnv("LLM_BACKEND", "anthropic", () => withConfig({ DISPATCH_MODE: opts.mode ?? "prefetch" },
      () => dispatcher.run_for("crowd", entry.score, entry.grade, entry.formula, 60)));
  } finally { llm.set_client(null); }
  return seen;
}

test("test_조치_에이전트는_모델_호출_1회로_요청서를_만들고_내용과_규칙은_그대로다", async (t) => {
  const m = await need(t, "agents/dispatcher.ts", "agents/supervisor.ts", "core/llm.ts", "core/issues.ts", "core/severity.ts"); if (!m) return;
  const [dispatcher, , , issues, severity] = m;
  await withCards(m, async (db) => {
    const cardActions = await issues.actions_for_label("crowd");
    assert.ok(cardActions.length);
    const cand = (await all(db, "SELECT f.raw_text FROM classification c JOIN feedback f ON f.id=c.feedback_id WHERE c.label='crowd' AND c.status='done' ORDER BY f.id DESC LIMIT 15")).map((r: any) => r.raw_text);
    // 모델: 번호 2·1 (잘못된 99·중복 2 는 버려진다)을 고르고, 카드 조치가 있는데도 자기 문장을 준다 → 무시돼야 한다
    const seen = await dispatch(m, [() => ({ stop: "tool_use", blocks: [{ name: "write_request", input: { quote_ids: [2, 1, 99, 2], suggestions: ["모델이 멋대로 쓴 조치"] } }] })]);
    assert.equal(seen.length, 1);                                                   // 모델 호출 1회 (예전 5~6회)
    assert.deepEqual(seen[0].tools.map((x: any) => x.name), ["write_request"]);
    const row = await one(db, "SELECT * FROM action_request WHERE label='crowd' ORDER BY id DESC LIMIT 1");
    const doc = JSON.parse(row.doc_json);
    assert.deepEqual(doc.quotes.map((q: any) => q.raw_text), [cand[1], cand[0]]);   // 번호로 골랐으니 원문 그대로, 고른 순서
    assert.deepEqual(doc.suggestions, cardActions.slice(0, 4));                      // 카드 조치 그대로 (모델 문장 무시)
    assert.ok(!JSON.stringify(doc).includes("멋대로"));
    assert.equal(doc.department, "안전총괄과");
    assert.equal(doc.contact, "055-000-0005");
    assert.equal(doc.count, 6);
    assert.equal(doc.basis, severity.basis_ko(doc.grade, 6, (await (await import("../core/db.ts")).ranked()).filter((r: any) => r.label === "crowd")[0].formula));
    assert.ok(!("score" in doc) && !("formula" in doc));
    // 도구 호출 기록은 그대로 남는다 (부서 조회·인용 수집·축제 정보 = 외부 API 자리) — 코드가 미리 조회했다는 표시와 함께
    const logs = await all(db, "SELECT action, reasoning FROM agent_log WHERE agent='dispatcher'");
    for (const a of ["get_department", "collect_quotes", "lookup_festival_info", "write_request", "generate_doc"]) assert.ok(logs.some((l: any) => l.action === a), a);
    assert.ok(logs.filter((l: any) => ["get_department", "collect_quotes", "lookup_festival_info"].includes(l.action)).every((l: any) => l.reasoning.includes("prefetch")));
    // 프롬프트: 후보 민원 번호 목록과 '카드 조치가 있으니 제안은 쓰지 않는다'
    const prompt = JSON.stringify(seen[0].messages[0].content);
    assert.ok(prompt.includes("후보 민원") && prompt.includes("1. [") && prompt.includes("suggestions 는 쓰지 않는다"));
    void dispatcher;
  });
});

test("test_카드_조치가_없으면_모델이_쓴_제안을_쓰고_번호가_엉망이면_규칙으로_고른다", async (t) => {
  const m = await need(t, "agents/dispatcher.ts", "agents/supervisor.ts", "core/llm.ts"); if (!m) return;
  await withTempDb(async (db) => {
    await seed(db, CROWD);                                                          // supervisor 를 안 돌렸으니 카드 문구(조치)가 없다
    const seen = await dispatch(m, [() => ({ stop: "tool_use", blocks: [{ name: "write_request", input: { quote_ids: ["x", 0, 99], suggestions: ["안내요원을 입구에 추가로 배치한다", "대기 줄 동선을 한 방향으로 바꾼다"] } }] })]);
    assert.equal(seen.length, 1);
    assert.ok(JSON.stringify(seen[0].messages[0].content).includes("suggestions 를 2~3개 쓴다"));
    const doc = JSON.parse((await one(db, "SELECT doc_json FROM action_request WHERE label='crowd'")).doc_json);
    assert.deepEqual(doc.suggestions, ["안내요원을 입구에 추가로 배치한다", "대기 줄 동선을 한 방향으로 바꾼다"]);
    assert.ok(doc.quotes.length >= 1 && doc.quotes.length <= 5);                     // 번호가 전부 틀려도 규칙(구역 분산)으로 인용을 고른다
  });
});

test("test_모델이_응답하지_않아도_요청서는_규칙으로_만들어진다", async (t) => {
  const m = await need(t, "agents/dispatcher.ts", "agents/supervisor.ts", "core/llm.ts"); if (!m) return;
  await withTempDb(async (db) => {
    await seed(db, CROWD);
    const [, , llm] = m;
    llm.set_client({ messages: { create: async () => { throw new Error("네트워크 오류"); } } });
    try {
      const entry = (await (await import("../core/db.ts")).ranked()).filter((r: any) => r.label === "crowd")[0];
      await withEnv("LLM_BACKEND", "anthropic", () => m[0].run_for("crowd", entry.score, entry.grade, entry.formula, 60));
    } finally { llm.set_client(null); }
    const row = await one(db, "SELECT doc_json FROM action_request WHERE label='crowd'");
    assert.ok(row && JSON.parse(row.doc_json).quotes.length >= 1);
    const logs = (await all(db, "SELECT action FROM agent_log WHERE agent='dispatcher'")).map((l: any) => l.action);
    assert.ok(logs.includes("fallback") && logs.includes("error"));
  });
});

test("test_조치_에이전트_호출_수_예전_최소_4회에서_1회_요청_크기도_줄었다", async (t) => {
  const m = await need(t, "agents/dispatcher.ts", "agents/supervisor.ts", "core/llm.ts"); if (!m) return;
  let before = { calls: 0, bytes: 0 }, after = { calls: 0, bytes: 0 };
  const quote = (i: number) => ({ raw_text: CROWD[i][5], zone: "유등터널", ingested_at: "2026-10-01T10:00:00" });
  // 예전 방식(agent)을 가장 짧게 쓴 모델로 가정: ①부서·인용 동시 조회 ②축제 정보 ③generate_doc ④끝 보고 = 최소 4회 (실측은 5~6회)
  await withCards(m, async () => {
    const seen = await dispatch(m, [
      () => ({ stop: "tool_use", blocks: [{ name: "get_department", input: { label: "crowd" } }, { name: "collect_quotes", input: { label: "crowd", limit: 15 } }] }),
      () => ({ stop: "tool_use", blocks: [{ name: "lookup_festival_info", input: { keyword: "진주남강" } }] }),
      () => ({ stop: "tool_use", blocks: [{ name: "generate_doc", input: { label: "crowd", department: "안전총괄과", count: 6, grade: "immediate", quotes: [quote(0), quote(1)], suggestions: ["안내요원을 추가로 배치한다"] } }] }),
      () => ({ stop: "end_turn", blocks: [{ type: "text", text: "조치요청서를 만들었습니다." }] }),
    ], { mode: "agent" });
    before = { calls: seen.length, bytes: seen.reduce((s, r) => s + size(r), 0) };
  });
  await withCards(m, async () => {
    const seen = await dispatch(m, [() => ({ stop: "tool_use", blocks: [{ name: "write_request", input: { quote_ids: [1, 2] } }] })]);
    after = { calls: seen.length, bytes: seen.reduce((s, r) => s + size(r), 0) };
  });
  assert.equal(before.calls, 4);
  assert.equal(after.calls, 1);
  assert.ok(after.bytes < before.bytes * 0.5, `요청 글자 수 합 ${after.bytes} vs ${before.bytes}`);
  console.log(`[구조 측정] 조치 에이전트 모델 호출 ${before.calls}→${after.calls}회(예전은 최소치 · 실측 5~6회) · 요청 글자 수 합 ${before.bytes}→${after.bytes}`);
});
