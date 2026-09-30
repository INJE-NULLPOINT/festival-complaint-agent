// Python tests/test_severity.py 옮김 ③ — 확인 필요(review) 처리 · 운영자 코드 · 민원 지우기 · 도배 방지 · 관제 필드
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  need, withTempDb, seed, run, all, one, cards, reviewRow, cls, withAdminCode, withEnv, withConfig, rejects,
  sha256hex, iso, ago, nowSec, ROOT, SERVER, tryImport,
} from "./_helpers.ts";

const cfgOf = (m: any) => m.config ?? m;

test("test_확인필요_목록은_안전의심_먼저_오래된것_먼저", async (t) => {
  if (!(await need(t, "webapi.ts", "agents/classifier.ts"))) return;
  const webapi = await tryImport("webapi.ts");
  await withTempDb(async (db) => {
    const oldPlain = await reviewRow(db, "좀 그랬어요", { safety: false, suggested: "guide", ago_min: 40 });
    const safeNew = await reviewRow(db, "뭔가 위험한 느낌이에요", { safety: true, suggested: "safety", ago_min: 2 });
    const safeOld = await reviewRow(db, "바닥이 이상하게 울퉁불퉁해요 위험한 느낌", { safety: true, suggested: "safety", ago_min: 30 });
    const items = (await webapi.get_control()).review_items;
    assert.deepEqual(items.map((i: any) => i.id), [safeOld, safeNew, oldPlain]);
    const first = items[0];
    for (const k of ["raw_text", "zone", "ingested_at", "suggested_label", "is_safety", "confidence", "agent_note"]) assert.ok(k in first, k);
    assert.ok(first.suggested_label === "safety" && first.zone === "유등터널");
    assert.equal((await cls(db, oldPlain)).suggested_label, "guide");
    for (let i = 0; i < 25; i++) await reviewRow(db, `의미를 알 수 없는 민원 ${i}번 입니다`, { safety: false, suggested: "guide" });
    assert.equal((await webapi.get_control()).review_items.length, 20);
  });
});

test("test_확인필요_유형지정_닫기_되돌리기_상태조건", async (t) => {
  const m = await need(t, "webapi.ts", "agents/classifier.ts", "scripts/measure_accuracy.ts"); if (!m) return;
  const [webapi, , ma] = m;
  await withTempDb(async (db) => {
    await seed(db, [[4, "safety", 9, -0.8, true, "유등터널 계단 조명이 꺼져 있어요"],
                    [4, "safety", 6, -0.8, true, "계단 난간이 흔들려서 위험해요"]]);
    const risky = await reviewRow(db, "뭔가 위험한 느낌이에요", { safety: true, suggested: "safety" });
    const vague = await reviewRow(db, "좀 그랬어요", { safety: false, suggested: "guide" });
    const baseCounts = await db.label_counts(), baseReview = await db.review_count();
    assert.equal(baseReview, 2);

    await webapi.resolve_review(risky, "safety");
    let c = await cls(db, risky);
    assert.deepEqual([c.status, c.label, c.is_safety, c.decided_by, c.review_action], ["done", "safety", 1, "operator", "label"]);
    assert.ok(c.reviewed_at && c.agent_note.includes("운영자 지정 (모델 제안: safety)"));
    assert.equal((await db.label_counts()).safety, baseCounts.safety + 1);
    assert.equal(Object.fromEntries((await db.ranked()).map((r: any) => [r.label, r.freq])).safety, 3);
    assert.ok((await db.review_count()) === 1 && !(await webapi.get_control()).review_items.map((i: any) => i.id).includes(risky));
    const cached = await db.cache_get(await sha256hex("뭔가 위험한 느낌이에요"));
    assert.ok(cached && cached.label === "safety" && cached.is_safety === true);
    for (const [label, given, expect] of [["parking", true, 1], ["parking", null, 0], ["positive", true, 0], ["crowd", false, 1]] as const) {
      const f = await reviewRow(db, `분류하기 어려운 민원 ${label}${given === null ? "None" : given ? "True" : "False"}`, { safety: false, suggested: "guide" });
      await webapi.resolve_review(f, label, given);
      assert.equal((await cls(db, f)).is_safety, expect, `${label} ${given}`);
    }
    for (const fn of [() => webapi.resolve_review(risky, "safety"), () => webapi.dismiss_review(risky)]) {
      await rejects(fn, (e) => { assert.ok(e instanceof webapi.ApiError); assert.ok(e.message.includes("이미 처리된 민원")); });
    }
    for (const bad of [999999, "abc", null]) {
      for (const fn of [(i: any) => webapi.resolve_review(i, "safety"), webapi.dismiss_review, webapi.reopen_review]) {
        await rejects(() => fn(bad), (e) => { assert.ok(e instanceof webapi.ApiError); assert.ok(e.message.includes("없는 민원")); });
      }
    }
    await rejects(() => webapi.resolve_review(vague, "없는유형"), (e) => assert.ok(e.message.includes("모르는 민원 유형")));

    const before = await db.review_count();
    await webapi.dismiss_review(vague);
    c = await cls(db, vague);
    assert.deepEqual([c.status, c.label, c.decided_by, c.review_action], ["dismissed", null, "operator", "dismissed"]);
    assert.ok((await db.review_count()) === before - 1 && !(await webapi.get_control()).review_items.map((i: any) => i.id).includes(vague));
    assert.ok(!("guide" in (await db.label_counts())));
    const shown = Object.fromEntries((await db.recent_feedback(30)).map((r: any) => [r.id, r.status]));
    assert.equal(shown[vague], "dismissed");

    await webapi.reopen_review(vague);
    c = await cls(db, vague);
    assert.ok(c.status === "review" && c.decided_by === null && c.review_action === null);
    assert.ok(c.suggested_label === "guide" && (await webapi.get_control()).review_items.map((i: any) => i.id).includes(vague));
    await webapi.reopen_review(risky);
    c = await cls(db, risky);
    assert.ok(c.status === "review" && c.label === null && c.decided_by === null);
    assert.equal(await db.cache_get(await sha256hex("뭔가 위험한 느낌이에요")), null);
    assert.equal(Object.fromEntries((await db.ranked()).map((r: any) => [r.label, r.freq])).safety, 2);
    for (const fid of [vague, risky]) {
      await rejects(() => webapi.reopen_review(fid), (e) => assert.ok(e.message.includes("되돌릴 수 있는 처리가 아닙니다")));
    }
    const modelDone = (await seed(db, [[1, "parking", 1, -0.5, false, "주차장이 만차예요"]]))[0];
    await rejects(() => webapi.reopen_review(modelDone), (e) => assert.ok(e.message.includes("되돌릴 수 있는 처리가 아닙니다")));

    await webapi.resolve_review(vague, "guide");
    const expected = new Map<number, string>([[vague, "guide"], [modelDone, "parking"]]);   // TS 는 dict 대신 Map
    const got = new Map((await all(db, "SELECT feedback_id, label, status, decided_by FROM classification")).map((r: any) => [r.feedback_id, r]));
    assert.deepEqual(await ma.drop_operator(expected, got), [vague]);
    assert.deepEqual(expected, new Map([[modelDone, "parking"]]));
  });
});

