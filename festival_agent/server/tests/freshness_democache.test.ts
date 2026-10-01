// D5-86 마지막 갱신 시각 API · D5-89 시연 시드 캐시. 임시 SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { need, withTempDb, seed, all, run } from "./_helpers.ts";

test("get_freshness: 빈 DB 는 server_now 만 있고 나머지는 null, 기록이 생기면 가장 최근 시각을 준다", async (t) => {
  const m = await need(t, "webapi.ts", "core/db.ts"); if (!m) return;
  const [webapi, db] = m;
  await withTempDb(async (conn) => {
    const empty = await webapi.get_freshness();
    assert.match(empty.server_now, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    assert.deepEqual([empty.severity_at, empty.agent_at, empty.worker_at], [null, null, null]);
    await db.log_agent("monitor", "get_window_stats", "x", "y");
    await db.set_worker_status("agents", 5, true, "");
    await db.set_worker_status("_backend", 0, true, "local");        // '_' 줄은 루프가 아니다
    await run(conn, "UPDATE worker_status SET last_at='2099-01-01T00:00:00' WHERE name='_backend'");
    const f = await webapi.get_freshness();
    assert.ok(f.agent_at && f.worker_at && f.worker_at < "2099");
    const ctl = await webapi.get_control();
    assert.deepEqual(Object.keys(ctl.fresh).sort(), ["agent_at", "server_now", "severity_at", "worker_at"]);
    assert.ok("get_freshness" in webapi.RPC);
  });
});

test("get_freshness: 등급 계산(severity) 시각이 보인다", async (t) => {
  const m = await need(t, "webapi.ts"); if (!m) return;
  const [webapi] = m;
  await withTempDb(async (conn) => {
    await seed(conn, [[1, "parking", 5, -0.5, false, "주차장이 만차예요 하나"]]);
    await run(conn, `INSERT INTO severity (festival_id,label,"window",as_of,freq,avg_sentiment,base_score,safety_w,spike_w,pending_w,score,grade,formula)
                     VALUES (1,'parking','60','2026-10-01T10:00:00',1,-0.5,1,1,1,1,1,'low','x')`);
    assert.equal((await webapi.get_freshness()).severity_at, "2026-10-01T10:00:00");
    assert.equal((await all(conn, "SELECT COUNT(*) n FROM severity"))[0].n, 1);
  });
});

test("시연 캐시: 파일을 시연 DB 의 classify_cache 에 넣으면 대기 민원이 모델 호출 없이 끝난다 · local 결과 파일은 거부", async (t) => {
  const m = await need(t, "scripts/_democache.ts", "agents/classifier.ts", "core/db.ts"); if (!m) return;
  const [dc, classifier, db] = m;
  const dir = mkdtempSync(path.join(tmpdir(), "dc-"));
  const f = path.join(dir, "c.json");
  const text = "주차장이 벌써 만차라서 한참을 돌다가 겨우 자리를 찾았어요";
  writeFileSync(f, JSON.stringify({ backend: "claude_code", model: "m", created_at: "2026-10-01T00:00:00",
    entries: [{ text, label: "parking", sentiment: -0.6, is_safety: false, confidence: 0.9 }] }));
  await withTempDb(async (conn) => {
    await db.insert_feedback(1, text, "demo");
    assert.equal(await dc.load(f), 1);
    assert.equal(await classifier.apply_cache(), 1);
    const r = (await all(conn, "SELECT status, label, agent_note FROM classification"))[0];
    assert.deepEqual([r.status, r.label, r.agent_note], ["done", "parking", "cache"]);
  });
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ backend: "local", model: "-", created_at: "x", entries: [] }));
  assert.throws(() => dc.read(bad), /실제 모델 결과 파일이 아닙니다/);
  assert.equal(dc.read(path.join(dir, "none.json")), null);
});

test("저장된 시연 캐시 파일은 시연 시드 문장과 맞고 규칙(local) 결과가 아니다", async (t) => {
  const m = await need(t, "scripts/_democache.ts", "scripts/demo_scenario.ts"); if (!m) return;
  const [dc, demo] = m;
  const j = dc.read();
  if (!j) return t.skip("seed/demo_classify_cache.json 없음 — precache_demo.ts 로 만든다");
  const texts = new Set<string>([...demo.BACKGROUND.map((x: any) => x[1]), ...demo.RESERVED.map((x: any) => x[2])]);
  assert.ok(j.entries.length > 0 && j.entries.every((e: any) => texts.has(e.text)));
  assert.notEqual(j.backend, "local");
});
