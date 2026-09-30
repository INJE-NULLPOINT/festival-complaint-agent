// 추가 테스트 (Python 에 없음, 총괄 결정 6번) — 진짜 병렬 경합.
// Python test_도배방지_동시접수 는 스레드 8개로 같은 글을 동시에 넣는다. TS 본 테스트는 한 스레드의 Promise 8개라 경합이 약하다.
// 여기서는 worker_threads 8개가 **각자 SQLite 연결**로 같은 파일에 동시에 intake.accept 를 부른다 (웹 요청이 몰리는 상황에 더 가깝다).
// 기대: 같은 글이 한 번만 들어가고(dup_count 7), 여덟 호출 모두 같은 접수번호를 받으며, 잠금 오류(SQLITE_BUSY)로 실패하는 호출이 없다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { need, all } from "./_helpers.ts";

// 지금(10-01) 결과: 2건이 들어간다 — intake.accept 의 잠금(withSubmitLock)이 **한 프로세스(한 isolate) 안에서만** 통해서다.
// 웹 접수는 webapi 한 프로세스만 받으므로 운영 버그는 아니다. 여러 프로세스가 접수를 받게 되면 뚫린다.
// 고치려면 찾기→넣기를 DB 트랜잭션(db.transaction: SQLite BEGIN IMMEDIATE)으로 묶는다. [서버]에 제안함. 고쳐지면 todo 를 뗀다.
test("추가_도배방지_동시접수_worker_threads_8개", { todo: "프로세스 간 잠금 없음 — [서버] db.transaction 으로 묶으면 통과 예정" }, async (t) => {
  const m = await need(t, "core/db.ts", "core/intake.ts"); if (!m) return;
  const [db] = m;
  const dbPath = join(mkdtempSync(join(tmpdir(), "fa-race-")), "race.db");
  const prev = (await import("../core/config.ts")).config.DB_PATH;
  db.use_path(dbPath);
  await db.init_db();
  await db.close_all?.();
  const N = 8;
  const sab = new SharedArrayBuffer(8);
  const flag = new Int32Array(sab);
  const text = "유등터널 입구가 너무 붐벼서 밀려요 진짜 동시에";
  const workers = Array.from({ length: N }, () => new Worker(new URL("./_race_worker.ts", import.meta.url), { workerData: { dbPath, sab, text } }));
  const results = workers.map((w) => new Promise<any>((res, rej) => { w.once("message", res); w.once("error", rej); }));
  try {
    const t0 = Date.now();
    while (Atomics.load(flag, 0) < N) {                        // 모두 준비될 때까지 (최대 30초)
      if (Date.now() - t0 > 30_000) throw new Error("일꾼 준비 시간 초과");
      await new Promise((r) => setTimeout(r, 10));
    }
    Atomics.store(flag, 1, 1);
    Atomics.notify(flag, 1);                                   // 동시에 출발
    const out = await Promise.all(results);
    const errors = out.filter((o) => o.error).map((o) => o.error);
    assert.deepEqual(errors, [], `잠금 등으로 실패한 호출: ${errors.join(" / ")}`);
    db.use_path(dbPath);
    const rows = await all(db, "SELECT id, dup_count FROM feedback_inbox");
    assert.equal(rows.length, 1, `같은 글이 ${rows.length}건 들어감 (합치기 경합)`);
    assert.equal(rows[0].dup_count, N - 1);
    assert.deepEqual(new Set(out.map((o) => o.id)), new Set([rows[0].id]));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
    await db.close_all?.();
    db.use_path(prev);
  }
});