test("test_확인필요_방치된_안전의심은_알림_한번", async (t) => {
  const m = await need(t, "core/review.ts", "agents/classifier.ts"); if (!m) return;
  const [review] = m;
  await withTempDb(async (db) => {
    const stale = await reviewRow(db, "뭔가 위험한 느낌이에요", { safety: true, suggested: "safety", ago_min: 20 });
    await reviewRow(db, "조금 위험해 보여요 확실하진 않아요", { safety: true, suggested: "safety", ago_min: 5 });
    await reviewRow(db, "좀 그랬어요", { safety: false, suggested: "guide", ago_min: 60 });
    const gone = await reviewRow(db, "지운 안전 의심 민원입니다 위험함", { safety: true, suggested: "safety", ago_min: 40 });
    await db.set_feedback_deleted(gone, true);
    assert.equal(await review.raise_stale_alerts(), 1);
    const alerts = await all(db, "SELECT * FROM alert");
    assert.ok(alerts.length === 1 && alerts[0].kind === "review_safety_stale");
    assert.ok(alerts[0].detail.includes(`[#${stale}]`) && alerts[0].detail.includes("15분"));
    assert.equal(await review.raise_stale_alerts(), 0);
    await run(db, "UPDATE feedback SET ingested_at=? WHERE id<>?", ["2000-01-01T00:00:00", stale]);
    assert.equal(await review.raise_stale_alerts(), 1);
    assert.equal(await review.raise_stale_alerts(), 0);
  });
});

test("test_확인필요_처리_RPC도_운영자코드가_필요하다", async (t) => {
  const m = await need(t, "core/admin.ts", "webapi.ts", "agents/classifier.ts"); if (!m) return;
  const [admin, webapi] = m;
  await withTempDb(async (db) => withAdminCode("tmp-operator-code", async () => {
    const fid = await reviewRow(db, "뭔가 위험한 느낌이에요", { safety: true, suggested: "safety" });
    for (const [name, args] of [["resolve_review", { p_id: fid, p_label: "safety" }], ["dismiss_review", { p_id: fid }], ["reopen_review", { p_id: fid }]] as const) {
      for (const bad of [null, "wrong"]) {
        await rejects(() => webapi.call_rpc(name, args, bad), (e) => { assert.ok(e instanceof admin.AdminError); assert.equal(e.status, 401); });
      }
    }
    assert.equal((await cls(db, fid)).status, "review");
    await run(db, "DELETE FROM admin_attempt");
    await webapi.call_rpc("resolve_review", { p_id: fid, p_label: "safety" }, "tmp-operator-code");
    assert.equal((await cls(db, fid)).status, "done");
    await webapi.call_rpc("reopen_review", { p_id: fid, p_code: "tmp-operator-code" });
    assert.equal((await cls(db, fid)).status, "review");
    await webapi.call_rpc("dismiss_review", { p_id: fid }, "tmp-operator-code");
    assert.equal((await cls(db, fid)).status, "dismissed");
  }));
});

