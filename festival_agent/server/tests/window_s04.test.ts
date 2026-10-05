// D5-86: S-04 는 같은 구역(zone)의 안전 민원 수로 센다 (유형 무관) · 구역 미상은 묶지 않는다 · 생명위험 구절은 구절 단위.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need } from "./_helpers.ts";

const row = (label: string, is_safety: boolean, zone_id: number | null, n = 0) =>
  ({ label, is_safety, zone_id, feedback_id: n, sentiment: -0.6, raw_text: "x", posted_at: "2026-10-01T20:00:00" });
const REF = new Date("2026-10-01T20:30:00");        // 민원 시각(20:00)에서 30분 뒤 — S-04 의 1시간 안
const grades = (S: any, rows: any[], ref = REF) => Object.fromEntries(S.rank_labels(rows, { ref }).map((r: any) => [r.label, r.grade]));

test("같은 구역의 안전 3건이 혼잡·안전 유형에 갈려도 두 유형 모두 즉시, 안전 없는 주차는 즉시가 아니다", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const g = grades(S, [row("crowd", true, 1), row("crowd", false, 1), row("safety", true, 1), row("safety", true, 1),
    row("parking", false, 1), row("parking", false, 1), row("parking", false, 1)]);
  assert.equal(g.crowd, "immediate");
  assert.equal(g.safety, "immediate");
  assert.notEqual(g.parking, "immediate");
});

test("안전 3건이 서로 다른 구역이면 즉시가 아니다 · 구역을 모르는 민원은 서로 묶지 않는다", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const split = grades(S, [row("crowd", true, 1), row("safety", true, 2), row("safety", true, 3)]);
  assert.notEqual(split.crowd, "immediate");
  assert.notEqual(split.safety, "immediate");
  const unknown = grades(S, [row("crowd", true, null, 1), row("safety", true, null, 2), row("safety", true, null, 3)]);
  assert.notEqual(unknown.crowd, "immediate");
  assert.notEqual(unknown.safety, "immediate");
  const two_in_one = grades(S, [row("crowd", true, 1), row("safety", true, 1), row("safety", true, 2), row("safety", true, 2)]);
  assert.notEqual(two_in_one.crowd, "immediate");              // 구역 1 은 2건, 구역 2 는 2건
});

test("'큰일 날 것 같' 구절은 안전으로 · 지난 일·무관한 '큰일'은 안전이 아니다", async (t) => {
  const m = await need(t, "core/rules.ts", "core/memory.ts"); if (!m) return;
  const [rules, memory] = m;
  for (const s of ["지금 좀 큰일 날 것 같은데", "이러다 큰일날 거 같아요", "큰일 나겠어요 빨리 와주세요"]) {
    assert.equal(rules.classify(s).label, "safety", s);
    assert.ok(memory.risk_signals(s).some((x: string) => x.startsWith("안전·긴급")), s);
  }
  for (const s of ["늦어서 큰일 났네요 ㅎㅎ", "주차 요금이 큰일이네요"]) assert.notEqual(rules.classify(s).label, "safety", s);
});

test("생명위험 구절: 연기가 나요·불꽃이 튀어요·지진·폭발물은 해당, '연기 공연'·'연기가 좋아요'·'폭탄세일'은 아니다", async (t) => {
  const m = await need(t, "core/rules.ts"); if (!m) return;
  const [rules] = m;
  for (const s of ["전선에서 연기가 나요", "방금 연기가 자욱해졌어요", "배전함에서 불꽃이 튀어요", "스파크가 일어났어요", "땅이 흔들려요 지진 같아요", "가방에 폭발물이 있는 것 같아요", "수상한 폭탄 같은 게 있어요"])
    assert.equal(rules.life_danger(s), true, s);
  for (const s of ["연기 공연이 재밌었어요", "배우 연기가 좋아요", "연기 신청은 어디서 하나요", "폭탄세일 한다던데 어디예요"])
    assert.equal(rules.life_danger(s), false, s);
});

test("S-04 는 기준 시각 전 1시간 안의 안전 민원만 센다 (같은 구역이라도 1시간 넘게 벌어지면 즉시가 아니다)", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [S] = m;
  const rows = [row("crowd", true, 1), row("crowd", true, 1), row("crowd", true, 1)];
  assert.equal(grades(S, rows)["crowd"], "immediate");
  assert.notEqual(grades(S, rows, new Date("2026-10-01T21:30:01"))["crowd"], "immediate");
});
