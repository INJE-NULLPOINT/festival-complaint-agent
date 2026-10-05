// D5-83 즉시(immediate) 규칙 명확화 — ① 명시적 생명위험어 1건이면 즉시 ② 일반 안전 1~2건은 높음(상한 79.9) ③ 3건 이상은 즉시(S-04).
// 예전에는 안전 1건이 점수 80 을 넘으면 즉시가 되어 문서의 '3건 이상이면 즉시'와 실제 동작이 달랐다. 운영자가 오탐으로 지운 민원은 다음 계산부터 빠진다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, seed } from "./_helpers.ts";

type Item = [number | null, string, number, number, boolean, string];
const safety = (n: number, text = (i: number) => `유등터널 난간이 흔들려서 위험해요 ${i}번째`): Item[] =>
  Array.from({ length: n }, (_, i): Item => [4, "safety", 8 - i, -1.0, true, text(i)]);   // 강한 부정(-1.0) — 예전에는 1건도 80 을 넘었다

const gradeOf = async (db: any, label: string) => (await db.ranked()).find((r: any) => r.label === label);

test("test_일반_안전_1_2건은_높음까지_3건_이상은_즉시", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  // 계산 함수 직접: 강한 부정 1건·2건 — 점수 상한 79.9(높음), 3건부터 S-04 즉시
  const one = S.compute_severity(1, -1.0, 1, { is_safety: true, safety_freq: 1 });
  const two = S.compute_severity(2, -1.0, 2, { is_safety: true, safety_freq: 2 });
  const three = S.compute_severity(3, -1.0, 3, { is_safety: true, safety_freq: 3 });
  assert.deepEqual([one.grade, one.score], ["high", 79.9]);
  assert.deepEqual([two.grade, two.score], ["high", 79.9]);
  assert.equal(three.grade, "immediate");
  assert.ok(one.formula.includes("안전 1건 < 3건 → 상한 79.9"), one.formula);
  // 안전 하한(B-04 최소 높음)은 그대로
  assert.equal(S.compute_severity(1, -0.1, 1000, { is_safety: true, safety_freq: 1 }).grade, "high");
  await withTempDb(async (db) => {
    for (const n of [1, 2]) {
      await db.connect().then((c: any) => c.execute("DELETE FROM classification")).then(() => db.connect()).then((c: any) => c.execute("DELETE FROM feedback"));
      await seed(db, safety(n));
      const r = await gradeOf(db, "safety");
      assert.deepEqual([r.freq, r.grade], [n, "high"], `안전 ${n}건`);
      assert.ok(r.score <= 79.9);
    }
    await db.connect().then((c: any) => c.execute("DELETE FROM classification")).then(() => db.connect()).then((c: any) => c.execute("DELETE FROM feedback"));
    await seed(db, safety(3));
    assert.equal((await gradeOf(db, "safety")).grade, "immediate");              // 3건 → S-04
  });
});

test("test_명시적_생명위험어가_든_안전_민원은_1건이어도_즉시", async (t) => {
  const m = await need(t, "core/severity.ts", "core/rules.ts"); if (!m) return;
  const [S, rules] = m;
  assert.equal(S.compute_severity(1, -0.3, 1000, { is_safety: true, safety_freq: 1, life_freq: 1 }).grade, "immediate");
  for (const s of ["입구에서 사람들이 압사당할 것 같아요", "아이가 질식할 것 같아요", "사람이 쓰러졌어요", "의식이 없어요", "의식을 잃었어요", "저기 불났어요", "화재가 났어요",
    "물에 빠졌어요", "아이가 강에 빠졌어요", "감전됐어요", "가스 냄새가 심해요", "구조물이 무너졌어요", "폭발음이 났어요"]) {
    assert.equal(rules.life_danger(s), true, s);
  }
  for (const s of ["난간이 흔들려요", "조명이 꺼져 있어요", "바닥이 미끄러워요", "줄이 너무 길어요", "쓰레기통이 넘쳐요", "화장실이 더러워요", "불편해요"]) {
    assert.equal(rules.life_danger(s), false, s);                                // 일반 안전·불편은 생명위험어가 아니다
  }
  await withTempDb(async (db) => {
    await seed(db, [[1, "parking", 20, -0.5, false, "주차장이 만차예요 차를 못 댔어요"], [4, "crowd", 3, -0.9, true, "터널 입구에서 압사당할 것 같아요 사람이 너무 많아요"]]);
    const r = await gradeOf(db, "crowd");
    assert.deepEqual([r.freq, r.grade], [1, "immediate"]);                       // 1건인데 즉시 (생명위험어)
    assert.ok(r.formula.includes("생명위험 신호 → 즉시"), r.formula);
    assert.equal(r.life_freq, 1);
    // 안전 신호가 아닌 민원(is_safety=false, 안내 유형)에 같은 말이 있어도 세지 않는다 — '불났다는 안내방송은 언제 해요' 같은 문의
    await seed(db, [[2, "guide", 2, -0.2, false, "불났을 때 안내방송은 어떻게 나오는지 알려 주세요"]]);
    const g = await gradeOf(db, "guide");
    assert.notEqual(g.grade, "immediate");
    assert.equal(g.life_freq, 0);
  });
});

