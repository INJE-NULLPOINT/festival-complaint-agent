// D5-76 콜드스타트 — 워커 시작 직후 준비 호출(warmup) 1회. 가짜 클라이언트·가짜 CLI 로만 돈다 (실제 모델 호출 없음).
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, withEnv, all } from "./_helpers.ts";

const warmRows = async (db: any) => all(db, "SELECT agent, action, output_summary, input_tokens, output_tokens, cache_read_tokens FROM agent_log WHERE action='warmup'");

test("test_anthropic_백엔드는_시작_직후_짧은_준비_호출_1회와_prompt_cache_표시가_있다", async (t) => {
  const m = await need(t, "worker.ts", "core/llm.ts"); if (!m) return;
  const [worker, llm] = m;
  await withTempDb(async (db) => {
    const reqs: any[] = [];
    llm.set_client({ messages: { create: async (req: any) => {
      reqs.push(JSON.parse(JSON.stringify(req)));
      return { stop_reason: "end_turn", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 700, output_tokens: 2, cache_creation_input_tokens: 650 }, model: "fake-model" };
    } } });
    try {
      assert.equal(await withEnv("LLM_BACKEND", "anthropic", () => worker.warmup()), true);
    } finally { llm.set_client(null); }
    assert.equal(reqs.length, 1);
    assert.ok(reqs[0].max_tokens <= 32, "아주 짧은 호출이어야 한다");
    assert.equal(reqs[0].system[0].cache_control.type, "ephemeral");                 // 실제 호출과 같은 system 에 캐시 구간 표시
    assert.ok(reqs[0].tools.some((x: any) => x.name === "save_classification"));      // 실제 분류 요청과 같은 도구 (앞부분이 같아야 캐시가 맞는다)
    const rows = await warmRows(db);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].agent, rows[0].input_tokens, rows[0].output_tokens], ["classifier", 700, 2]);   // 토큰이 'warmup' 으로 남는다
  });
});

test("test_준비_호출이_실패해도_워커는_계속_돈다", async (t) => {
  const m = await need(t, "worker.ts", "core/llm.ts"); if (!m) return;
  const [worker, llm] = m;
  await withTempDb(async (db) => {
    llm.set_client({ messages: { create: async () => { throw new Error("네트워크 오류 sk-ant-secret"); } } });
    try {
      assert.equal(await withEnv("LLM_BACKEND", "anthropic", () => worker.warmup()), false);       // 던지지 않는다
    } finally { llm.set_client(null); }
    const rows = await warmRows(db);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].output_summary.startsWith("실패"));
  });
});

test("test_claude_code_와_local_은_준비_호출을_하지_않는다_CLI는_호출마다_새_프로세스라_효과가_없다", async (t) => {
  const m = await need(t, "worker.ts", "core/llm.ts"); if (!m) return;
  const [worker, llm] = m;
  await withTempDb(async (db) => {
    const proto = llm.Agent.prototype, orig = proto._cli_call;
    const calls: any[] = [];
    proto._cli_call = async function (this: any, _w: any, _s: any, transcript: string, user_input: string, action?: string) {
      calls.push({ agent: this.name, action, user_input });
      await db.log_agent(this.name, action ?? "cli_call", user_input, "success · $0.0010", "fake", 10, 5, 1, 0);   // 진짜 _cli_call 이 남기는 기록 흉내
      return { final: "OK" };
    };
    try {
      // D5-79: claude_code 는 호출마다 새 `claude -p` 프로세스라 준비 호출이 다음 호출을 데워 주지 못한다 (실측: 첫 호출 11.3초 그대로) → 하지 않는다
      assert.equal(await withEnv("LLM_BACKEND", "claude_code", () => worker.warmup()), false);
      assert.equal(calls.length, 0);
      assert.equal((await warmRows(db)).length, 0);
      assert.equal(await withEnv("LLM_BACKEND", "local", () => worker.warmup()), false);             // local 도 하지 않는다
      assert.equal(calls.length, 0);
    } finally { proto._cli_call = orig; }
  });
});

test("test_local_백엔드는_모델_클라이언트를_건드리지_않는다", async (t) => {
  const m = await need(t, "worker.ts", "core/llm.ts"); if (!m) return;
  const [worker, llm] = m;
  await withTempDb(async (db) => {
    let touched = 0;
    llm.set_client({ messages: { create: async () => { touched++; return {}; } } });
    try {
      assert.equal(await withEnv("LLM_BACKEND", "local", () => worker.warmup()), false);
    } finally { llm.set_client(null); }
    assert.equal(touched, 0);
    assert.equal((await warmRows(db)).length, 0);
  });
});
