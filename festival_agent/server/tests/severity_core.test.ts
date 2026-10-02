// Python tests/test_severity.py 옮김 ① — 심각도·경계 규칙·접수 검증·review·구역 미상 (원본 15~290행)
// 테스트 이름은 Python 함수 이름 그대로 둔다 (두 결과를 줄 단위로 맞춰 보려고).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  need, withTempDb, rows, seed, run, all, one, iso, ago, pyround, parseCsv, csvLine, SEED, rejects, sha256hex,
} from "./_helpers.ts";

const cfgOf = (m: any) => m.config ?? m;

test("test_재현성", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const a = await S.compute_severity(9, -0.8, 100, { is_safety: true });
  const b = await S.compute_severity(9, -0.8, 100, { is_safety: true });
  assert.deepEqual(a, b);
});

test("test_안전가중_역전", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const parking = await S.compute_severity(52, -0.5, 100, { is_safety: false });
  const light = await S.compute_severity(9, -0.8, 100, { is_safety: true });
  assert.ok(light.score > parking.score, `${light.score} ${parking.score}`);
});

test("test_S04_안전임계", async (t) => {
  const m = await need(t, "core/severity.ts", "core/config.ts"); if (!m) return;
  const [S, C] = m; const config = cfgOf(C);
  const r = await S.compute_severity(config.SAFETY_THRESHOLD, -0.2, 1000, { is_safety: true });
  assert.equal(r.grade, "immediate");
  const r2 = await S.compute_severity(config.SAFETY_THRESHOLD - 1, -0.2, 1000, { is_safety: true });
  assert.notEqual(r2.grade, "immediate");
});

test("test_S03_급증가중", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const base = await S.compute_severity(10, -0.5, 100);
  const spiked = await S.compute_severity(10, -0.5, 100, { spiked: true });
  assert.ok(spiked.score > base.score);
});

test("test_S06_미조치가중", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const base = await S.compute_severity(10, -0.5, 100);
  const pend = await S.compute_severity(10, -0.5, 100, { unhandled: true });
  assert.ok(pend.score > base.score);
});

test("test_점수상한", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const r = await S.compute_severity(100, -1.0, 100, { is_safety: true, spiked: true, unhandled: true });
  assert.ok(r.score <= 100.0);
});

test("test_빈데이터", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const r = await S.compute_severity(0, 0.0, 0);
  assert.ok(r.score === 0.0 && r.grade === "low");
});

test("test_계산식_노출", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const r = await S.compute_severity(9, -0.8, 100, { is_safety: true });
  // Python str(float): 76.0 → "76.0". TS 에서 같은 모양이 formula 에 들어가야 한다.
  const pyStr = Number.isInteger(r.score) ? r.score.toFixed(1) : String(r.score);
  assert.ok(r.formula.includes("안전2.0") && r.formula.includes(pyStr), r.formula);
});

test("test_등급경계", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  assert.equal(await S.grade_of(80), "immediate");
  assert.equal(await S.grade_of(79.9), "high");
  assert.equal(await S.grade_of(39.9), "low");
});

test("test_조치상태_최신우선", async (t) => {
  const m = await need(t, "core/db.ts", "core/config.ts"); if (!m) return;
  await withTempDb(async (db) => {
    for (const [st, at] of [["requested", "2026-09-29T22:14:00"], ["in_progress", "2026-09-29T22:17:00"]]) {
      await run(db, "INSERT INTO action_request (label, status, created_at) VALUES ('crowd', ?, ?)", [st, at]);
    }
    assert.equal((await db.latest_action_status())["crowd"], "in_progress");
  });
});

test("test_B01_한가한창_비율", async (t) => {
  const m = await need(t, "core/severity.ts", "core/config.ts"); if (!m) return;
  const [S, C] = m; const config = cfgOf(C);
  const r = await S.compute_severity(1, -1.0, 1);
  assert.equal(r.base_score, 0.1 * config.W_FREQ + 1.0 * config.W_INTENSITY);
  const big = await S.compute_severity(30, -0.5, 150);
  assert.equal(big.base_score, pyround(30 / 150 * config.W_FREQ + 0.5 * config.W_INTENSITY, 2));
});

test("test_문제사례_비안전1건은_즉시가_아니다", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const ref = new Date(2026, 8, 30, 14, 0, 0);
  const out = await S.rank_labels(rows([["guide", 1, -1.0, false]], ref), { unhandled_fn: () => true, ref });
  assert.equal(out.length, 1);
  assert.ok(out[0].grade === "mid" && out[0].score <= 55.2, JSON.stringify(out[0]));
  assert.equal(out[0].spike.spiked, false);
});

