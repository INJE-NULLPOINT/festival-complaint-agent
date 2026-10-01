// D5-66 분류 기억 — 운영자가 고친 유형이 다음 비슷한 민원의 분류를 실제로 바꾼다. 전부 local 대역 + 임시 SQLite.
// 심사는 "조회했다"가 아니라 "결과가 달라졌다"를 본다 → 기억이 있을 때와 없을 때(MEMORY=0)를 같은 시나리오로 비교한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, withLocalBackend, withConfig, all, one } from "./_helpers.ts";

const A = "쓰레기통이 가득 차서 냄새가 나요";           // local 규칙에 안 걸린다 → 확인 필요(review)
const B = "쓰레기통이 가득 차서 넘쳐요";               // A 와 비슷하지만 글자는 다르다 (정확 캐시로는 못 잡음)
const C = "쓰레기통이 가득 차서 냄새가 나요!!";          // 기호만 다르다 (정확 해시 캐시는 못 잡고, 기억은 거의 같은 글로 잡는다)

/** A 를 접수 → 확인 필요 → 운영자가 guide 로 지정. 그다음 newText 를 접수해 분류한 결과를 돌려준다. */
async function scenario(mods: any[], newText: string): Promise<{ row: any; logs: any[]; llm_runs: number }> {
  const [classifier, webapi, db] = mods;
  const a = await db.insert_feedback(1, A, "qr");
  await classifier.run_once(20);
  assert.equal((await one(db, "SELECT status FROM classification WHERE feedback_id=?", [a])).status, "review");
  await webapi.resolve_review(a, "guide");                                          // 운영자가 '안내/동선' 으로 고친다
  const n = await db.insert_feedback(2, newText, "qr");
  await db.connect().then((c: any) => c.execute("DELETE FROM agent_log"));
  await classifier.run_once(20);
  const row = await one(db, "SELECT label, status, confidence, agent_note FROM classification WHERE feedback_id=?", [n]);
  const logs = await all(db, "SELECT agent, action, output_summary, reasoning FROM agent_log ORDER BY id");
  return { row, logs, llm_runs: logs.filter((l: any) => l.action === "run(local)").length };
}

test("test_운영자가_지정한_유형이_다음_비슷한_민원을_확인필요_대신_guide로_분류하게_바꾼다", async (t) => {
  const m = await need(t, "agents/classifier.ts", "webapi.ts", "core/db.ts"); if (!m) return;

  let withMemory: any, without: any;
  await withLocalBackend(async () => withTempDb(async (db) => { withMemory = await scenario([m[0], m[1], db], B); }));
  await withLocalBackend(async () => withConfig({ MEMORY_ENABLED: false }, async () => withTempDb(async (db) => { without = await scenario([m[0], m[1], db], B); })));

  // 기억이 없으면 예전처럼 확인 필요, 있으면 운영자가 정해 둔 guide 로 분류된다
  assert.equal(without.row.status, "review");
  assert.equal(withMemory.row.status, "done");
  assert.equal(withMemory.row.label, "guide");
  assert.ok(withMemory.row.agent_note.includes("유사 사례 반영") && withMemory.row.agent_note.includes("운영자 지정"), withMemory.row.agent_note);
  // 조회는 agent_log 에 남는다 (운영자 사례를 찾았다고)
  const look = withMemory.logs.find((l: any) => l.agent === "classifier" && l.action === "lookup_similar");
  assert.ok(look && look.output_summary.includes("운영자"), JSON.stringify(withMemory.logs.map((l: any) => l.action)));
  assert.ok(!without.logs.some((l: any) => l.action === "lookup_similar"));
});

test("test_거의_같은_글은_운영자_지정_유형을_LLM_없이_바로_반영한다", async (t) => {
  const m = await need(t, "agents/classifier.ts", "webapi.ts", "core/db.ts"); if (!m) return;
  let hit: any, off: any;
  await withLocalBackend(async () => withTempDb(async (db) => { hit = await scenario([m[0], m[1], db], C); }));
  await withLocalBackend(async () => withConfig({ MEMORY_ENABLED: false }, async () => withTempDb(async (db) => { off = await scenario([m[0], m[1], db], C); })));
  assert.equal(off.row.status, "review");                                          // 기억이 없으면 또 확인 필요
  assert.deepEqual([hit.row.status, hit.row.label], ["done", "guide"]);
  assert.ok(hit.logs.some((l: any) => l.action === "memory_hit"));
  assert.equal(hit.llm_runs, 0);                                                   // 분류 에이전트(LLM) 호출 없이 처리
  assert.ok(off.llm_runs >= 1);
});