test("test_관제_헤더용_필드_backend_llm_synthetic", async (t) => {
  if (!(await need(t, "webapi.ts"))) return;
  const webapi = await tryImport("webapi.ts");
  await withTempDb(async (db) => {
    await seed(db, [[1, "restroom", 5, -0.5, false, "화장실 줄이 너무 길어요"]]);
    const c = await webapi.get_control();
    assert.deepEqual(c.synthetic, { on: false, count: 0 });
    assert.ok(["claude_code", "anthropic", "local"].includes(c.backend_llm));
    await withEnv("LLM_BACKEND", "local", async () => assert.equal((await webapi.get_control()).backend_llm, "local"));
    const now = nowSec();
    for (const [src, m_, text] of [["demo", 5, "시연 배경 민원 하나입니다"], ["replay", 10, "재생된 민원 하나입니다"],
                                   ["dev", 15, "개발 시드 민원 하나입니다"], ["replay", 600, "창 밖으로 벗어난 재생 민원입니다"]] as const) {
      const fid = await db.insert_feedback(1, text, src, iso(ago(now, m_)));
      await run(db, "UPDATE classification SET label='guide', sentiment=-0.3, is_safety=0, confidence=0.9, status='done' WHERE feedback_id=?", [fid]);
    }
    assert.deepEqual((await webapi.get_control()).synthetic, { on: true, count: 3 });
    await run(db, "UPDATE feedback SET deleted_at=? WHERE source='demo'", [await db.now()]);
    assert.deepEqual((await webapi.get_control()).synthetic, { on: true, count: 2 });
  });
});

test("test_관제_유입에_접수번호가_붙는다", async (t) => {
  if (!(await need(t, "webapi.ts"))) return;
  const webapi = await tryImport("webapi.ts");
  await withTempDb(async (db) => {
    const web = await webapi.submit_feedback(4, "유등터널 입구에 사람이 몰려서 밀려요");
    await db.pull_inbox();
    const replayFid = await db.insert_feedback(1, "주차장이 만차예요", "replay");
    const feed = Object.fromEntries((await webapi.get_control()).feed.map((f: any) => [f.raw_text, f]));
    assert.equal(feed["유등터널 입구에 사람이 몰려서 밀려요"].receipt_no, web);
    assert.ok(feed["주차장이 만차예요"].receipt_no === null && feed["주차장이 만차예요"].id === replayFid);
  });
});

