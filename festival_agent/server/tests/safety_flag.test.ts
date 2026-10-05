// D5-59: 안전 가중(S-02)·하한(B-04)·무조건 즉시(S-04)는 is_safety=true 민원 기준이다. 혼잡(crowd)이라도 is_safety=false(줄이 길다)면 비안전.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need, withTempDb, rows, seed, iso } from "./_helpers.ts";

const cfgOf = (m: any) => m.config ?? m;
const NOW = new Date("2026-10-01T12:00:00");

/** rank_labels 입력: [라벨, 감정, 안전여부] n 건 */
const mk = (label: string, n: number, safe: boolean, senti = -0.7) =>
  rows(Array.from({ length: n }, (_, i): [string, number, number, boolean] => [label, 1 + i, senti, safe]), NOW);
const one = (out: any[], label: string) => out.find((r) => r.label === label);

test("test_S04_즉시는_안전_민원_건수로_센다", async (t) => {
  const m = await need(t, "core/severity.ts", "core/config.ts"); if (!m) return;
  const [S, C] = m; const config = cfgOf(C);
  const n = config.SAFETY_THRESHOLD;
  // 전체 n 건 중 안전 1건 → 즉시 아님. 안전 n 건 → 즉시.
  assert.notEqual(S.compute_severity(n, -0.7, 100, { is_safety: true, safety_freq: 1 }).grade, "immediate");
  assert.equal(S.compute_severity(n, -0.7, 100, { is_safety: true, safety_freq: n }).grade, "immediate");
  assert.equal(S.compute_severity(n, -0.7, 100, { is_safety: true }).grade, "immediate");      // 생략 = 전부 안전 (기존 호출과 같다)
});

test("test_혼잡_is_safety_false_만_있으면_비안전과_같다", async (t) => {
  const m = await need(t, "core/severity.ts", "core/config.ts"); if (!m) return;
  const [S, C] = m; const config = cfgOf(C);
  const plain = S.rank_labels(mk("crowd", 3, false), { ref: NOW });
  const c = one(plain, "crowd");
  assert.equal(c.safety_w, 1.0);                                    // S-02 없음
  assert.notEqual(c.grade, "immediate");                            // S-04 없음
  assert.ok(c.score <= config.NONSAFETY_CAP, c.formula);          // B-03 상한 (3건 < 5건)
  assert.ok(!c.formula.includes("하한"));                           // B-04 없음
  // 같은 입력이 parking(원래 비안전)과 같은 점수
  const parking = one(S.rank_labels(mk("parking", 3, false), { ref: NOW }), "parking");
  assert.equal(c.score, parking.score);
  // 안전 플래그가 있으면 원래대로
  const risky = one(S.rank_labels(mk("crowd", 3, true), { ref: NOW }), "crowd");
  assert.equal(risky.safety_w, config.W_SAFETY);
  assert.equal(risky.grade, "immediate");
});

test("test_혼잡_안전_1건이_섞이면_하한은_붙지만_즉시는_아니다", async (t) => {
  const m = await need(t, "core/severity.ts", "core/config.ts"); if (!m) return;
  const [S, C] = m; const config = cfgOf(C);
  // 급증(S-03)이 안 걸리게 15분 간격 (S-04 는 기준 시각 전 1시간 안의 안전 민원만 센다 — 3건이 1시간 안에 들어오게), 점수가 약하게 (감정 -0.3) — 등급이 점수가 아니라 S-04 때문인지 가린다
  const spaced = (n: number, safe: boolean, from = 0) => rows(Array.from({ length: n }, (_, i): [string, number, number, boolean] => ["crowd", 10 + 15 * (from + i), -0.3, safe]), NOW);
  const mixed = [...spaced(2, false), ...spaced(1, true, 2)];
  const c = one(S.rank_labels(mixed, { ref: NOW }), "crowd");
  assert.equal(c.safety_w, config.W_SAFETY);
  assert.ok(c.score >= config.SAFETY_FLOOR);                        // B-04 (안전 1건)
  assert.notEqual(c.grade, "immediate");                            // S-04 는 안전 3건부터
  const three = one(S.rank_labels([...spaced(1, false), ...spaced(3, true, 1)], { ref: NOW }), "crowd");
  assert.equal(three.grade, "immediate");                           // 안전 3건 + 비안전 1건 → S-04
});

test("test_safety_라벨은_is_safety_가_0이어도_안전이다", async (t) => {
  const m = await need(t, "core/severity.ts", "core/config.ts"); if (!m) return;
  const [S, C] = m; const config = cfgOf(C);
  const s = one(S.rank_labels(mk("safety", config.SAFETY_THRESHOLD, false), { ref: NOW }), "safety");
  assert.equal(s.safety_w, config.W_SAFETY);
  assert.equal(s.grade, "immediate");
  // 라벨만 safety 이고 is_safety=1 이어도 같다 (기존 동작)
  assert.equal(one(S.rank_labels(mk("safety", config.SAFETY_THRESHOLD, true), { ref: NOW }), "safety").grade, "immediate");
});

