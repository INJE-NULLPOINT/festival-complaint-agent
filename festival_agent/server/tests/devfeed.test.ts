// D5-62 개발자 보기 데이터 — core/devfeed.ts · webapi dev_feed RPC / GET /api/dev · worker_status. 임시 SQLite 로만 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, withAdminCode, seed, rejects, one } from "./_helpers.ts";

test("test_dev_feed_모양_상한_증분", async (t) => {
  const m = await need(t, "core/devfeed.ts", "core/db.ts"); if (!m) return;
  const [dev, db] = m;
  await withTempDb(async () => {
    const empty = await dev.dev_feed(0, 0);
    assert.equal(empty.ok, true);
    assert.deepEqual([empty.logs, empty.classifications, empty.cards], [[], [], []]);
    assert.equal(empty.max_log_id, 0);
    assert.deepEqual(empty.status.loops, {});
    assert.equal(empty.status.tokens_today.input, 0);

    for (let i = 0; i < 250; i++) await db.log_agent("classifier", `act${i}`, `in${i}`, `out${i}`, "이유", 5, 100, 20, 3);
    const first = await dev.dev_feed(0, 0);
    assert.equal(first.logs.length, 200);                                          // 한 번에 최대 200행
    assert.ok(first.logs[0].id < first.logs[199].id);                              // 오래된 것부터
    assert.equal(first.logs[199].action, "act249");                                // since=0 은 가장 최근 200건
    for (const k of ["id", "created_at", "agent", "action", "input_summary", "output_summary", "reasoning", "latency_ms", "tokens_in", "tokens_out", "tokens_cache"]) {
      assert.ok(k in first.logs[0], k);
    }
    assert.deepEqual([first.logs[0].tokens_in, first.logs[0].tokens_out, first.logs[0].tokens_cache], [100, 20, 3]);
    assert.equal(first.max_log_id, first.logs[199].id);
    const none = await dev.dev_feed(first.max_log_id, 0);                           // 증분: 새 것이 없으면 빈 배열, max 는 그대로
    assert.deepEqual([none.logs.length, none.max_log_id], [0, first.max_log_id]);
    await db.log_agent("monitor", "새로운", "", "", "", 1);
    const inc = await dev.dev_feed(first.max_log_id, 0);
    assert.deepEqual(inc.logs.map((l: any) => l.action), ["새로운"]);
    assert.ok(inc.max_log_id > first.max_log_id);
    const old = await dev.dev_feed(1, 0);                                           // 뒤처졌으면 오래된 것부터 200건씩 따라잡는다
    assert.equal(old.logs.length, 200);
    assert.equal(old.logs[0].id, 2);
    assert.ok((await dev.dev_feed(-5, "x")).logs.length === 200);                   // 이상한 값은 0 으로
    assert.equal((await dev.dev_feed(0, 0)).status.tokens_today.input, 251 * 0 + 250 * 100);
  });
});

test("test_dev_feed_분류_심각도_카드_워커상태", async (t) => {
  const m = await need(t, "core/devfeed.ts", "core/db.ts", "core/issues.ts"); if (!m) return;
  const [dev, db, issues] = m;
  await withTempDb(async (d) => {
    const ids = await seed(d, [
      [4, "safety", 9, -0.8, true, "유등터널 계단 조명이 꺼져 있어요"], [4, "safety", 6, -0.8, true, "계단 난간이 흔들려요"],
      [4, "safety", 3, -0.9, true, "바닥이 미끄러워 넘어졌어요"], [1, "parking", 5, -0.5, false, "주차장이 만차예요"],
    ]);
    const long = "가".repeat(300);
    await db.insert_feedback(2, long, "qr");
    const ranked = await db.ranked(60);
    await db.save_severity(ranked, "60min");
    await issues.refresh(60);
    await db.set_worker_status("classify", 1234, true);
    await db.set_worker_status("agents", 50, false, "boom");
    await db.set_worker_status("_backend", 0, true, "local");
    const f = await dev.dev_feed(0, 0);

    const c = f.classifications.find((x: any) => x.feedback_id === ids[0]);
    assert.deepEqual([c.label, c.status, c.is_safety], ["safety", "done", 1]);
    for (const k of ["raw_text", "confidence", "agent_note", "suggested_label", "processed_at"]) assert.ok(k in c, k);
    assert.ok(f.classifications.every((x: any) => x.raw_text.length <= 120));        // 원문 앞부분만
    assert.ok(f.classifications[0].feedback_id > f.classifications.at(-1).feedback_id);   // 최신 먼저
    assert.equal(f.max_cls_id, Math.max(...f.classifications.map((x: any) => x.feedback_id)));

    const safety = f.severity.find((x: any) => x.label === "safety");
    assert.ok(safety.score > 0 && safety.formula && safety.grade === "immediate");
    assert.equal(safety.safety_freq, 3);
    assert.ok("spike_mult" in safety && "spike_w" in safety && "safety_w" in safety);
    assert.ok(f.severity[0].score >= f.severity.at(-1).score);

    const card = f.cards.find((x: any) => x.label === "safety");
    for (const k of ["issue_key", "card_score", "formula", "text_source", "fail_count", "grade", "freq", "type_freq", "zone_name"]) assert.ok(k in card, k);

    assert.equal(f.status.backend_llm, "local");
    assert.equal(f.status.loops.classify.took_ms, 1234);
    assert.deepEqual([f.status.loops.agents.ok, f.status.loops.agents.note], [0, "boom"]);
    assert.ok(!("_backend" in f.status.loops));
    await db.set_worker_status("classify", 99, true);                               // 같은 루프는 한 줄을 덮어쓴다
    assert.equal((await dev.dev_feed(0, 0)).status.loops.classify.took_ms, 99);
    assert.equal((await one(d, "SELECT COUNT(*) c FROM worker_status WHERE name='classify'")).c, 1);
  });
});