test("test_B02_급증은_최소건수가_필요하다", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const ref = new Date(2026, 8, 30, 14, 0, 0);
  const one_ = await S.detect_spike(rows([["guide", 5, -1.0, false]], ref), "guide", { ref });
  assert.ok(one_.spiked === false && one_.recent === 1);
  const two = await S.detect_spike(rows([["guide", 50, -1, false], ["guide", 5, -1, false], ["guide", 4, -1, false]], ref), "guide", { ref });
  assert.equal(two.spiked, false);
  const burst = await S.detect_spike(rows([["guide", 50, -1, false], ...[5, 4, 3, 2, 1].map((mm) => ["guide", mm, -1, false] as [string, number, number, boolean])], ref), "guide", { ref });
  assert.ok(burst.spiked === true && burst.recent === 5);
});

test("test_B03_비안전_5건미만은_상한", async (t) => {
  const m = await need(t, "core/severity.ts", "core/config.ts"); if (!m) return;
  const [S, C] = m; const config = cfgOf(C);
  const r = await S.compute_severity(4, -1.0, 4, { spiked: true, unhandled: true });
  assert.ok(r.score === config.NONSAFETY_CAP && r.grade === "high");
  assert.ok(r.formula.includes("상한") && r.formula.includes(`= ${config.NONSAFETY_CAP}`), r.formula);
  const r5 = await S.compute_severity(config.NONSAFETY_IMMEDIATE_MIN, -1.0, 5, { spiked: true, unhandled: true });
  assert.ok(r5.score === 100.0 && r5.grade === "immediate");
});

test("test_B04_안전은_1건도_하한", async (t) => {
  const m = await need(t, "core/severity.ts", "core/config.ts"); if (!m) return;
  const [S, C] = m; const config = cfgOf(C);
  const hi = await S.compute_severity(1, -0.8, 1, { is_safety: true });
  assert.ok(hi.score === 76.0 && hi.grade === "high", JSON.stringify(hi));
  const lo = await S.compute_severity(1, -0.3, 1, { is_safety: true });
  assert.ok(lo.score === config.SAFETY_FLOOR && lo.grade === "high");
  assert.ok(lo.formula.includes("하한"));
  assert.ok(lo.score > (await S.compute_severity(1, -1.0, 1, { unhandled: true })).score);
  assert.equal((await S.compute_severity(0, 0.0, 0, { is_safety: true })).score, 0.0);
});

async function seedWindowRows(rules: any, config: any) {
  const out: any[] = [];
  for (const r of parseCsv(readFileSync(SEED, "utf8"))) {
    const c = await rules.classify(r.text);
    if (c.confidence < config.REVIEW_CONFIDENCE) continue;
    out.push({ label: c.label, sentiment: c.sentiment, is_safety: c.is_safety ? 1 : 0, posted_at: r.posted_at, ingested_at: "" });
  }
  return out;
}

test("test_4일창_역전_유지", async (t) => {
  const m = await need(t, "core/severity.ts", "core/rules.ts", "core/config.ts"); if (!m) return;
  const [S, rules, C] = m; const config = cfgOf(C);
  const rs = await seedWindowRows(rules, config);
  const refStr = rs.map((r) => r.posted_at).sort().at(-1)!;
  const ref = new Date(refStr);
  const cut = iso(ago(ref, 5760));
  const win = rs.filter((r) => r.posted_at >= cut);
  const out = await S.rank_labels(win, { unhandled_fn: () => true, ref });
  const by = Object.fromEntries(out.map((r: any) => [r.label, r]));
  assert.ok(out[0].label === "safety" && out[0].grade === "immediate");
  assert.equal(out[1].label, "crowd");
  assert.equal(by.parking.freq, Math.max(...out.map((r: any) => r.freq)));
  assert.notEqual(by.parking.grade, "immediate");
  assert.ok(!out.some((r: any) => r.spike.spiked));
});

test("test_접수검증_내용없는_입력", async (t) => {
  const m = await need(t, "core/privacy.ts", "core/db.ts", "webapi.ts"); if (!m) return;
  const [privacy, , webapi] = m;
  for (const bad of ["...", "ㅋㅋ", "!!!!", "  ", "", "ㅠㅠㅠ", "1", "가", null]) {
    assert.ok(!(await privacy.has_content(bad)), JSON.stringify(bad));
  }
  for (const good of ["좀 그랬어요", "주차 힘듦", "ok", "12", "화장실!!"]) {
    assert.ok(await privacy.has_content(good), good);
  }
  await withTempDb(async (db) => {
    assert.equal(await db.insert_feedback(1, "...", "test"), null);
    assert.equal(await db.insert_feedback(1, "ㅋㅋ", "test"), null);
    assert.notEqual(await db.insert_feedback(1, "진입로가 너무 어두워요", "test"), null);
  });
  await withTempDb(async () => {
    for (const bad of ["...", "ㅋㅋ", "!!!!"]) {
      await rejects(() => webapi.submit_feedback(1, bad), (e) => {
        assert.ok(e instanceof webapi.ApiError);
        assert.equal(e.message, privacy.NEED_MORE);
      });
    }
    assert.ok((await webapi.submit_feedback(1, "진입로가 너무 어두워요")) > 0);
  });
});