test("test_local_분류는_줄이_길다는_안전이_아니고_압사_위험은_안전이다", async (t) => {
  const m = await need(t, "core/rules.ts"); if (!m) return;
  const [rules] = m;
  const a = rules.classify("사람이 너무 많아서 줄이 너무 길어요");
  assert.deepEqual([a.label, a.is_safety], ["crowd", false]);
  const b = rules.classify("인파에 밀려서 압사할 것 같아요");
  assert.deepEqual([b.label, b.is_safety], ["crowd", true]);
  assert.equal(rules.classify("계단 난간이 흔들려요").is_safety, true);
});

test("test_카드_줄이_긴_혼잡은_즉시가_아니고_안전_혼잡_카드와_구역별로_갈린다", async (t) => {
  const m = await need(t, "core/issues.ts"); if (!m) return;
  const { cards } = await import("./_helpers.ts");
  await withTempDb(async (db) => {
    // 소망등 달기 구역(6): 줄이 길다 3건 (is_safety=false)
    await seed(db, [[6, "crowd", 9, -0.6, false, "소망등 달기 줄이 너무 길어요"], [6, "crowd", 6, -0.6, false, "소망등 줄이 한 시간이에요"],
                    [6, "crowd", 3, -0.6, false, "소망등 달기 대기 줄이 길어요"]]);
    let cs = (await cards()).filter((c: any) => c.label === "crowd");
    assert.equal(cs.length, 1);
    assert.equal(cs[0].is_safety, 0);
    assert.notEqual(cs[0].grade, "immediate");
    // 유등터널(4): 위험한 밀집 3건 (is_safety=true) 을 더하면 그 카드만 안전·즉시
    await seed(db, [[4, "crowd", 8, -0.9, true, "터널 안에서 사람에 밀려 넘어질 뻔했어요"], [4, "crowd", 5, -0.9, true, "터널 입구 압사 위험을 느꼈어요"],
                    [4, "crowd", 2, -0.9, true, "터널에서 사람들이 밀려와 위험해요"]]);
    cs = (await cards()).filter((c: any) => c.label === "crowd");
    const tunnel = cs.find((c: any) => c.zone_name === "유등터널");
    const wish = cs.find((c: any) => c.zone_name === "소망등 달기 구역");
    assert.equal(tunnel.is_safety, 1);
    assert.equal(tunnel.grade, "immediate");
    assert.equal(wish.is_safety, 0);                                // 같은 유형이어도 안전 민원이 없는 구역 카드는 비안전
    assert.ok(wish.type_score < tunnel.type_score);                 // 안전 가중(×2)을 뺀 점수로 다시 매긴다
  });
});

// D5-59(재현 보고): 같은 유형에 위험 구역 2곳(유등터널 2건·수상무대 1건, 모두 is_safety=1)과 줄만 긴 구역 1곳(소망등 3건, is_safety=0).
// 유형 전체로는 안전 3건이라 S-04 로 유형 등급이 즉시지만, 안전 민원이 0건인 구역 카드는 즉시를 물려받지 않는다. 알림은 안전 건수를 밝힌다.
test("test_같은_유형_위험_구역_2곳과_줄만_긴_구역_1곳", async (t) => {
  const m = await need(t, "core/issues.ts", "agents/monitor.ts"); if (!m) return;
  const [, monitor] = m;
  const { cards, withLocalBackend } = await import("./_helpers.ts");
  await withLocalBackend(async () => withTempDb(async (db) => {
    await seed(db, [
      [6, "crowd", 9, -0.6, false, "소망등 달기 줄이 너무 길어요"], [6, "crowd", 7, -0.6, false, "소망등 줄이 한 시간이에요"], [6, "crowd", 5, -0.6, false, "소망등 달기 대기 줄이 길어요"],
      [4, "crowd", 8, -0.9, true, "터널 안에서 사람에 밀려 넘어질 뻔했어요"], [4, "crowd", 6, -0.9, true, "터널 입구 압사 위험을 느꼈어요"],
      [3, "crowd", 4, -0.9, true, "수상무대 앞에서 사람들이 밀려와 위험해요"],
    ]);
    const cs = (await cards()).filter((c: any) => c.label === "crowd");
    const by = (z: string) => cs.find((c: any) => c.zone_name === z);
    const wish = by("소망등 달기 구역");
    assert.equal(wish.is_safety, 0);
    assert.notEqual(wish.grade, "immediate");                         // 줄만 긴 구역은 즉시가 아니다
    assert.ok(wish.type_score <= 79.9);
    for (const z of ["유등터널", "남강 수상무대"]) {                    // 위험 구역은 유형 등급(즉시)을 그대로
      assert.equal(by(z).is_safety, 1, z);
      assert.equal(by(z).grade, "immediate", z);
    }
    assert.ok(wish.rank_no > by("유등터널").rank_no && wish.rank_no > by("남강 수상무대").rank_no);
    // 알림: 유형 등급은 즉시지만 안전 의심 건수를 밝히고, 점수·영어 등급은 쓰지 않는다
    await monitor.run_once();
    const conn = await db.connect();
    const alerts = (await conn.execute("SELECT label, kind, detail FROM alert WHERE label='crowd'")).fetchall();
    assert.ok(alerts.length >= 1);
    assert.ok(alerts.every((a: any) => a.detail.includes("안전 의심 3건") && a.detail.includes("카드 등급은 다를 수 있습니다")), JSON.stringify(alerts));
  }));
});