test("test_dev_feed_는_운영자_코드_없이_열리지만_관리자_동작은_그대로_잠겨_있다", async (t) => {
  const m = await need(t, "webapi.ts", "core/admin.ts"); if (!m) return;
  const [webapi, admin] = m;
  await withTempDb(async (db) => {
    await db.log_agent("classifier", "x", "", "", "", 1);
    assert.ok(!webapi.ADMIN_RPC.has("dev_feed"));
    for (const code of [null, "", "아무거나"]) {                                        // 코드가 없어도 틀려도 열린다 — p_code 는 무시
      const r = (await webapi.call_rpc("dev_feed", { p_since_log: 0, p_since_cls: 0, p_code: code }, null, "s-open")) as any;
      assert.equal(r.ok, true);
      assert.equal(r.logs.length, 1);
    }
    await withAdminCode("", async () => {                                              // 운영자 코드 미설정이어도 읽는다
      assert.equal(((await webapi.call_rpc("dev_feed", {}, null, "s-open")) as any).ok, true);
    });
    await withAdminCode("비밀-코드-123", async () => {
      for (const name of ["delete_feedback", "set_action_status", "request_doc", "list_deleted"]) {   // 관리자 동작은 그대로 401
        await rejects(() => webapi.call_rpc(name, { p_id: 1, p_status: "done", p_label: "safety" }, null, "s-open"),
          (e) => assert.ok(e instanceof admin.AdminError && e.status === 401, name));
      }
    });
    // 방문객용 응답(/api/control)에는 개발자 보기 값이 없다
    const control = JSON.stringify(await webapi.get_control());
    for (const leak of ["tokens_today", "worker_status", "reasoning", "input_summary", "spike_mult", "safety_freq", "fail_count", "card_score"]) {
      assert.ok(!control.includes(leak), `/api/control 에 ${leak} 이 나온다`);
    }
  });
});

test("test_dev_feed_호출_빈도는_출처별로_제한된다", async (t) => {
  const m = await need(t, "webapi.ts"); if (!m) return;
  const [webapi] = m;
  await withTempDb(async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < webapi.DEV_LIMIT; i++) webapi.dev_rate_check("src-A", t0 + i);
    assert.throws(() => webapi.dev_rate_check("src-A", t0 + 100), (e: any) => e instanceof webapi.TooManyRequests && e.status === 429);
    webapi.dev_rate_check("src-B", t0 + 100);                                          // 다른 출처는 영향 없음
    webapi.dev_rate_check("src-A", t0 + 61_000);                                       // 1분 지나면 다시 열린다
    for (let i = 0; i < webapi.DEV_LIMIT_SHARED; i++) webapi.dev_rate_check(null, t0 + i);   // 출처 모름 = 전체 공용 바구니
    assert.throws(() => webapi.dev_rate_check(null, t0 + 500), webapi.TooManyRequests);
  });
});

