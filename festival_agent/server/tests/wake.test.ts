// D5-71 접수→분류 대기 줄이기 — 깨우기(Wake)·비어 있을 때 쿼리 수·LISTEN 실패 시 폴링 예비. 임시 SQLite 만 쓴다.
// (실제 대기 시간 전후 비교는 wall_clock.ts --backend local 로: 중앙값 2.2s→0.5s, 최대 3.1s→1.0s)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { need, withTempDb, withConfig } from "./_helpers.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("test_Wake_는_기다리기_전_알림도_놓치지_않고_기다리는_중이면_바로_깨운다", async (t) => {
  const m = await need(t, "worker.ts"); if (!m) return;
  const [worker] = m;
  const w = new worker.Wake();
  const t0 = Date.now();
  w.notify();                                           // 아직 아무도 안 기다린다 → 기억해 둔다
  await w.wait(2000);
  assert.ok(Date.now() - t0 < 200, "먼저 온 알림은 다음 wait 이 바로 끝나야 한다");
  const t1 = Date.now();
  setTimeout(() => w.notify(), 50);
  await w.wait(2000);                                   // 기다리는 중에 오면 일찍 깬다
  assert.ok(Date.now() - t1 < 500);
  const t2 = Date.now();
  await w.wait(120);                                    // 알림이 없으면 시간이 차서 끝난다 (예비 폴링)
  assert.ok(Date.now() - t2 >= 100);
});

test("test_수거_루프는_비어_있을_때_DB_문장_1개만_돌고_새_접수가_오면_분류_루프를_깨운다", async (t) => {
  const m = await need(t, "worker.ts", "core/db.ts"); if (!m) return;
  const [worker, db] = m;
  await withTempDb(async (d) => {
    // DatabaseSync.prepare 호출 수로 '쿼리 수'를 센다
    const proto = DatabaseSync.prototype as any;
    const orig = proto.prepare;
    let count = 0;
    proto.prepare = function (...a: any[]) { count++; return orig.apply(this, a); };
    try {
      await worker.ingest_tick();                        // 첫 틱은 리플레이 상태도 한 번 본다
      count = 0;
      for (let i = 0; i < 3; i++) assert.equal(await worker.ingest_tick(), 0);
      assert.equal(count, 3, `비어 있을 때 틱마다 문장 1개여야 한다 (3틱에 ${count}개)`);
    } finally {
      proto.prepare = orig;
    }

    // 접수가 들어오면 한 틱에 옮기고, 분류 루프가 기다리던 wait 이 바로 끝난다
    const conn = await db.connect();
    await conn.execute("INSERT INTO feedback_inbox (zone_id, text, created_at) VALUES (?,?,?)", [1, "화장실 휴지가 없어요", db.now()]);
    assert.equal(await worker.ingest_tick(), 1);
    const t0 = Date.now();
    await worker.classify_wake.wait(3000);
    assert.ok(Date.now() - t0 < 200, "수거가 새 민원을 만들면 분류 루프가 바로 깨어야 한다");
    assert.equal(await db.pending_count(), 1);
  });
});

test("test_접수_알림_LISTEN_이_안_되면_조용히_폴링으로_돌아간다", async (t) => {
  const m = await need(t, "core/inbox_listen.ts"); if (!m) return;
  const [listen] = m;
  const logs: string[] = [];
  // 닫힌 포트 — 연결이 거절된다 (실제 DB 에 닿지 않는다)
  await withConfig({ SUPABASE_DB_URL: "postgres://nobody:pw@127.0.0.1:1/none" }, async () => {
    const l = listen.start_listener(() => assert.fail("알림이 올 리 없다"), (s: string) => logs.push(s));
    assert.equal(l.live(), false);
    const t0 = Date.now();
    while (!logs.length && Date.now() - t0 < 5000) await sleep(50);
    assert.ok(logs.some((s) => s.includes("폴링")), JSON.stringify(logs));
    assert.equal(l.live(), false);                      // 폴링이 예비로 받는다
    await l.stop();                                     // 다시 붙으려는 타이머도 멈춘다
  });
});

test("recompute_now: 워커 시작 때 새 민원 없이도 심각도 스냅샷과 카드를 다시 계산한다 (조치 완료 반영 포함)", async (t) => {
  const m = await need(t, "worker.ts", "core/db.ts"); if (!m) return;
  const [worker, db] = m;
  const { withTempDb, withLocalBackend, seed, all, run } = await import("./_helpers.ts");
  await withLocalBackend(async () => withTempDb(async (conn) => {
    await seed(conn, [[1, "parking", 5, -0.5, false, "주차장이 만차예요 하나"], [2, "safety", 4, -0.8, true, "계단 난간이 흔들려서 위험해요"]]);
    assert.equal((await all(conn, "SELECT * FROM severity")).length, 0);          // 아직 계산 안 됨 (워커가 막 켜진 상태)
    await worker.recompute_now();
    const labels = async () => (await all(conn, `SELECT label FROM severity WHERE as_of=(SELECT MAX(as_of) FROM severity)`)).map((r: any) => r.label).sort();
    assert.deepEqual(await labels(), ["parking", "safety"]);
    assert.ok((await all(conn, "SELECT * FROM issue WHERE active=1 AND label='safety'")).length === 1);       // 카드도 계산됨
    await run(conn, "INSERT INTO action_request (label, department, status, created_at, closed_at) VALUES ('parking','교통과','done',?,?)", [await db.now(), "2999-01-01T00:00:00"]);
    await new Promise((r) => setTimeout(r, 1100));                                  // 스냅샷 시각(초)이 달라지게
    await worker.recompute_now();                                                   // 새 민원 없음 — 재계산만으로 완료된 유형이 빠진다
    assert.deepEqual(await labels(), ["safety"]);
  }));
});