test("test_민원지우기_집계에서_빠지고_복구하면_돌아온다", async (t) => {
  const m = await need(t, "agents/dispatcher.ts", "agents/classifier.ts", "core/issues.ts", "webapi.ts"); if (!m) return;
  const [dispatcher, classifier, issues, webapi] = m;
  await withTempDb(async (db) => {
    const ids = await seed(db, [[4, "safety", 9, -0.8, true, "유등터널 계단 조명이 꺼져 있어요"],
                                [4, "safety", 6, -0.8, true, "계단 난간이 흔들려서 위험해요"],
                                [4, "safety", 3, -0.8, true, "바닥이 미끄러워서 넘어졌어요"],
                                [1, "parking", 2, -0.5, false, "주차장이 만차예요"]]);
    const pend = await db.insert_feedback(1, "주차장 안내가 없어요", "test");
    const rev = await db.insert_feedback(1, "좀 그랬어요", "test");
    await run(db, "UPDATE classification SET status='review', is_safety=1, confidence=0.1 WHERE feedback_id=?", [rev]);
    const snap = async () => {
      await issues.refresh();
      return {
        counts: await db.label_counts(),
        freq: Object.fromEntries((await db.ranked()).map((r: any) => [r.label, r.freq])),
        feed: (await db.recent_feedback(20)).map((r: any) => r.id),
        pending: await db.pending_count(), pending_rows: (await classifier.get_pending.fn(20)).map((p: any) => p.id),
        review: [await db.review_count(), await db.review_safety_count()],
        quotes: (await dispatcher.collect_quotes.fn("safety")).map((q: any) => q.raw_text),
        cards: (await cards()).map((c: any) => [c.key, c.freq]),
        control: await webapi.get_control(),
      };
    };
    const base = await snap();
    assert.ok(base.counts.safety === 3 && base.pending === 1);
    assert.deepEqual(base.review, [1, 1]);
    assert.ok(base.pending_rows.includes(pend) && base.feed.includes(rev));

    await db.set_feedback_deleted(ids[0], true);
    let s = await snap();
    assert.ok(s.counts.safety === 2 && s.freq.safety === 2);
    assert.ok(!s.feed.includes(ids[0]) && !s.quotes.includes("유등터널 계단 조명이 꺼져 있어요"));
    assert.equal(Object.fromEntries(s.cards)["safety:4"], 2);
    assert.ok(s.control.deleted === 1 && !s.control.feed.map((f: any) => f.id).includes(ids[0]));
    assert.equal(s.control.total, base.control.total - 1);
    assert.equal(s.control.issues.filter((x: any) => x.issue_key === "safety:4")[0].freq, 2);

    await db.set_feedback_deleted(pend, true);
    await db.set_feedback_deleted(rev, true);
    s = await snap();
    assert.ok(s.pending === 0 && !s.pending_rows.includes(pend));
    assert.deepEqual(s.review, [0, 0]);
    assert.equal(s.control.deleted, 3);

    for (const i of ids.slice(0, 3)) await db.set_feedback_deleted(i, true);
    assert.ok(!("safety" in (await db.label_counts())) && (await cards()).every((c: any) => c.label !== "safety"));
    await issues.refresh();
    assert.ok(!(await issues.list_active()).map((x: any) => x.issue_key).includes("safety:4"));

    for (const i of [...ids.slice(0, 3), pend, rev]) await db.set_feedback_deleted(i, false);
    const back = await snap();
    for (const k of ["counts", "freq", "feed", "pending", "pending_rows", "review", "quotes", "cards"] as const) {
      assert.deepEqual((back as any)[k], (base as any)[k], k);
    }
    assert.equal(back.control.deleted, 0);

    for (const bad of [999999, "abc", null]) {
      for (const fn of [webapi.delete_feedback, webapi.restore_feedback]) {
        await rejects(() => fn(bad), (e) => { assert.ok(e instanceof webapi.ApiError); assert.ok(e.message.includes("없는 민원")); });
      }
    }
    await rejects(() => db.set_feedback_deleted(999999, true), (e) => assert.ok(e instanceof db.KeyError));
    await webapi.delete_feedback(ids[0]);
    await webapi.delete_feedback(ids[0]);
    await webapi.restore_feedback(ids[1]);
    assert.equal(await db.deleted_count(), 1);
    assert.equal(webapi.RPC.delete_feedback[0], webapi.delete_feedback);   // TS RPC 표 항목은 [fn, 필수, 선택]
  });
});

test("test_지운_민원_목록_최신순_되돌리면_빠진다", async (t) => {
  const m = await need(t, "core/config.ts"); if (!m) return;
  const config = cfgOf(m[0]);
  await withTempDb(async (db) => {
    const ids = await seed(db, [[1, "restroom", 9, -0.5, false, "화장실 줄이 너무 길어요"],
                                [null, "price", 6, -0.5, false, "어묵이 너무 비싸요"],
                                [3, "guide", 3, -0.5, false, "표지판이 없어서 헤맸어요"]]);
    assert.deepEqual(await db.list_deleted(), []);
    const base = nowSec();
    await db.set_feedback_deleted(ids[0], true, iso(ago(base, 2)));
    await db.set_feedback_deleted(ids[1], true, iso(base));
    const rs = await db.list_deleted();
    assert.deepEqual(rs.map((r: any) => r.id), [ids[1], ids[0]]);
    assert.ok(rs[0].zone === config.ZONE_UNKNOWN && rs[0].label === "price" && rs[0].status === "done");
    assert.ok(rs[1].raw_text === "화장실 줄이 너무 길어요" && rs[1].deleted_at);
    assert.equal((await db.list_deleted(1)).length, 1);
    await db.set_feedback_deleted(ids[1], false);
    assert.deepEqual((await db.list_deleted()).map((r: any) => r.id), [ids[0]]);
  });
});

