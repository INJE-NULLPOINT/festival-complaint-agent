// D5-74 조치요청서 DOCX 저장 폴더 — 테스트·측정이 운영 output/ 에 시험 DOCX 를 쌓지 않는다.
// 사고: dispatcher 의 OUT_DIR 가 DOCS_DIR 을 무시하고 운영 output/ 에 써서 '교통과 주차' DOCX 가 30개쯤 쌓였다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { need, withTempDb, withEnv, withConfig, ROOT, SERVER } from "./_helpers.ts";

const OUTPUT = path.join(ROOT, "output");
/** 운영 output/ 의 파일 (서버가 쓰는 logs·locks 폴더는 뺀다). */
function outputFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) { if (d === OUTPUT && (e === "logs" || e === "locks")) continue; walk(p); } else out.push(p);
    }
  };
  walk(OUTPUT);
  return out.sort();
}

test("test_docs_dir_규칙_DOCS_DIR_우선_임시_DB_는_임시_폴더_운영처럼_도는_곳만_output", async (t) => {
  const m = await need(t, "core/config.ts"); if (!m) return;
  const [cfg] = m; const config = cfg.config, docs_dir = cfg.docs_dir;
  const keep = { d: process.env.DOCS_DIR, c: process.env.NODE_TEST_CONTEXT };
  try {
    delete process.env.DOCS_DIR;
    // 1) 테스트 안(NODE_TEST_CONTEXT)에서는 기본 festival.db 여도 운영 output/ 을 쓰지 않는다
    process.env.NODE_TEST_CONTEXT ??= "child-v8";
    await withConfig({ DB_PATH: path.join(ROOT, "festival.db"), SUPABASE_DB_URL: "" }, async () => {
      assert.ok(!docs_dir().startsWith(OUTPUT), docs_dir());
    });
    // 2) 임시 SQLite → 시스템 임시 폴더 (DB 경로마다 다른 폴더)
    const a = await withConfig({ DB_PATH: path.join(tmpdir(), "a", "t.db") }, async () => docs_dir());
    const b = await withConfig({ DB_PATH: path.join(tmpdir(), "b", "t.db") }, async () => docs_dir());
    assert.ok(a.startsWith(tmpdir()) && b.startsWith(tmpdir()) && a !== b);
    // 3) 테스트 밖에서(운영처럼) 기본 festival.db · Supabase 면 output/
    delete process.env.NODE_TEST_CONTEXT;
    await withConfig({ DB_PATH: path.join(ROOT, "festival.db"), SUPABASE_DB_URL: "" }, async () => assert.equal(docs_dir(), OUTPUT));
    await withConfig({ DB_PATH: path.join(tmpdir(), "x.db"), SUPABASE_DB_URL: "postgres://u:p@127.0.0.1:1/db" }, async () => assert.equal(docs_dir(), OUTPUT));
    //    …그래도 임시 SQLite 는 임시 폴더
    await withConfig({ DB_PATH: path.join(tmpdir(), "x.db"), SUPABASE_DB_URL: "" }, async () => assert.ok(docs_dir().startsWith(tmpdir())));
    // 4) DOCS_DIR 이 있으면 무조건 그 폴더
    process.env.DOCS_DIR = path.join(tmpdir(), "my-docs");
    await withConfig({ DB_PATH: path.join(ROOT, "festival.db") }, async () => assert.equal(docs_dir(), path.resolve(tmpdir(), "my-docs")));
  } finally {
    for (const [k, v] of [["DOCS_DIR", keep.d], ["NODE_TEST_CONTEXT", keep.c]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    void config;
  }
});

test("test_dispatcher_는_OUT_DIR_을_덮어쓰지_않아도_운영_output_에_쓰지_않고_webapi_가_같은_폴더를_내준다", async (t) => {
  const m = await need(t, "agents/dispatcher.ts", "core/config.ts", "webapi.ts"); if (!m) return;
  const [dispatcher, cfg, webapi] = m;
  const before = outputFiles();
  await withEnv("LLM_BACKEND", "local", async () => withTempDb(async (db) => {
    await (await db.connect()).execute("DELETE FROM action_request");
    const q = [{ raw_text: "주차장이 만차예요", zone: "진주교 남단 주차장", ingested_at: "2026-10-01T10:00:00" }];
    const r = await dispatcher.generate_doc.fn("parking", "교통과", 1, "mid", q, ["진입로 안내"]);
    const dir = cfg.docs_dir();
    assert.equal(path.dirname(r.path), dir);                                   // OUT_DIR 기본 = docs_dir()
    assert.ok(!r.path.startsWith(OUTPUT) && r.path.startsWith(tmpdir()), r.path);
    assert.ok(existsSync(r.path));
    const act = (await webapi.get_action()) as any;                             // webapi 도 같은 폴더에서 찾는다 (다운로드 링크가 붙는다)
    assert.ok(JSON.stringify(act).includes("/api/docs/"), "webapi 가 같은 폴더의 DOCX 를 못 찾는다");
    // DOCS_DIR 을 주면 OUT_DIR 도 그 폴더 (예전엔 무시했다)
    const custom = mkdtempSync(path.join(tmpdir(), "docs-env-"));
    await withEnv("DOCS_DIR", custom, async () => {
      const r2 = await dispatcher.generate_doc.fn("parking", "교통과", 1, "mid", q, ["진입로 안내"]);
      assert.equal(path.dirname(r2.path), path.resolve(custom));
    });
  }));
  assert.deepEqual(outputFiles(), before, "운영 output/ 에 파일이 생겼다");
});

/** 스크립트를 임시 환경으로 돌리고 실행 전후 output/ 파일이 같은지 본다. */
function runScript(args: string[], timeout_ms: number): { code: number | null; out: string } {
  const env = { ...process.env, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", LLM_BACKEND: "local", PYTHONIOENCODING: "utf-8" } as NodeJS.ProcessEnv;
  delete env.DOCS_DIR; delete env.DB_PATH; delete env.NODE_TEST_CONTEXT;       // 테스트 환경 보호(NODE_TEST_CONTEXT)에 기대지 않고, 임시 DB 규칙만으로 안전한지 본다
  const r = spawnSync(process.execPath, args, { cwd: SERVER, env, encoding: "utf8", timeout: timeout_ms });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("test_testcase_report_measure_accuracy_wall_clock_실행_전후_output_파일_수가_같다", async (t) => {
  const before = outputFiles();
  // D5-78: 구조 모드는 제출용 tests/testcase_report.md(--live 기록)를 건드리지 않고 tests/testcase_structure.md 에만 쓴다.
  const report = path.join(ROOT, "tests", "testcase_report.md");
  const structure = path.join(ROOT, "tests", "testcase_structure.md");
  const saved = existsSync(report) ? readFileSync(report) : null;
  const saved_structure = existsSync(structure) ? readFileSync(structure) : null;
  try {
    const tc = runScript(["scripts/testcase_report.ts"], 120_000);
    assert.equal(tc.code, 0, tc.out.slice(-400));
    assert.deepEqual(outputFiles(), before, "testcase_report 가 운영 output/ 에 썼다");
    const after = existsSync(report) ? readFileSync(report) : null;
    assert.ok((saved === null && after === null) || (saved !== null && after !== null && saved.equals(after)),
      "구조 모드가 제출용 testcase_report.md 를 덮어썼다");
    assert.ok(existsSync(structure) && readFileSync(structure, "utf8").includes("구조 검증"), "구조 검증 결과가 testcase_structure.md 에 없다");
    assert.ok(tc.out.includes("testcase_structure.md"), tc.out.slice(-200));

    const ma = runScript(["scripts/measure_accuracy.ts", "--no-report", "--limit", "30"], 120_000);
    assert.equal(ma.code, 0, ma.out.slice(-400));
    assert.deepEqual(outputFiles(), before, "measure_accuracy 가 운영 output/ 에 썼다");

    const wc = runScript(["scripts/wall_clock.ts", "--backend", "local", "--n", "1", "--batch", "0", "--timeout", "20"], 120_000);
    assert.equal(wc.code, 0, wc.out.slice(-400));
    assert.deepEqual(outputFiles(), before, "wall_clock 이 운영 output/ 에 썼다");

    const mc = runScript(["scripts/measure_cost.ts"], 60_000);                          // 기록이 없으면 문서를 만들지 않는다 — 그래도 output/ 은 그대로
    assert.ok(mc.code === 0 || mc.code === 1, mc.out.slice(-300));
    assert.deepEqual(outputFiles(), before, "measure_cost 가 운영 output/ 에 썼다");
  } finally {
    if (saved !== null) writeFileSync(report, saved);                                   // (고친 뒤에는 바뀌지 않지만, 깨졌을 때도 제출용 기록을 지키려고)
    if (saved_structure !== null) writeFileSync(structure, saved_structure);
    else rmSync(structure, { force: true });                                            // 이 테스트가 만든 구조 결과 파일은 지운다
  }
});

test("test_final_check_와_run_all_은_시험용_DOCX_폴더를_따로_준다", async (t) => {
  // 두 스크립트는 무겁게 돌아가서(타입 검사·브라우저) 여기서 실행하지 않는다 — 자식 프로세스에 DOCS_DIR(임시 폴더)을 주는지 본다.
  const fc = readFileSync(path.join(SERVER, "scripts", "final_check.ts"), "utf8");
  assert.ok(/env\.DOCS_DIR\s*=\s*DOCS_TMP/.test(fc) && fc.includes("festival_final_docs_"));
  const ra = readFileSync(path.join(ROOT, "tests", "ui", "run_all.ts"), "utf8");
  assert.ok(/DOCS_DIR:\s*join\(/.test(ra), "run_all 의 webapi 환경에 DOCS_DIR 이 없다");
  const mm = readFileSync(path.join(ROOT, "tests", "ui", "make_mobile_db.ts"), "utf8");
  assert.ok(mm.includes("dispatcher.paths.OUT_DIR = DOCS"));
});
