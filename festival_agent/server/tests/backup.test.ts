// 운영 DB 백업·복원 (core/dbbackup.ts · cli db restore) — 전부 임시 SQLite 로만 돈다. Supabase 읽기(snapshot_supabase)는 여기서 부르지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { need, withTempDb, run, one, all, captureStdout } from "./_helpers.ts";

/** snapshot_supabase() 와 같은 모양으로 임시 SQLite 를 떠 낸다. */
async function dump(db: any, dbbackup: any): Promise<any> {
  const tables: Record<string, any> = {};
  for (const t of dbbackup.BACKUP_TABLES) {
    let rows: any[];
    try { rows = await all(db, `SELECT * FROM "${t}" ORDER BY 1`); } catch { continue; }
    const columns = rows.length ? Object.keys(rows[0]) : (await all(db, `PRAGMA table_info("${t}")`)).map((r) => r.name);
    tables[t] = { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
  }
  return { format: dbbackup.FORMAT, version: dbbackup.VERSION, source: "test", created_at: "2026-10-01T00:00:00", tables };
}

test("test_백업_대상에_출처_해시_키_표는_없다", async (t) => {
  const m = await need(t, "core/dbbackup.ts"); if (!m) return;
  const [b] = m;
  for (const x of b.EXCLUDED_TABLES) assert.ok(!b.BACKUP_TABLES.includes(x), x);
  assert.ok(b.EXCLUDED_TABLES.includes("source_key"));
  for (const x of ["feedback", "classification", "severity", "alert", "action_request", "briefing", "issue", "zone", "festival", "department_map"]) {
    assert.ok(b.BACKUP_TABLES.includes(x), x);
  }
});

test("test_복원은_백업_내용으로_바꾸고_id_순번도_이어진다", async (t) => {
  const m = await need(t, "core/dbbackup.ts", "core/db.ts"); if (!m) return;
  const [b, db] = m;
  let bf: any;
  await withTempDb(async (d) => {
    const a = await d.insert_feedback(4, "유등터널 계단 조명이 꺼져 있어요", "qr");
    await d.insert_feedback(1, "주차장이 만차예요", "qr");
    await run(d, "UPDATE classification SET label='safety', status='done', is_safety=1, confidence=0.9, sentiment=-0.8 WHERE feedback_id=?", [a]);
    await run(d, "INSERT INTO alert (label, kind, detail, created_at) VALUES ('safety','spike','급증','2026-10-01T00:00:00')");
    bf = await dump(d, b);
  });
  assert.equal(bf.tables.feedback.rows.length, 2);

  await withTempDb(async (d) => {
    await d.insert_feedback(2, "이 민원은 복원하면 사라진다", "qr");          // 복원 전에만 있던 행
    const done = await b.restore(bf);
    assert.equal(done.feedback, 2);
    const fb = await all(d, "SELECT id, raw_text FROM feedback ORDER BY id");
    assert.deepEqual(fb.map((r) => r.raw_text), ["유등터널 계단 조명이 꺼져 있어요", "주차장이 만차예요"]);
    assert.equal((await one(d, "SELECT label, status FROM classification WHERE feedback_id=?", [fb[0].id])).label, "safety");
    assert.equal((await one(d, "SELECT COUNT(*) c FROM alert")).c, 1);
    assert.equal((await one(d, "SELECT COUNT(*) c FROM zone")).c, 8);
    const nid = await d.insert_feedback(3, "복원 뒤에 새로 들어온 민원", "qr");     // 기존 id 와 겹치지 않는다
    assert.ok(nid > fb[1].id);
  });
});

test("test_복원은_중간에_실패하면_원래대로_돌아간다", async (t) => {
  const m = await need(t, "core/dbbackup.ts"); if (!m) return;
  const [b] = m;
  await withTempDb(async (d) => {
    await d.insert_feedback(4, "원래 있던 민원입니다", "qr");
    const bf = await dump(d, b);
    bf.tables.feedback.rows.push(bf.tables.feedback.rows[0].slice());            // 같은 id 두 번 → 고유키 위반
    await assert.rejects(() => b.restore(bf));
    assert.equal((await one(d, "SELECT COUNT(*) c FROM feedback")).c, 1);        // 지워지지 않았다
  });
});

test("test_백업_파일_검사와_최근_N개만_남기기", async (t) => {
  const m = await need(t, "core/dbbackup.ts"); if (!m) return;
  const [b] = m;
  const dir = mkdtempSync(join(tmpdir(), "fa-bk-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ format: "other", version: 1, tables: {} }));
  assert.throws(() => b.read_backup(bad), /백업 파일이 아닙니다/);
  writeFileSync(bad, JSON.stringify({ format: b.FORMAT, version: b.VERSION, tables: { source_key: { columns: ["id"], rows: [[1]] } } }));
  assert.throws(() => b.read_backup(bad), /백업 대상이 아닌 테이블/);

  const empty = { format: b.FORMAT, version: b.VERSION, source: "test", created_at: "x", tables: {} };
  const made: string[] = [];
  for (let i = 0; i < 15; i++) made.push(b.write_backup(empty, b.PREFIX, dir));
  writeFileSync(join(dir, "auto_keep.db"), "x");
  writeFileSync(join(dir, `${b.BEFORE_RESTORE_PREFIX}keep.json`), "{}");
  b.prune(12, dir);
  const left = readdirSync(dir).filter((f) => f.startsWith(b.PREFIX));
  assert.equal(left.length, 12);
  assert.ok(existsSync(made[14]) && !existsSync(made[0]));                      // 오래된 것부터 지운다
  assert.ok(existsSync(join(dir, "auto_keep.db")) && existsSync(join(dir, `${b.BEFORE_RESTORE_PREFIX}keep.json`)));
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("test_cli_db_restore_확인_문구가_틀리면_아무것도_바꾸지_않는다", async (t) => {
  const m = await need(t, "core/dbbackup.ts", "cli.ts"); if (!m) return;
  const [b, cli] = m;
  await withTempDb(async (d) => {
    await d.insert_feedback(4, "파일에 들어갈 민원입니다", "qr");
    const file = b.write_backup(await dump(d, b), "t_", mkdtempSync(join(tmpdir(), "fa-bk-")));
    await run(d, "DELETE FROM classification"); await run(d, "DELETE FROM feedback");
    // --yes 가 없으면 확인 문구를 묻는다. 답이 틀리면 취소.
    const out = await captureStdout(() => cli.cmd_db_restore({ target: file, yes: false, "live-db": false, _ask: async () => "아니오" }));
    assert.ok(out.includes("복원 미리보기") && out.includes("취소했습니다"), out);
    assert.equal((await one(d, "SELECT COUNT(*) c FROM feedback")).c, 0);
    const out2 = await captureStdout(() => cli.cmd_db_restore({ target: file, yes: true, "live-db": false }));
    assert.ok(out2.includes("복원했습니다"), out2);
    assert.equal((await one(d, "SELECT COUNT(*) c FROM feedback")).c, 1);
  });
});