test("test_운영자코드_없음_틀림_5회잠김_맞음", async (t) => {
  const m = await need(t, "core/admin.ts"); if (!m) return;
  const [admin] = m;
  await withTempDb(async (db) => withAdminCode("tmp-operator-code", async () => {
    const status = async (code: any) => {
      try { await admin.verify(code); } catch (e: any) { if (e instanceof admin.AdminError) return e.status; throw e; }
      return 200;
    };
    assert.ok((await status(null)) === 401 && (await status("")) === 401);
    assert.equal((await one(db, "SELECT COUNT(*) c FROM admin_attempt")).c, 0);
    assert.equal(await status("wrong"), 401);
    assert.equal(await status("tmp-operator-code"), 200);
    assert.equal(await admin.recent_failures(), 0);
    for (let i = 0; i < 5; i++) assert.equal(await status("wrong"), 401);
    assert.equal(await admin.recent_failures(), 5);
    assert.equal(await status("wrong"), 429);
    assert.equal(await status("tmp-operator-code"), 429);
    assert.equal(await status(null), 429);
    assert.equal(await admin.recent_failures(), 5);
    await run(db, "UPDATE admin_attempt SET at='2000-01-01T00:00:00'");
    assert.equal(await status("tmp-operator-code"), 200);
    assert.equal(await admin.recent_failures(), 0);
  }));
});

/** 테스트용 webapi HTTP 서버 — Python webapi.ExclusiveServer(("127.0.0.1", 0), Handler). TS 쪽 이름은 [서버]·[화면]과 맞춘다. */
async function startServer(webapi: any): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = webapi.create_server ? await webapi.create_server() : webapi.ExclusiveServer ? new webapi.ExclusiveServer() : null;
  if (!srv) throw new Error("webapi 에 create_server() 가 없다 — [화면] 이름 확인");
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  return { port: (srv.address() as any).port, close: () => new Promise<void>((res) => srv.close(() => res())) };
}