test("test_운영자가_오탐으로_지운_민원은_다음_계산부터_즉시에서_빠진다", async (t) => {
  const m = await need(t, "webapi.ts", "core/review.ts"); if (!m) return;
  const [webapi] = m;
  await withTempDb(async (db) => {
    const [fid] = await seed(db, [[4, "safety", 3, -0.9, true, "사람이 쓰러졌어요 의식이 없어요"]]);
    assert.equal((await gradeOf(db, "safety")).grade, "immediate");              // 생명위험어 1건 → 즉시
    // 오탐 — 운영자가 '민원 지우기'(숨김)로 처리하면 심각도 계산에서 빠진다 (되돌리면 다시 들어온다)
    await webapi.delete_feedback(fid);
    assert.equal(await gradeOf(db, "safety"), undefined);
    await webapi.restore_feedback(fid);
    assert.equal((await gradeOf(db, "safety")).grade, "immediate");
    // 확인 필요 → '유형 없음으로 닫기'(오탐 처리)한 민원도 계산에 들어가지 않는다
    const rv = await db.insert_feedback(4, "뭔가 쓰러질 것 같은 분위기예요 모호해요", "qr");
    await (await db.connect()).execute("UPDATE classification SET status='review', label=NULL, is_safety=1, confidence=0.1 WHERE feedback_id=?", [rv]);
    assert.equal((await gradeOf(db, "safety")).freq, 1);                          // review 는 원래 계산 밖
    await webapi.dismiss_review(rv);
    assert.equal((await gradeOf(db, "safety")).freq, 1);
  });
});

test("test_역전_시드는_그대로_안전_즉시_건수1위_주차는_즉시_아님", async (t) => {
  const m = await need(t, "core/severity.ts", "core/rules.ts", "core/config.ts"); if (!m) return;
  const [S, rules, C] = m; const config = C.config ?? C;
  const { readFileSync } = await import("node:fs");
  const { SEED, parseCsv } = await import("./_helpers.ts");
  const rows: any[] = [];
  for (const r of parseCsv(readFileSync(SEED, "utf8"))) {
    const c = await rules.classify(r.text);
    if (c.confidence < config.REVIEW_CONFIDENCE) continue;
    rows.push({ label: c.label, sentiment: c.sentiment, is_safety: c.is_safety ? 1 : 0, posted_at: r.posted_at, ingested_at: "", zone_id: r.zone, raw_text: r.text });
  }
  const ref = new Date(rows.map((r) => r.posted_at).sort().at(-1)!);
  const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  const cut = iso(new Date(ref.getTime() - 5760 * 60000));
  const out = S.rank_labels(rows.filter((r) => r.posted_at >= cut), { unhandled_fn: () => true, ref });
  const by = Object.fromEntries(out.map((r: any) => [r.label, r]));
  assert.ok(out[0].label === "safety" && out[0].grade === "high");     // S-04 는 같은 구역 1시간 3건 — 4일에 흩어진 시드의 안전 11건은 높음
  assert.equal(by.parking.freq, Math.max(...out.map((r: any) => r.freq)));          // 건수 1위는 주차
  assert.notEqual(by.parking.grade, "immediate");
});