test("test_분류_프롬프트에_비슷한_과거_사례가_들어간다_운영자_지정이_앞", async (t) => {
  const m = await need(t, "agents/classifier.ts", "webapi.ts", "core/db.ts", "core/llm.ts"); if (!m) return;
  const [classifier, webapi, , llm] = m;
  await withTempDb(async (db) => {
    const a = await db.insert_feedback(1, A, "qr");
    // 모델이 확신해 분류한 비슷한 사례 (신뢰도 0.9) 도 있고, 운영자가 지정한 사례도 있다
    const b = await db.insert_feedback(3, "쓰레기통이 가득 차서 넘친다", "qr");
    await (await db.connect()).execute("UPDATE classification SET label='restroom', sentiment=-0.4, is_safety=0, confidence=0.9, status='done' WHERE feedback_id=?", [b]);
    await (await db.connect()).execute("UPDATE classification SET status='review', label=NULL, confidence=0.1 WHERE feedback_id=?", [a]);
    await webapi.resolve_review(a, "guide");
    const n = await db.insert_feedback(2, B, "qr");

    // get_pending(에이전트 모드의 관측 도구)가 사례를 붙인다
    const item = (await classifier.get_pending.fn(10)).find((x: any) => x.id === n);
    assert.ok(item.similar_cases.length >= 1 && item.similar_cases[0].startsWith("운영자 지정 guide"), JSON.stringify(item.similar_cases));

    // prefetch 모드 프롬프트에도 들어간다 (가짜 모델 클라이언트가 받은 요청을 본다)
    const prompts: string[] = [];
    llm.set_client({ messages: { create: async (req: any) => {
      prompts.push(typeof req.messages[0].content === "string" ? req.messages[0].content : JSON.stringify(req.messages[0].content));
      return { stop_reason: "end_turn", content: [], usage: { input_tokens: 1, output_tokens: 1 }, model: "fake" };
    } } });
    const prev = process.env.LLM_BACKEND;
    process.env.LLM_BACKEND = "anthropic";
    try {
      await withConfig({ CLASSIFY_MODE: "prefetch" }, () => classifier.run_once(10));
    } finally {
      llm.set_client(null);
      if (prev === undefined) delete process.env.LLM_BACKEND; else process.env.LLM_BACKEND = prev;
    }
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes("비슷한 과거 사례: 운영자 지정 guide"), prompts[0]);
  });
});

test("test_유사도_기준_기호_차이는_같은_글_다른_내용은_기억하지_않는다", async (t) => {
  const m = await need(t, "core/memory.ts", "core/db.ts"); if (!m) return;
  const [memory] = m;
  assert.equal(memory.similarity("쓰레기통이 가득 찼어요!!", "쓰레기통이  가득 찼어요"), 1);
  assert.ok(memory.similarity(A, B) >= memory.SIM_CONSULT && memory.similarity(A, B) < 1);      // 참고로는 내놓지만 직접 반영은 아니다 (D5-72: 같은 글만 직접 반영)
  assert.ok(memory.similarity(A, "주차장이 만차라 차를 못 댔어요") < memory.SIM_CONSULT);
  assert.equal(memory.similarity("", A), 0);
  // 운영자가 지정하지 않았고 신뢰도가 낮은(local 0.55) 분류는 기억으로 쓰지 않는다
  await withTempDb(async (db) => {
    const f = await db.insert_feedback(1, "화장실 휴지가 없어요 정말로", "qr");
    await (await db.connect()).execute("UPDATE classification SET label='restroom', sentiment=-0.5, is_safety=0, confidence=0.55, status='done' WHERE feedback_id=?", [f]);
    assert.deepEqual(await memory.similar_cases("화장실 휴지가 없어요 정말로 없네", 3), []);
    await (await db.connect()).execute("UPDATE classification SET confidence=0.9 WHERE feedback_id=?", [f]);
    const got = await memory.similar_cases("화장실 휴지가 없어요 정말로 없네", 3);
    assert.equal(got.length, 1);
    assert.equal(got[0].by, "model");
  });
});