async function post(port: number, name: string, body: any = {}, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api/rpc/${encodeURIComponent(name)}`, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  });
  let data: any = null;
  try { data = await r.json(); } catch { /* 본문 없음 */ }
  return [r.status, data] as const;
}

test("test_운영자코드_잠금은_출처별_다른_출처_운영자는_통과", async (t) => {
  const m = await need(t, "core/admin.ts", "core/source_id.ts", "webapi.ts"); if (!m) return;
  const [admin, source_id, webapi] = m;
  const a = await source_id.source_hash("203.0.113.7"), b = await source_id.source_hash("198.51.100.9");
  assert.ok(a && b && a !== b && a.length === 16 && !a.includes("203.0.113.7"));
  assert.equal(await source_id.source_hash("203.0.113.7"), a);
  assert.ok((await source_id.source_hash(null)) === "" && (await source_id.client_ip("203.0.113.7", "1.2.3.4")) === "203.0.113.7");
  assert.equal(await source_id.client_ip("127.0.0.1", "10.0.0.1"), "10.0.0.1");
  assert.equal(await source_id.client_ip("127.0.0.1", "1.2.3.4, 10.0.0.1"), "10.0.0.1");
  assert.equal(await source_id.client_ip("::1", "9.9.9.9, 10.0.0.2"), "10.0.0.2");
  assert.equal(await source_id.client_ip("203.0.113.7", "1.2.3.4"), "203.0.113.7");
  assert.ok((await source_id.client_ip("127.0.0.1", null)) === "127.0.0.1" && (await source_id.client_ip("127.0.0.1", " ")) === "127.0.0.1");
  assert.equal(await source_id.client_source("127.0.0.1", "1.1.1.1, 198.51.100.9"), await source_id.client_source("127.0.0.1", "2.2.2.2, 198.51.100.9"));
  assert.equal(await source_id.client_source("203.0.113.7", "1.1.1.1"), await source_id.client_source("203.0.113.7", "2.2.2.2"));
  await withTempDb(async (db) => withAdminCode("tmp-operator-code", async () => {
    const status = async (code: any, src: any) => {
      try { await admin.verify(code, src); } catch (e: any) { if (e instanceof admin.AdminError) return e.status; throw e; }
      return 200;
    };
    for (let i = 0; i < 5; i++) assert.equal(await status("wrong", a), 401);
    assert.ok((await status("wrong", a)) === 429 && (await status("tmp-operator-code", a)) === 429);
    assert.equal(await status("tmp-operator-code", b), 200);
    assert.ok((await admin.recent_failures(a)) === 5 && (await admin.recent_failures(b)) === 0);
    assert.ok((await status("wrong", b)) === 401 && (await admin.recent_failures(b)) === 1);
    assert.ok((await status("tmp-operator-code", b)) === 200 && (await admin.recent_failures(b)) === 0);
    assert.equal(await admin.recent_failures(a), 5);
    for (let i = 0; i < 5; i++) await status("wrong", null);
    assert.ok((await status("tmp-operator-code", null)) === 429 && (await status("tmp-operator-code", b)) === 200);
    const srcs = new Set((await all(db, "SELECT src FROM admin_attempt")).map((r: any) => r.src));
    assert.ok([...srcs].every((s) => s === a || s === "") && [...srcs].every((s) => !String(s).includes(".")));
    await run(db, "UPDATE admin_attempt SET at='2000-01-01T00:00:00'");
    assert.equal(await status("tmp-operator-code", b), 200);
    assert.equal((await one(db, "SELECT COUNT(*) c FROM admin_attempt")).c, 0);
    const srv = await startServer(webapi);
    try {
      const p = (code: string, xff: string) => post(srv.port, "check_admin", {}, { "X-Admin-Code": code, "X-Forwarded-For": xff }).then((r) => r[0]);
      for (let i = 0; i < 5; i++) await p("wrong", "203.0.113.7");
      assert.equal(await p("tmp-operator-code", "203.0.113.7"), 429);
      assert.equal(await p("tmp-operator-code", "198.51.100.9"), 200);
      assert.equal(await p("tmp-operator-code", "9.9.9.9, 203.0.113.7"), 429);
      assert.equal(await p("tmp-operator-code", "203.0.113.7, 198.51.100.9"), 200);
    } finally {
      await srv.close();
    }
  }));
});

test("test_운영자코드_미설정이면_관리자_동작은_전부_거부", async (t) => {
  const m = await need(t, "core/admin.ts", "webapi.ts"); if (!m) return;
  const [admin, webapi] = m;
  await withTempDb(async () => withAdminCode("", async () => {
    for (const code of [null, "", "anything", "x".repeat(40)]) {
      await rejects(() => admin.verify(code), (e) => { assert.ok(e instanceof admin.AdminError); assert.ok(e.status === 403 && e.message.includes("운영자 코드가 필요합니다")); });
    }
    for (const name of [...webapi.ADMIN_RPC].sort()) {
      await rejects(() => webapi.call_rpc(name, { p_id: 1, p_label: "safety", p_status: "done" }, "anything"),
        (e) => { assert.ok(e instanceof admin.AdminError); assert.equal(e.status, 403, name); });
    }
    assert.ok((await webapi.call_rpc("submit_feedback", { p_zone_id: 1, p_text: "진입로가 너무 어두워요" })) > 0);
  }));
});

test("test_운영자코드_관리자RPC는_코드가_맞아야_실행된다", async (t) => {
  const m = await need(t, "core/admin.ts", "webapi.ts"); if (!m) return;
  const [admin, webapi] = m;
  await withTempDb(async (db) => withAdminCode("tmp-operator-code", async () => {
    const ids = await seed(db, [[4, "safety", 3, -0.8, true, "유등터널 계단 조명이 꺼져 있어요"]]);
    await run(db, "INSERT INTO action_request (label, department, status, created_at) VALUES ('safety', '안전총괄과', 'requested', ?)", [await db.now()]);
    const calls: Record<string, any> = {
      delete_feedback: { p_id: ids[0] }, restore_feedback: { p_id: ids[0] },
      set_action_status: { p_id: 1, p_status: "in_progress" }, request_doc: { p_label: "safety" },
      resolve_review: { p_id: ids[0], p_label: "safety" }, dismiss_review: { p_id: ids[0] }, reopen_review: { p_id: ids[0] },
      check_admin: {}, list_deleted: {},
    };
    assert.deepEqual(new Set(Object.keys(calls)), new Set(webapi.ADMIN_RPC));
    for (const [name, args] of Object.entries(calls)) {
      for (const bad of [null, "", "wrong-code"]) {
        await rejects(() => webapi.call_rpc(name, args, bad), (e) => { assert.ok(e instanceof admin.AdminError); assert.equal(e.status, 401, `${name} ${bad}`); });
      }
      await run(db, "DELETE FROM admin_attempt");
    }
    assert.equal(await db.deleted_count(), 0);
    await run(db, "DELETE FROM admin_attempt");
    await webapi.call_rpc("delete_feedback", calls.delete_feedback, "tmp-operator-code");
    assert.equal(await db.deleted_count(), 1);
    const listed = await webapi.call_rpc("list_deleted", {}, "tmp-operator-code");
    assert.ok(listed.ok === true);
    assert.deepEqual(listed.items.map((x: any) => x.id), [ids[0]]);
    await webapi.call_rpc("restore_feedback", { ...calls.restore_feedback, p_code: "tmp-operator-code" });
    assert.equal(await db.deleted_count(), 0);
    await webapi.call_rpc("set_action_status", calls.set_action_status, "tmp-operator-code");
    assert.equal((await one(db, "SELECT status FROM action_request WHERE id=1")).status, "in_progress");
    assert.ok((await webapi.call_rpc("request_doc", calls.request_doc, "tmp-operator-code")) > 0);
    assert.equal(await webapi.call_rpc("check_admin", {}, "tmp-operator-code"), true);
    for (let i = 0; i < 5; i++) { try { await webapi.call_rpc("check_admin", {}, "wrong-code"); } catch (e) { if (!(e instanceof admin.AdminError)) throw e; } }
    try { await webapi.call_rpc("check_admin", {}, "tmp-operator-code"); } catch (e: any) { assert.equal(e.status, 429); }
    assert.ok((await webapi.call_rpc("submit_feedback", { p_zone_id: 1, p_text: "주차장이 너무 혼잡해요" })) > 0);
    await rejects(() => webapi.call_rpc("없는함수", {}));                         // Python: KeyError
  }));
});

test("test_운영자코드_HTTP_상태코드와_헤더", async (t) => {
  const m = await need(t, "webapi.ts"); if (!m) return;
  const [webapi] = m;
  await withTempDb(async (db) => {
    const ids = await seed(db, [[4, "safety", 3, -0.8, true, "유등터널 계단 조명이 꺼져 있어요"]]);
    const srv = await startServer(webapi);
    try {
      await withAdminCode("", async () => {
        const [s, r] = await post(srv.port, "delete_feedback", { p_id: ids[0] }, { "X-Admin-Code": "anything" });
        assert.ok(s === 403 && r.error.includes("운영자 코드가 필요합니다"));
      });
      await withAdminCode("tmp-operator-code", async () => {
        let [s, r] = await post(srv.port, "delete_feedback", { p_id: ids[0] });
        assert.ok(s === 401 && r.error.includes("운영자 코드가 필요합니다"));
        [s] = await post(srv.port, "delete_feedback", { p_id: ids[0] }, { "X-Admin-Code": "wrong" });
        assert.equal(s, 401);
        assert.equal(await db.deleted_count(), 0);
        [s] = await post(srv.port, "delete_feedback", { p_id: ids[0] }, { "X-Admin-Code": "tmp-operator-code" });
        assert.ok(s === 200 && (await db.deleted_count()) === 1);
        [s, r] = await post(srv.port, "delete_feedback", { p_id: 999999 }, { "X-Admin-Code": "tmp-operator-code" });
        assert.ok(s === 400 && r.error.includes("없는 민원"));
        [s] = await post(srv.port, "submit_feedback", { p_zone_id: 1, p_text: "진입로가 너무 어두워요" });
        assert.equal(s, 200);
        for (let i = 0; i < 5; i++) await post(srv.port, "check_admin", {}, { "X-Admin-Code": "wrong" });
        [s] = await post(srv.port, "check_admin", {}, { "X-Admin-Code": "tmp-operator-code" });
        assert.equal(s, 429);
        [s] = await post(srv.port, "submit_feedback", { p_zone_id: 1, p_text: "주차장이 만차예요" });
        assert.equal(s, 200);
        [s] = await post(srv.port, "없는함수");
        assert.equal(s, 404);
      });
    } finally {
      await srv.close();
    }
  });
});

test("test_도배방지_같은글_합치기_출처별_제한_구역몰림_표시", async (t) => {
  const m = await need(t, "webapi.ts", "core/intake.ts", "core/source_id.ts", "core/config.ts"); if (!m) return;
  const [webapi, intake, source_id, C] = m; const config = cfgOf(C);
  await withTempDb(async (db) => {
    const rowsOf = async () => (await all(db, "SELECT id, dup_count FROM feedback_inbox ORDER BY id")).map((r: any) => [r.id, r.dup_count]);
    const a = await webapi.submit_feedback(1, "화장실 휴지가 다 떨어졌어요");
    const b = await webapi.submit_feedback(1, "화장실  휴지가 다 떨어졌어요!!!");
    assert.equal(a, b);
    assert.deepEqual(await rowsOf(), [[a, 1]]);
    assert.equal(await webapi.submit_feedback(1, "화장실 휴지가 다 떨어졌어요"), a);
    assert.deepEqual(await rowsOf(), [[a, 2]]);
    const c = await webapi.submit_feedback(2, "화장실 휴지가 다 떨어졌어요");
    const d = await webapi.submit_feedback(1, "화장실 휴지가 없고 줄도 길어요");
    assert.equal(new Set([a, c, d]).size, 3);
    const sn = await intake.seoul_now();
    await run(db, "UPDATE feedback_inbox SET created_at=? WHERE id=?", [iso(new Date(sn.getTime() - 3 * 60_000)), a]);
    const e = await webapi.submit_feedback(1, "화장실 휴지가 다 떨어졌어요!");
    assert.ok(![a, c, d].includes(e));
    assert.ok((await db.pull_inbox()) >= 3);
    const fid = (await one(db, "SELECT feedback_id FROM feedback_inbox WHERE id=?", [e])).feedback_id;
    assert.equal((await one(db, "SELECT dup_count FROM feedback WHERE id=?", [fid])).dup_count, 0);
    assert.equal(await webapi.submit_feedback(1, "화장실 휴지가 다 떨어졌어요"), e);
    assert.equal((await one(db, "SELECT dup_count FROM feedback WHERE id=?", [fid])).dup_count, 1);
    const cols = new Set((await all(db, "PRAGMA table_info(feedback)")).map((r: any) => r.name));
    assert.ok(!["src", "ip", "source_hash"].some((k) => cols.has(k)));
    const srcA = await source_id.source_hash("203.0.113.7"), srcB = await source_id.source_hash("198.51.100.9");
    for (let i = 0; i < 10; i++) await webapi.submit_feedback(3, `표지판이 없어서 헤맸어요 ${i}번째 이야기`, srcA);
    await rejects(() => webapi.submit_feedback(3, "표지판이 없어서 헤맸어요 열한번째 이야기", srcA), (ex) => {
      assert.ok(ex instanceof webapi.ApiError);
      assert.ok(ex.message === "잠시 후 다시 보내 주세요" && !ex.message.includes("10"));
    });
    assert.ok((await webapi.submit_feedback(3, "표지판이 없어서 헤맸어요 열한번째 이야기", srcB)) > 0);
    assert.ok((await webapi.submit_feedback(3, "출처를 모르는 접수도 그대로 통과해요", null)) > 0);
    await run(db, "UPDATE submit_rate SET at='2000-01-01T00:00:00' WHERE src=?", [srcA]);
    assert.ok((await webapi.submit_feedback(3, "하루 뒤에는 다시 보낼 수 있어요 정말로", srcA)) > 0);
    assert.equal((await one(db, "SELECT COUNT(*) c FROM submit_rate WHERE at < '2001'")).c, 0);
    assert.ok(!JSON.stringify(await all(db, "SELECT * FROM submit_rate")).includes("203.0.113.7"));
    await withConfig({ DEDUP_ENABLED: false }, async () => {
      const x = await webapi.submit_feedback(4, "끄면 같은 글도 그대로 들어가요 정말");
      const y = await webapi.submit_feedback(4, "끄면 같은 글도 그대로 들어가요 정말");
      assert.notEqual(x, y);
    });
    await seed(db, [[5, "restroom", 5, -0.6, false, "화장실 줄이 너무 길어요"]]);
    const before = (await db.ranked()).map((r: any) => [r.label, r.score]);
    assert.deepEqual(await intake.zone_burst(), []);
    for (let i = 0; i < config.CROWD_FLAG_MIN; i++) await webapi.submit_feedback(5, `유등터널 입구가 붐벼서 밀려요 ${i}번째 사람`, null);
    const burst = (await webapi.get_control()).crowding;
    assert.ok(burst.length === 1 && burst[0].zone_id === 5 && burst[0].count >= config.CROWD_FLAG_MIN);
    assert.deepEqual((await db.ranked()).map((r: any) => [r.label, r.score]), before);
  });
});

test("test_도배방지_동시접수_합치기_정리", async (t) => {
  const m = await need(t, "core/intake.ts", "core/source_id.ts"); if (!m) return;
  const [intake, source_id] = m;
  await withTempDb(async (db) => {
    // Python 은 스레드 8개 + Barrier. TS 는 한 스레드라 Promise 8개를 동시에 띄운다 (await 사이에서 끼어들 수 있게).
    const ids = await Promise.all(Array.from({ length: 8 }, () => intake.accept(1, "유등터널 입구가 너무 붐벼서 밀려요 동시에")));
    const rs = (await all(db, "SELECT id, dup_count FROM feedback_inbox")).map((r: any) => [r.id, r.dup_count]);
    assert.ok(rs.length === 1 && rs[0][1] === 7);
    assert.deepEqual(new Set(ids), new Set([rs[0][0]]));
    const sn = await intake.seoul_now();
    const old = iso(new Date(sn.getTime() - 25 * 3_600_000));
    await run(db, "INSERT INTO submit_rate (src, at) VALUES ('x', ?)", [old]);
    await run(db, "INSERT INTO submit_rate (src, at) VALUES ('y', ?)", [await intake._stamp(await intake.seoul_now())]);
    await run(db, "INSERT INTO admin_attempt (at, src) VALUES (?, 'x')", [old]);
    assert.equal(await intake.purge_old(), 2);
    assert.deepEqual((await all(db, "SELECT src FROM submit_rate")).map((r: any) => r.src), ["y"]);
    assert.equal((await one(db, "SELECT COUNT(*) c FROM admin_attempt")).c, 0);
    const h = await source_id.source_hash("203.0.113.7");
    source_id._keys.clear();
    assert.notEqual(await source_id.source_hash("203.0.113.7"), h);
  });
  const sql = readFileSync(join(ROOT, "supabase", "schema.sql"), "utf8");
  assert.ok(sql.includes("v_limit_on constant boolean := false") && !sql.includes("nokey"));
  assert.ok(sql.includes("pg_advisory_xact_lock"));
});