test("test_dev_feed_비밀값이_새지_않는다", async (t) => {
  const m = await need(t, "core/devfeed.ts", "core/db.ts", "core/config.ts"); if (!m) return;
  const [dev, db, cfg] = m;
  const config = cfg.config ?? cfg;
  await withTempDb(async (d) => {
    const secrets = {
      admin: "운영자-비밀-코드-9f3a", key: "svc-KEY-abcdef123456", dburl: "postgresql://postgres.abc:pw1234@aws-0.pooler.supabase.com:6543/postgres",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlc2lnbg", anth: "sk-ant-api03-ABCDEFGHIJKLMNOP",
      bcrypt: "$2a$10$" + "abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU", hash16: "9f86d081884c7d65", sha: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      ip: "203.0.113.77", phone: "010-1234-5678", email: "someone@example.com", rrn: "900101-1234567",
      path: "C:\\Users\\12kjm\\Desktop\\ai 대회\\festival_agent\\output\\조치요청서_안전총괄과.docx", url: "https://x.supabase.co/rest/v1/t?apikey=QUERYSECRET99",
    };
    const prev = [config.ADMIN_CODE, config.SUPABASE_SERVICE_KEY];
    config.ADMIN_CODE = secrets.admin; config.SUPABASE_SERVICE_KEY = secrets.key;
    try {
      const blob = Object.values(secrets).join(" | ");
      await db.log_agent("dispatcher", "generate_doc", blob, `끝 ${blob}`, blob, 3);
      await db.log_agent("dispatcher", "path_only", "", secrets.path, "", 1);
      // 저장할 때 잘려 앞부분만 남은 키·코드·해시도 가린다
      await db.log_agent("dispatcher", "truncated", secrets.key.slice(0, 11), secrets.admin.slice(0, 9), `${secrets.jwt.slice(0, 14)} ${secrets.anth.slice(0, 16)} ${secrets.sha.slice(0, 13)}`, 1);
      const ids = await seed(d, [[4, "safety", 3, -0.8, true, `난간이 위험해요 연락은 ${secrets.phone} ${secrets.email}`]]);
      await db.set_worker_status("issues", 5, false, `실패 ${blob}`);
      void ids;
      const out = JSON.stringify(await dev.dev_feed(0, 0));
      for (const [name, v] of Object.entries(secrets)) {
        const probe = name === "path" ? "festival_agent" : name === "url" ? "QUERYSECRET99" : name === "bcrypt" ? "abcdefghijklmnopqrstuv" : v;
        assert.ok(!out.includes(probe), `응답에 ${name} 이 새어 나온다`);
      }
      assert.ok(!out.includes("12kjm") && !out.includes("Desktop"));
      for (const part of [secrets.key.slice(0, 11), secrets.admin.slice(0, 9), secrets.jwt.slice(0, 14), secrets.anth.slice(0, 16), secrets.sha.slice(0, 13)]) {
        assert.ok(!out.includes(part), `잘린 앞부분이 새어 나온다: ${part}`);
      }
      for (const banned of ["code_hash", "operator_secret", "admin_attempt", "submit_rate", "\"src\""]) assert.ok(!out.includes(banned), banned);
      for (const mk of ["[경로]", "[키]", "[DB주소]", "[숨김]"]) assert.ok(out.includes(mk), mk);     // 가려졌다는 표시는 남는다      // 가려졌다는 표시는 남는다
      const f = JSON.parse(out);
      assert.ok(f.logs.length <= 200 && f.classifications.length <= 40);
    } finally {
      [config.ADMIN_CODE, config.SUPABASE_SERVICE_KEY] = prev;
    }
  });
});

test("test_GET_api_dev_는_코드_없이_200_과열되면_429", async (t) => {
  const m = await need(t, "webapi.ts"); if (!m) return;
  const [webapi] = m;
  await withTempDb(async (db) => withAdminCode("dev-code-1234", async () => {
    await db.log_agent("monitor", "하나", "", "", "", 1);
    const srv = await webapi.create_server();
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const ok = await fetch(`${base}/api/dev?since_log=0&since_cls=0`);            // 헤더 없이
      assert.equal(ok.status, 200);
      const body: any = await ok.json();
      assert.equal(body.data.ok, true);
      assert.equal(body.data.logs[0].action, "하나");
      const rpc = await fetch(`${base}/api/rpc/dev_feed`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_code: "무시됨", p_since_log: body.data.max_log_id }) });
      assert.equal(rpc.status, 200);
      const rb: any = await rpc.json();
      assert.deepEqual(rb.data.logs, []);                                              // 증분: max_log_id 이후는 없다
      let last = 200;
      for (let i = 0; i < webapi.DEV_LIMIT_SHARED + 5 && last === 200; i++) last = (await fetch(`${base}/api/dev`)).status;
      assert.equal(last, 429);                                                         // 너무 잦으면 429
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
    }
  }));
});