test("test_근거없는_분류는_review", async (t) => {
  const m = await need(t, "agents/classifier.ts", "core/db.ts", "core/config.ts"); if (!m) return;
  const [classifier, , C] = m; const config = cfgOf(C);
  const save = classifier.save_classification;
  await withTempDb(async (db) => {
    const low = await db.insert_feedback(1, "좀 그랬어요", "test");
    const ok = await db.insert_feedback(1, "화장실 줄이 너무 길어요", "test");
    const out = await save.fn(low, "guide", -0.5, false, 0.1, "근거 없음");
    assert.equal(out.status, "review");
    await save.fn(ok, "restroom", -0.55, false, 0.8, "화장실 대기");
    const r = Object.fromEntries((await all(db, "SELECT * FROM classification")).map((x: any) => [x.feedback_id, x]));
    assert.ok(r[low].status === "review" && r[low].label === null);
    assert.ok(r[low].agent_note.includes("확인 필요") && r[low].agent_note.includes("guide"));
    assert.ok(r[ok].status === "done" && r[ok].label === "restroom");
    assert.ok((await db.review_count()) === 1 && (await db.pending_count()) === 0);
    assert.deepEqual(await db.label_counts(), { restroom: 1 });
    assert.deepEqual((await db.ranked()).map((x: any) => x.label), ["restroom"]);
    assert.equal(await db.cache_get(await sha256hex("좀 그랬어요")), null);
    const risky = await db.insert_feedback(1, "뭔가 위험한 느낌이에요", "test");
    assert.equal((await save.fn(risky, "safety", -0.6, true, 0.2, "근거 약함")).status, "review");
    assert.ok((await db.review_count()) === 2 && (await db.review_safety_count()) === 1);
    assert.deepEqual((await db.ranked()).map((x: any) => x.label), ["restroom"]);
    const edge = await db.insert_feedback(1, "표지판이 없어서 헤맸어요", "test");
    assert.ok((await save.fn(edge, "guide", -0.4, false, config.REVIEW_CONFIDENCE, "")).ok);
    assert.equal((await one(db, "SELECT status FROM classification WHERE feedback_id=?", [edge])).status, "done");
  });
});

test("test_구역미상은_NULL로_저장", async (t) => {
  const m = await need(t, "agents/dispatcher.ts", "core/replay.ts", "agents/classifier.ts", "core/config.ts"); if (!m) return;
  const [dispatcher, replay, classifier, C] = m; const config = cfgOf(C);
  await withTempDb(async (db) => {
    const first = (await db.zones())[0];
    const seedFile = join(mkdtempSync(join(tmpdir(), "fa-seed-")), "seed.csv");
    writeFileSync(seedFile, [
      csvLine(["posted_at", "zone", "text"]),
      csvLine(["2026-09-25T18:00:00", first.name, "진입로가 너무 어두워요"]),
      csvLine(["2026-09-25T18:01:00", "", "화장실 줄이 너무 길어요"]),
      csvLine(["2026-09-25T18:02:00", "없는구역이름", "표지판이 없어서 헤맸어요"]),
    ].join("\n") + "\n", "utf8");
    await replay.start(seedFile, { speed: 1e9 });
    assert.equal(await replay.step(), 3);
    const z = Object.fromEntries((await all(db, "SELECT raw_text, zone_id FROM feedback")).map((r: any) => [r.raw_text, r.zone_id]));
    assert.equal(z["진입로가 너무 어두워요"], first.id);
    assert.equal(z["화장실 줄이 너무 길어요"], null);
    assert.equal(z["표지판이 없어서 헤맸어요"], null);
    assert.notEqual(await db.insert_feedback(null, "주차장이 너무 혼잡해요", "test"), null);
    const shown = Object.fromEntries((await db.recent_feedback(10)).map((r: any) => [r.raw_text, r.zone]));
    assert.equal(shown["주차장이 너무 혼잡해요"], config.ZONE_UNKNOWN);
    assert.equal(shown["진입로가 너무 어두워요"], first.name);
    const pend = await classifier.get_pending.fn(10);
    assert.ok(new Set(pend.map((p: any) => p.zone)).has(config.ZONE_UNKNOWN));
    for (const p of await classifier.get_pending.fn(10)) {
      const unknown = p.zone === config.ZONE_UNKNOWN;
      await classifier.save_classification.fn(p.id, unknown ? "restroom" : "safety", -0.5, false, 0.8, "테스트");
    }
    const quotes = await dispatcher.collect_quotes.fn("restroom");
    assert.ok(quotes.length && quotes.every((q: any) => q.zone === config.ZONE_UNKNOWN));
  });
});

