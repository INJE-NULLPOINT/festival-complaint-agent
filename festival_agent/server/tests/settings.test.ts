// D5-90 운영자 설정 — 축제 이름·기간, 구역(이름 변경·숨김), 유형별 담당 부서·연락처. 임시 SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, seed, rejects, all, one } from "./_helpers.ts";

test("test_담당_부서_연락처를_바꾸면_카드와_조치_도구가_저장값을_쓰고_다시_시작해도_안_되돌아간다", async (t) => {
  const m = await need(t, "webapi.ts", "core/settings.ts", "core/issues.ts", "agents/dispatcher.ts"); if (!m) return;
  const [webapi, settings, issues, dispatcher] = m;
  await withTempDb(async (db) => {
    await seed(db, Array.from({ length: 3 }, (_, i): [number, string, number, number, boolean, string] => [4, "safety", 8 - i, -0.9, true, `유등터널 난간이 흔들려요 ${i}번째`]));
    // 기본값 — 예시 번호
    const s0 = (await webapi.get_settings()) as any;
    const d0 = s0.departments.find((d: any) => d.label === "safety");
    assert.deepEqual([d0.department, d0.contact, d0.is_example], ["안전총괄과", "055-000-0005", true]);
    assert.equal(s0.departments.length, 6);
    // 저장 → 카드·도구가 저장값, 예시 표시는 사라짐
    await webapi.save_department("safety", "재난안전과", "055-749-1234");
    const card = (await issues.build_cards()).find((c: any) => c.label === "safety");
    assert.deepEqual([card.department, card.contact], ["재난안전과", "055-749-1234"]);
    assert.equal((await dispatcher.get_department.fn("safety")).department, "재난안전과");
    const d1 = ((await webapi.get_settings()) as any).departments.find((d: any) => d.label === "safety");
    assert.deepEqual([d1.contact, d1.is_example], ["055-749-1234", false]);
    await db.init_db();                                                            // 다시 시작해도 운영자가 바꾼 값을 되돌리지 않는다
    settings.invalidate();
    assert.equal((await settings.department_map()).safety[0], "재난안전과");
    // 검증: 연락처 형식·빈 부서·없는 유형
    for (const bad of ["abc", "055 749 1234", "055--749", "-055-1234", "12", "055-749-1234-"]) {
      await rejects(() => webapi.save_department("safety", "부서", bad), (e) => assert.ok(e instanceof webapi.ApiError && e.message.includes("연락처"), bad));
    }
    for (const ok of ["119", "1577-1234", "010-1234-5678"]) await webapi.save_department("guide", "관광진흥과", ok);
    await rejects(() => webapi.save_department("safety", "  ", "055-123-4567"), (e) => assert.ok(e.message.includes("담당 부서")));
    await rejects(() => webapi.save_department("positive", "과", "055-123-4567"), (e) => assert.ok(e.message.includes("유형")));
  });
});

