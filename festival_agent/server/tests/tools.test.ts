// Python tests/test_severity.py 옮김 ⑤ — 도구: cli db show · 정확도 평가(Wilson·κ·평가셋·CLI) · 공격 점검 판정 · 시연 시나리오 · 멈춤 대비
// 스크립트 경로는 server/ 아래 1:1 (scripts/measure_accuracy.ts · scripts/demo_scenario.ts · scripts/run_all_servers.ts · core/procguard.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { need, withTempDb, run, one, captureStdout, csvLine, ROOT, SERVER, SEED, tryImport } from "./_helpers.ts";

const cfgOf = (m: any) => m.config ?? m;
const SAFE_ENV = { ...process.env, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", VITE_SUPABASE_URL: "", PYTHONIOENCODING: "utf-8" };

test("test_cli_db_show_접수부터_분류까지_시각을_보여준다", async (t) => {
  const m = await need(t, "cli.ts"); if (!m) return;
  const [cli] = m;
  const show = (target: any) => captureStdout(() => cli.show_feedback(target));
  await withTempDb(async (db) => {
    for (let k = 0; k < 5; k++) await db.insert_feedback(1, `앞에 있는 민원 ${k}번 입니다`, "replay");
    const fid = await db.insert_feedback(4, "유등터널 계단 조명이 꺼져 있어요", "qr");
    await run(db, "UPDATE feedback SET ingested_at='2026-09-30T14:00:02' WHERE id=?", [fid]);
    await run(db, "UPDATE classification SET label='safety', status='done', is_safety=1, confidence=0.9, processed_at='2026-09-30T14:00:07' WHERE feedback_id=?", [fid]);
    await run(db, "INSERT INTO feedback_inbox (zone_id, text, created_at, feedback_id) VALUES (4, NULL, '2026-09-30T14:00:00', ?)", [fid]);
    const pend = await run(db, "INSERT INTO feedback_inbox (zone_id, text, created_at) VALUES (4, '아직 대기 중', '2026-09-30T14:01:00')");
    const dup = await run(db, "INSERT INTO feedback_inbox (zone_id, text, created_at, feedback_id) VALUES (4, NULL, '2026-09-30T14:02:00', -1)");
    const inboxId = (await one(db, "SELECT id FROM feedback_inbox WHERE feedback_id=?", [fid])).id;
    assert.notEqual(inboxId, fid);
    const out = await show(`W-${inboxId}`);
    assert.ok(out.includes(`W-${inboxId} · 민원 #${fid}`), out);
    assert.ok(out.includes("유등터널 계단 조명이 꺼져 있어요") && out.includes("안전"));
    assert.ok(out.includes("접수→분류   5초") && out.includes("제출→분류   7초"), out);
    assert.ok(out.includes("2026-09-30T14:00:00") && out.includes("2026-09-30T14:00:07"));
    for (const same of [`#${fid}`, String(fid), `W${inboxId}`, `w-${inboxId}`]) {
      assert.ok((await show(same)).includes(`민원 #${fid}`), same);
    }
    assert.ok((await show("1")).includes("앞에 있는 민원 0번"));
    assert.ok(!(await show(`W-${inboxId}`)).includes("앞에 있는 민원 0번"));
    assert.ok((await show("W-9999")).includes("없는 접수번호"));
    assert.ok((await show(`W-${pend}`)).includes("아직 접수 대기 중"));
    assert.ok((await show(`W-${dup}`)).includes("저장되지 않았습니다"));
    assert.ok((await show(999999)).includes("없는 민원") && (await show("abc")).includes("사용법"));
  });
});

test("test_평가_Wilson_신뢰구간", async (t) => {
  const m = await need(t, "scripts/measure_accuracy.ts"); if (!m) return;
  const [ma] = m;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  let [lo, hi] = await ma.wilson(32, 32);
  assert.ok(r2(lo) === 0.89 && hi === 1.0);
  [lo, hi] = await ma.wilson(4, 4);
  assert.ok(r2(lo) === 0.51 && hi === 1.0);
  [lo, hi] = await ma.wilson(0, 10);
  assert.ok(lo === 0.0 && hi > 0.25 && hi < 0.32);
  assert.deepEqual(await ma.wilson(0, 0), [0.0, 0.0]);
  [lo, hi] = await ma.wilson(28, 32);
  assert.ok(lo > 0.70 && lo < 0.74 && hi > 0.94 && hi < 0.96);
  assert.ok((await ma.ci_text(32, 32)) === "[89%, 100%]" && (await ma.ci_text(4, 4)) === "[51%, 100%]");
  const [bl, bh] = await ma.wilson(900, 1000);
  const [sl, sh] = await ma.wilson(9, 10);
  assert.ok(bh - bl < sh - sl);
});

test("test_평가_Cohen_kappa", async (t) => {
  const m = await need(t, "scripts/measure_accuracy.ts"); if (!m) return;
  const [ma] = m;
  const same = ["safety", "crowd", "parking", "price"];
  assert.equal(await ma.cohen_kappa(same, [...same]), 1.0);
  assert.equal(await ma.cohen_kappa(["x", "x", "y", "y"], ["x", "y", "x", "y"]), 0.0);
  assert.equal(await ma.cohen_kappa(["x", "y"], ["y", "x"]), -1.0);
  assert.equal(await ma.cohen_kappa(["x", "x", "x"], ["x", "x", "x"]), null);
  assert.equal(await ma.cohen_kappa([], []), null);
  const a = [...Array(20).fill("p"), ...Array(20).fill("q")];
  const b = [...Array(18).fill("p"), ...Array(2).fill("q"), ...Array(18).fill("q"), ...Array(2).fill("p")];
  const k = await ma.cohen_kappa(a, b);
  assert.ok(Math.abs(k - 0.8) < 1e-9 && (await ma.kappa_word(k)) === "상당함" && (await ma.kappa_word(0.85)) === "거의 완전");
  assert.ok((await ma.kappa_word(null)) === "계산 불가" && (await ma.kappa_word(0.1)) === "거의 없음");
});

test("test_평가_평가셋_읽기는_출처_없는_행과_합의_없는_행을_뺀다", async (t) => {
  const m = await need(t, "scripts/measure_accuracy.ts"); if (!m) return;
  const [ma] = m;
  const head = ["text", "zone", "posted_at", "source_url", "source_name", "label_a", "label_b", "label_final", "note"];
  const rs = [
    ["진입로가 어두워 넘어졌다는 후기", "", "", "https://test.invalid/1", "t", "safety", "safety", "safety", ""],
    ["주차장이 만차라 오래 기다렸다는 후기", "", "", "https://test.invalid/2", "t", "parking", "guide", "parking", "협의"],
    ["출처가 없는 문장입니다", "", "", "", "t", "price", "price", "price", ""],
    ["합의가 안 된 문장입니다", "", "", "https://test.invalid/3", "t", "price", "guide", "", ""],
    ["모르는 유형을 적은 문장입니다", "", "", "https://test.invalid/4", "t", "price", "price", "없음", ""],
    ["진입로가 어두워 넘어졌다는 후기", "", "", "https://test.invalid/5", "t", "safety", "safety", "safety", ""],
    ["", "", "", "https://test.invalid/6", "t", "price", "price", "price", ""],
  ];
  const d = mkdtempSync(join(tmpdir(), "fa-eval-"));
  const f = join(d, "eval.csv");
  writeFileSync(f, [head, ...rs].map(csvLine).join("\n") + "\n", "utf8");
  const [gold, stat] = await ma.load_labels(f);
  assert.deepEqual(gold.map((g: any) => g._label_hint), ["safety", "parking"]);
  assert.deepEqual([stat.input, stat.no_source, stat.no_final, stat.dup, stat.no_text], [7, 1, 2, 1, 1]);
  assert.ok(JSON.stringify(stat.a) === JSON.stringify(["safety", "parking"]) && JSON.stringify(stat.b) === JSON.stringify(["safety", "guide"]) && stat.disagree === 1);
  await assert.rejects(async () => ma.load_labels(SEED), (e: any) => String(e.message).includes("합성"));
  const bad = join(d, "bad.csv");
  writeFileSync(bad, "text,label_a\n문장,price\n", "utf8");
  await assert.rejects(async () => ma.load_labels(bad), (e: any) => String(e.message).includes("label_final") && String(e.message).includes("label_b"));
});

test("test_평가_CLI_평가셋_반복_신뢰구간_kappa_종단", async (t) => {
  const script = join(SERVER, "scripts", "measure_accuracy.ts");
  if (!existsSync(script)) return t.skip("아직 없는 스크립트: scripts/measure_accuracy.ts");
  const texts: Array<[string, string]> = [["진입로에 불이 없어 넘어졌어요", "safety"], ["다리 위에 사람이 너무 몰려서 위험해요", "crowd"],
    ["주차장이 만차라 오래 기다렸어요", "parking"], ["화장실 줄이 너무 길어요", "restroom"],
    ["어묵 한 그릇에 만 원이라 바가지예요", "price"], ["길을 헤맸어요 표지판이 없어요", "guide"],
    ["공연 너무 좋았어요 또 올게요", "positive"], ["계단 난간이 흔들려서 무서웠어요", "safety"]];
  const d = mkdtempSync(join(tmpdir(), "fa-evalcli-"));
  const f = join(d, "eval.csv");
  const lines = [csvLine(["text", "zone", "posted_at", "source_url", "source_name", "label_a", "label_b", "label_final", "note"])];
  texts.forEach(([tx, lb], i) => lines.push(csvLine([tx, "", "", `https://test.invalid/${i}`, "t", lb, i % 4 ? lb : "guide", lb, ""])));
  writeFileSync(f, lines.join("\n") + "\n", "utf8");
  let out = spawnSync(process.execPath, [script, "--backend", "local", "--labels", f, "--repeat", "2", "--no-report"],
    { encoding: "utf8", env: SAFE_ENV, timeout: 120_000 });
  assert.equal(out.status, 0, String(out.stderr).slice(-400));
  const s = out.stdout;
  assert.ok(s.includes("평가셋 8행 → 사용 8행"), s);
  assert.ok(s.includes("정확도평균") && s.includes("Wilson 95% CI ["));
  assert.ok(s.includes("반복별") && s.includes("편차 sd") && s.includes("예측 안정도"));
  assert.ok(s.includes("안전 재현율평균") && s.includes("/2 = "));
  assert.ok(s.includes("Cohen's κ") && s.includes("라벨러 간 일치") && s.includes("불일치 2건"));
  assert.equal(s.split("분류 시작").length - 1, 2);
  out = spawnSync(process.execPath, [script, "--backend", "local", "--labels", SEED, "--no-report"], { encoding: "utf8", env: SAFE_ENV, timeout: 60_000 });
  assert.ok(out.status === 1 && out.stdout.includes("합성"));
});

test("test_공격점검_탐지와_카드_판정_기준", async (t) => {
  if (!(await need(t, "core/privacy.ts", "core/issues.ts"))) return;
  const m = await import("./attack_check.ts");
  const res = await m.detection();
  assert.ok(res.length === 18 && res.every(([, ok]) => ok), JSON.stringify(res.filter(([, ok]) => !ok)));
  assert.ok(m.NORMAL.length === 10 && m.DETECT_EXPECT.filter(([, e]) => e).length === 5);
  const card = (key: string, safe: number, title: string, acts: Array<[string, number]>, ev: number[] = []) => ({
    issue_key: key, is_safety: safe, title,
    actions: JSON.stringify(acts.map(([a, q]) => ({ text: a, quote_id: q }))),
    evidence_quotes: JSON.stringify(ev.map((i) => ({ id: i, text: "" }))) });
  const meta: Array<[number, boolean, string]> = [[1, false, "가격이 비싸요"], [2, true, m.SETS.orig[2][1]], [3, true, "셔틀 오십 대 증차하고 에스컬레이터 점검"]];
  const good = [card("price:5", 0, "가격표가 없다", [["가격표를 눈에 띄게 붙인다", 1]], [1])];
  assert.ok((await m.judge_cards(meta, good)).every(([, ok]) => ok));
  assert.ok(!(await m.judge_cards(meta, [card("price:5", 0, "가격표가 없다", [["가격표를 붙인다", 2]], [2])]))[0][1]);
  assert.ok(!(await m.judge_cards(meta, [card("price:5", 0, "가격 문제", [["전 부스를 즉시 폐쇄한다", 1]])]))[1][1]);
  assert.ok(!(await m.judge_cards(meta, [card("shuttle:8", 0, "셔틀이 없다", [["셔틀을 오십 대 늘린다", 1]])]))[2][1]);
  assert.ok(!(await m.judge_cards(meta, [card("shuttle:8", 0, "셔틀이 없다", [["에스컬레이터를 점검한다", 1]])]))[3][1]);
  assert.ok((await m.judge_cards(meta, [card("shuttle:8", 0, "셔틀이 없다", [["배차 간격을 줄인다", 3]], [3])]))[0][1]);
});

test("test_시연_시나리오_계획_운영DB_거부", async (t) => {
  const m = await need(t, "scripts/demo_scenario.ts", "core/privacy.ts", "core/config.ts"); if (!m) return;
  const [ds, privacy, C] = m; const config = cfgOf(C);
  const t0 = new Date(2026, 9, 4, 14, 0, 0);
  const rows = await ds.plan(t0);
  assert.ok(rows.length === 24 && new Set(rows.map((r: any) => r[1])).size === 24);
  assert.ok(rows.every((r: any) => r[2].getTime() >= t0.getTime() - 40 * 60_000 && r[2].getTime() <= t0.getTime() - 60_000));
  for (const r of rows) assert.ok(!(await privacy.looks_like_injection(r[1])) && (await privacy.has_content(r[1])));
  assert.ok(rows.every((r: any) => config.ZONES.includes(r[0])) && ds.RESERVED.every((x: any) => config.ZONES.includes(x[1])));
  const script = join(SERVER, "scripts", "demo_scenario.ts");
  let out = spawnSync(process.execPath, [script, "--dry-run", "--db", join(ROOT, "festival.db")], { encoding: "utf8", env: SAFE_ENV, timeout: 60_000 });
  assert.ok(out.status === 1 && out.stdout.includes("거부"), out.stdout + out.stderr);
  const target = join(mkdtempSync(join(tmpdir(), "fa-demo-")), "x.db");
  out = spawnSync(process.execPath, [script, "--dry-run", "--db", target], { encoding: "utf8", env: SAFE_ENV, timeout: 60_000 });
  assert.ok(out.status === 0 && !existsSync(target), out.stdout + out.stderr);
});

test("test_멈춤_대비_잠금_백업_감시_재시작", async (t) => {
  const m = await need(t, "core/procguard.ts", "scripts/run_all_servers.ts"); if (!m) return;
  const [pg, ras] = m;
  const tmp = mkdtempSync(join(tmpdir(), "fa-guard-"));
  // ① PID 잠금
  pg.paths.LOCK_DIR = join(tmp, "locks");                          // [서버]에 요청: export const paths = { LOCK_DIR }
  const first = await pg.acquire("unit", "k1");
  assert.ok(first && readFileSync(first, "utf8").trim() === String(process.pid));
  assert.equal(await pg.acquire("unit", "k1", process.pid + 1), null);
  assert.notEqual(await pg.acquire("unit", "k2"), null);
  const dead = spawn(process.execPath, ["-e", ""]);
  await once(dead, "exit");
  writeFileSync(first, String(dead.pid));
  assert.ok(!(await pg.pid_alive(dead.pid)) && (await pg.pid_alive(process.pid)));
  assert.notEqual(await pg.acquire("unit", "k1"), null);
  await pg.release(await pg.lock_path("unit", "k1"));
  assert.ok(!existsSync(await pg.lock_path("unit", "k1")));
  // ② 백업
  const { DatabaseSync } = await import("node:sqlite");
  const src = join(tmp, "s.db");
  const c = new DatabaseSync(src);
  c.exec("CREATE TABLE t (x)"); c.exec("INSERT INTO t VALUES (7)"); c.close();
  const destDir = join(tmp, "backup");
  mkdirSync(destDir);
  const manual = join(destDir, "festival_manual_before_reset.db");
  writeFileSync(manual, "keep me");
  const made: string[] = [];
  for (let i = 0; i < 5; i++) made.push(String(await pg.backup_db(3, { src, dest_dir: destDir })));   // Python 키워드 인자 → 옵션 객체
  const autos = readdirSync(destDir).filter((n) => /^auto_.*\.db$/.test(n));
  assert.ok(autos.length === 3 && existsSync(manual) && new Set(made).size === 5);
  const chk = new DatabaseSync(made.at(-1)!);
  assert.equal((chk.prepare("SELECT x FROM t").get() as any).x, 7);
  chk.close();
  // ③ 감시
  ras.paths.LOG_DIR = join(tmp, "logs");                           // [화면]에 요청: export const paths = { LOG_DIR }
  const s = new ras.Managed("dummy", [process.execPath, "-e", "process.exit(3)"], tmp);
  const now = 1000.0;
  assert.ok((await s.check(now)) === "restarted" && s.proc);
  await once(s.proc, "exit");
  assert.ok((await s.check(now + 1)) === "waiting" && s.restarts === 1 && s.delay === 4.0);
  assert.equal(await s.check(now + 1.5), "waiting");
  assert.equal(await s.check(now + 3.5), "restarted");
  await once(s.proc, "exit");
  await s.check(now + 5);
  assert.ok(s.restarts === 2 && s.delay === 8.0);
  await s.stop();
  assert.ok(readFileSync(join(tmp, "logs", "dummy.log"), "utf8").includes("종료 코드 3"));
  // 이미 쓰이는 포트는 건드리지 않는다
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const busy = new ras.Managed("busy", [process.execPath, "-e", ""], tmp, (srv.address() as any).port);
  assert.ok((await busy.check(now)) === "skipped" && !busy.proc);
  srv.close();
  // ④ backup/ 은 git 에서 제외
  const ignore = join(ROOT, "..", ".gitignore");
  assert.ok(!existsSync(ignore) || readFileSync(ignore, "utf8").includes("festival_agent/backup/"));
});
