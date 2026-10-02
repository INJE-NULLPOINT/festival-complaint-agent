// D5-52: 요청서 파일명이 같은 순간에도 겹치지 않는다 (밀리초 + -2, -3). Python test_조치요청서_파일명은_같은_순간에도_겹치지_않는다 와 같은 사례.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { need, withTempDb } from "./_helpers.ts";

test("test_조치요청서_파일명은_같은_순간에도_겹치지_않는다", async (t) => {
  const m = await need(t, "agents/dispatcher.ts", "core/db.ts");
  if (!m) return;
  const [dispatcher, db] = m;
  process.env.LLM_BACKEND = "local";
  await withTempDb(async () => {
    const out = mkdtempSync(join(tmpdir(), "docname-"));
    const old = dispatcher.paths.OUT_DIR;
    dispatcher.paths.OUT_DIR = out;
    try {
      const q = [{ raw_text: "화장실 휴지가 없어요", zone: "임시 화장실 A", ingested_at: "2026-10-01T10:00:00" }];
      const paths: string[] = [];
      for (let i = 0; i < 6; i++) paths.push((await dispatcher.generate_doc.fn("restroom", "환경위생과", 1, "mid", q, ["휴지를 채운다"])).path);
      assert.equal(new Set(paths).size, 6);
      assert.ok(paths.every((p) => existsSync(p)));
      assert.equal(readdirSync(out).filter((f) => f.endsWith(".docx")).length, 6);
      assert.ok(paths.every((p) => /_\d{4}_\d{6}_\d{3}(-\d+)?\.docx$/.test(p)));
      const c = await db.connect();
      assert.equal((await c.execute("SELECT COUNT(DISTINCT doc_path) c FROM action_request")).fetchone().c, 6);
    } finally {
      dispatcher.paths.OUT_DIR = old;
    }
  });
});

// D5-57: DB 가 SQLite 이면 SUPABASE_URL·SERVICE_KEY 가 환경에 남아 있어도 Storage 로 올리지 않는다 (테스트 DOCX 가 운영 Storage 에 쌓인 사고).
test("test_SQLite_모드에서는_Storage_업로드를_하지_않는다", async (t) => {
  const m = await need(t, "agents/dispatcher.ts", "core/db.ts", "core/config.ts");
  if (!m) return;
  const [dispatcher, db, cfg] = m;
  const config = cfg.config ?? cfg;
  process.env.LLM_BACKEND = "local";
  await withTempDb(async () => {
    assert.equal(db.is_pg(), false);
    const out = mkdtempSync(join(tmpdir(), "docup-"));
    const oldOut = dispatcher.paths.OUT_DIR, oldUrl = config.SUPABASE_URL, oldKey = config.SUPABASE_SERVICE_KEY, oldFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (u: any) => { calls.push(String(u)); return new Response("{}", { status: 200 }); }) as typeof fetch;
    dispatcher.paths.OUT_DIR = out;
    config.SUPABASE_URL = "https://example.invalid";          // 운영 값이 환경에 남은 상황을 흉내 (가짜 값)
    config.SUPABASE_SERVICE_KEY = "fake-service-key";
    try {
      const q = [{ raw_text: "화장실 휴지가 없어요", zone: "임시 화장실 A", ingested_at: "2026-10-01T10:00:00" }];
      await dispatcher.generate_doc.fn("restroom", "환경위생과", 1, "mid", q, ["휴지를 채운다"]);
      assert.deepEqual(calls, [], "Storage 로 요청이 나갔다");
      const c = await db.connect();
      const url = (await c.execute("SELECT doc_url FROM action_request ORDER BY id DESC LIMIT 1")).fetchone().doc_url;
      assert.ok(String(url).startsWith("/api/docs/"), url);
      assert.equal(await dispatcher._upload(join(out, "x.docx"), "k.docx"), `/api/docs/${encodeURIComponent("x.docx")}`);
      assert.deepEqual(calls, []);
    } finally {
      globalThis.fetch = oldFetch;
      dispatcher.paths.OUT_DIR = oldOut;
      config.SUPABASE_URL = oldUrl;
      config.SUPABASE_SERVICE_KEY = oldKey;
    }
  });
});