test("test_구역은_지우지_않고_이름_변경_숨김만_숨긴_구역은_방문객_목록에서_빠진다", async (t) => {
  const m = await need(t, "webapi.ts", "core/settings.ts", "agents/common.ts"); if (!m) return;
  const [webapi, settings, common] = m;
  await withTempDb(async (db) => {
    const zones0 = (await webapi.get_zones()) as any[];
    assert.equal(zones0.length, 8);
    const tunnel = zones0.find((z) => z.name === "유등터널");
    await seed(db, [[tunnel.id, "safety", 3, -0.8, true, "유등터널 난간이 흔들려요"]]);
    // 이름 변경 — id 는 그대로, 민원은 새 이름으로 이어진다. 다시 시작해도 옛 이름 구역이 새로 생기지 않는다
    await webapi.rename_zone(tunnel.id, "유등 터널 구간");
    await db.init_db();
    settings.invalidate();
    const rows = await settings.zone_rows();
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.find((z: any) => z.id === tunnel.id), { id: tunnel.id, name: "유등 터널 구간", hidden: 0, feedback_count: 1 });
    // 숨김 — 민원이 달린 구역도 숨기기만 (행은 남는다), 방문객 목록·에이전트 구역 도구에서만 빠진다
    await webapi.set_zone_hidden(tunnel.id, true);
    assert.ok(!((await webapi.get_zones()) as any[]).some((z) => z.id === tunnel.id));
    assert.ok(!(await common.get_zones.fn()).includes("유등 터널 구간"));
    assert.equal((await one(db, "SELECT COUNT(*) c FROM zone WHERE id=?", [tunnel.id])).c, 1);
    assert.equal((((await webapi.get_settings()) as any).zones as any[]).find((z: any) => z.id === tunnel.id).hidden, 1);   // 설정 화면에는 숨긴 것도
    await webapi.set_zone_hidden(tunnel.id, false);
    assert.ok(((await webapi.get_zones()) as any[]).some((z) => z.id === tunnel.id));
    // 추가·검증
    const added = (await webapi.add_zone("새 전망대")) as any;
    assert.ok(added.id > 0 && ((await webapi.get_zones()) as any[]).some((z) => z.name === "새 전망대"));
    await rejects(() => webapi.add_zone("새 전망대"), (e) => assert.ok(e.message.includes("이미 있습니다")));
    await rejects(() => webapi.rename_zone(added.id, "촉석루 일원"), (e) => assert.ok(e.message.includes("이미 있습니다")));
    await rejects(() => webapi.add_zone("   "), (e) => assert.ok(e.message.includes("입력")));
    await rejects(() => webapi.rename_zone(99999, "아무개"), (e) => assert.ok(e.message.includes("없는 구역")));
    await rejects(() => webapi.set_zone_hidden(99999, true), (e) => assert.ok(e.message.includes("없는 구역")));
  });
});

test("test_축제_이름_기간을_바꾸면_공개_이름과_요청서가_저장값을_쓴다", async (t) => {
  const m = await need(t, "webapi.ts", "core/settings.ts"); if (!m) return;
  const [webapi, settings] = m;
  await withTempDb(async (db) => {
    assert.equal(((await webapi.get_festival()) as any).name, "진주남강유등축제");
    await webapi.save_festival("남강 가을 유등축제", "경상남도 진주시", "2026-10-02", "2026-10-11");
    assert.equal(((await webapi.get_festival()) as any).name, "남강 가을 유등축제");
    assert.deepEqual(((await webapi.get_settings()) as any).festival, { id: 1, name: "남강 가을 유등축제", region: "경상남도 진주시", start_date: "2026-10-02", end_date: "2026-10-11" });
    for (const [args, msg] of [[["", "지역", "2026-10-01", "2026-10-02"], "축제 이름"], [["이름", "지역", "2026/10/01", "2026-10-02"], "YYYY-MM-DD"],
      [["이름", "지역", "2026-10-05", "2026-10-02"], "빠를 수 없습니다"], [["이름", "", "2026-10-01", "2026-10-02"], "지역"]] as const) {
      await rejects(() => (webapi.save_festival as any)(...args), (e) => assert.ok(e.message.includes(msg), `${msg}: ${e.message}`));
    }
    // 요청서 머리에 쓰이는 축제 이름은 DB(festival) 값이다
    assert.equal((await one(db, "SELECT name FROM festival LIMIT 1")).name, "남강 가을 유등축제");
    // DB 가 비면 config 기본값
    await (await db.connect()).execute("DELETE FROM department_map");
    await (await db.connect()).execute("DELETE FROM festival");
    settings.invalidate();
    assert.equal((await settings.festival()).name, "진주남강유등축제");
    assert.equal((await settings.department_map()).parking[0], "교통과");
  });
});

test("test_설정_저장과_읽기는_코드_없이_된다", async (t) => {
  const m = await need(t, "webapi.ts"); if (!m) return;
  const [webapi] = m;
  await withTempDb(async () => {
    const ok = (await webapi.call_rpc("add_zone", { p_name: "코드 없이 추가" }, "s-ok")) as any;
    assert.ok(ok.id > 0);
    await rejects(() => webapi.call_rpc("add_zone", { p_name: "x", p_code: "무시" }, "s-x"), (e) => assert.ok(String(e.message).includes("unexpected keyword")));
    const s = (await webapi.call_rpc("get_settings", {}, "s2")) as any;
    assert.ok(s.festival && s.zones.length && s.departments.length === 6);
  });
});
