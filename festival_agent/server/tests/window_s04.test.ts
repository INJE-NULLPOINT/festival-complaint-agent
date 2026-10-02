// D5-86: S-04 는 창 전체의 안전 민원 수로 센다 · '큰일 날 것 같' 구절은 안전, 지난 일('큰일 났어요')은 아니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need } from "./_helpers.ts";

const row = (label: string, is_safety: boolean, raw_text = "x") => ({ label, is_safety, sentiment: -0.6, raw_text, posted_at: "2026-10-01T20:00:00" });

test("혼잡 안전 1건 + 안전 유형 2건 = 창 전체 3건 → 안전 민원이 든 두 유형이 즉시, 안전 민원 없는 주차는 즉시가 아니다", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [sev] = m;
  const rows = [row("crowd", true), row("crowd", false), row("safety", true), row("safety", true), row("parking", false), row("parking", false), row("parking", false)];
  const g = Object.fromEntries(sev.rank_labels(rows).map((r: any) => [r.label, r.grade]));
  assert.equal(g.crowd, "immediate");
  assert.equal(g.safety, "immediate");
  assert.notEqual(g.parking, "immediate");
});

test("창 전체 안전이 3건 미만이면 즉시가 아니다 (혼잡 1 + 안전 1)", async (t) => {
  const m = await need(t, "core/severity.ts"); if (!m) return;
  const [sev] = m;
  const g = Object.fromEntries(sev.rank_labels([row("crowd", true), row("safety", true)]).map((r: any) => [r.label, r.grade]));
  assert.notEqual(g.crowd, "immediate");
  assert.notEqual(g.safety, "immediate");
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