test("test_유형순위_정렬_즉시_혼잡이_높음_주차_아래로_내려가지_않는다", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const ref = new Date(2026, 8, 30, 14, 0, 0);
  const spec: Array<[string, number, number, boolean]> = [
    ...[300, 290, 280].map((mm) => ["crowd", mm, -0.1, true] as [string, number, number, boolean]),
    ...Array.from({ length: 12 }, (_, i) => ["parking", i * 5, -0.5, false] as [string, number, number, boolean]),
  ];
  const out = await S.rank_labels(rows(spec, ref), { unhandled_fn: () => false, ref });
  const by = Object.fromEntries(out.map((r: any) => [r.label, r]));
  assert.ok(by.crowd.grade === "immediate" && by.parking.grade === "high");
  assert.ok(by.parking.score > by.crowd.score);
  assert.deepEqual(out.map((r: any) => r.label), ["crowd", "parking"]);
  const spec2: Array<[string, number, number, boolean]> = [
    ...[40, 35, 30].map((mm) => ["crowd", mm, -0.1, true] as [string, number, number, boolean]),
    ...Array.from({ length: 20 }, (_, i) => ["parking", i % 50, -0.5, false] as [string, number, number, boolean]),
  ];
  const out2 = await S.rank_labels(rows(spec2, ref), { unhandled_fn: () => false, ref });
  assert.deepEqual(new Set(out2.map((r: any) => r.grade)), new Set(["immediate"]));
  assert.ok(JSON.stringify(out2.map((r: any) => r.label)) === JSON.stringify(["crowd", "parking"]) && out2[0].score < out2[1].score);
});

test("test_심각도_규칙_경계값_S01_S06_B01_B04_정확히_그_값에서", async (t) => {
  const m = await need(t, "core/severity.ts", "core/config.ts"); if (!m) return;
  const [S, C] = m; const config = cfgOf(C);
  const [a9, a10, a11] = await Promise.all([9, 10, 11].map(async (n) => (await S.compute_severity(2, -0.5, n)).base_score));
  assert.ok(a9 === a10 && a11 < a10);
  assert.equal(a10, pyround(2 / config.MIN_WINDOW_TOTAL * config.W_FREQ + 0.5 * config.W_INTENSITY, 2));
  const four = await S.compute_severity(config.NONSAFETY_IMMEDIATE_MIN - 1, -1.0, 4, { spiked: true, unhandled: true });
  const five = await S.compute_severity(config.NONSAFETY_IMMEDIATE_MIN, -1.0, 5, { spiked: true, unhandled: true });
  assert.ok(four.score === config.NONSAFETY_CAP && five.score > config.NONSAFETY_CAP);
  const low = await S.compute_severity(1, -0.3, 1, { is_safety: true });
  const high = await S.compute_severity(1, -0.9, 1, { is_safety: true });
  assert.ok(low.score === config.SAFETY_FLOOR && high.score > config.SAFETY_FLOOR);
  assert.equal((await S.compute_severity(config.SAFETY_THRESHOLD, -0.1, 1000, { is_safety: true })).grade, "immediate");
  assert.notEqual((await S.compute_severity(config.SAFETY_THRESHOLD - 1, -0.1, 1000, { is_safety: true })).grade, "immediate");
  const base = (await S.compute_severity(6, -0.8, 30)).base_score;
  assert.equal((await S.compute_severity(6, -0.8, 30, { is_safety: true })).score, pyround(Math.min(100.0, base * config.W_SAFETY), 2));
  assert.equal((await S.compute_severity(6, -0.8, 30, { spiked: true })).score, pyround(Math.min(100.0, base * config.W_SPIKE), 2));
  assert.equal((await S.compute_severity(6, -0.8, 30, { unhandled: true })).score, pyround(Math.min(100.0, base * config.W_PENDING), 2));
  const ref = new Date(2026, 8, 30, 14, 0, 0);
  const spec: Array<[string, number, number, boolean]> = [...Array(12).fill(["positive", 3, 0.9, false]), ["guide", 2, -0.5, false]];
  const out = await S.rank_labels(rows(spec, ref), { ref });
  assert.deepEqual(out.map((r: any) => r.label), ["guide"]);
  assert.ok((await S.grade_of(80)) === "immediate" && (await S.grade_of(79.9)) === "high");
});
