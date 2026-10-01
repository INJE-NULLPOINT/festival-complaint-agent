// sync_numbers.ts 의 표식 갱신 규칙 (D5-70): 표식 안의 값만 바뀐다 · 원천에 없는 키는 그대로 · 줄바꿈 유지 · 같은 값은 변경 없음
import assert from "node:assert/strict";
import test from "node:test";
import { apply, type Values } from "../scripts/sync_numbers.ts";

const values: Values = new Map([
  ["accuracy", { value: "91.3%", source: "t" }],
  ["tc_pass", { value: "5/5", source: "t" }],
]);

test("표식 안의 값만 바꾸고 바깥 글자는 그대로 둔다", () => {
  const src = "정확도 <!--n:accuracy-->87.5%<!--/n--> 이고 본문의 87.5% 와 <b>태그</b> 는 그대로\r\n";
  const r = apply(src, values);
  assert.equal(r.text, "정확도 <!--n:accuracy-->91.3%<!--/n--> 이고 본문의 87.5% 와 <b>태그</b> 는 그대로\r\n");
  assert.deepEqual(r.changes, [{ key: "accuracy", old: "87.5%", now: "91.3%" }]);
});

test("원천에 없는 키는 바꾸지 않고 알린다", () => {
  const src = "<!--n:nope-->값<!--/n--> <!--n:tc_pass-->0/5<!--/n-->";
  const r = apply(src, values);
  assert.equal(r.text, "<!--n:nope-->값<!--/n--> <!--n:tc_pass-->5/5<!--/n-->");
  assert.deepEqual(r.unknown, ["nope"]);
});

test("같은 값이면 바뀐 것으로 세지 않는다", () => {
  const r = apply("<!--n:accuracy-->91.3%<!--/n-->", values);
  assert.equal(r.changes.length, 0);
  assert.equal(r.same, 1);
});

test("닫는 표식이 없으면 건드리지 않는다 (줄바꿈을 넘어 삼키지 않음)", () => {
  const src = "<!--n:accuracy-->87.5%\n다음 줄 <!--/n-->";
  assert.equal(apply(src, values).text, src);
});

test("wall_clock_report.md 의 1건 접수 줄을 llm_* 키로 읽는다 (동시 접수 리포트는 읽지 않음)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { collect } = await import("../scripts/sync_numbers.ts");
  const root = mkdtempSync(path.join(tmpdir(), "sn-"));
  mkdirSync(path.join(root, "tests"));
  const single = "# 접수→분류 벽시계 측정 (2026-10-02 09:30)\n\n- 모드 `agent` · 백엔드 `claude_code` · 임시 DB\n\n**1건 접수: 중앙값 17.1s · p90 20.0s · 최대 21.4s** (신청서 목표 10초 이내 → 미달)\n";
  writeFileSync(path.join(root, "tests", "wall_clock_report.md"), single);
  const v = collect({ strict: false, root, project: root });
  assert.equal(v.get("llm_latency_median")?.value, "17.1초");
  assert.equal(v.get("llm_latency_max")?.value, "21.4초");
  assert.equal(v.get("llm_backend")?.value, "claude_code");
  assert.equal(v.get("llm_at")?.value, "2026-10-02 09:30");
  assert.equal(collect({ strict: true, root, project: root }).has("llm_latency_median"), false, "strict 는 anthropic 만");
  writeFileSync(path.join(root, "tests", "wall_clock_report.md"), "# 동시 접수 20건 측정 (2026-10-02 09:40)\n\n- 모드 `agent` · 백엔드 `local`\n");
  assert.equal(collect({ strict: false, root, project: root }).has("llm_latency_median"), false);
});

test("1건 접수 줄의 p90·횟수를 llm_latency_p90 · llm_n 으로 읽는다", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { collect } = await import("../scripts/sync_numbers.ts");
  const root = mkdtempSync(path.join(tmpdir(), "sn-"));
  mkdirSync(path.join(root, "tests"));
  const f = path.join(root, "tests", "wall_clock_report.md");
  writeFileSync(f, "# 접수→분류 벽시계 측정 (2026-10-02 10:00)\n\n- 모드 `prefetch` · 백엔드 `anthropic`\n\n**1건 접수: 중앙값 6.5s · p90 9.1s · 최대 11.1s** (20회 · 신청서 목표 10초 이내 → 중앙값·p90 은 달성, 최대는 초과)\n");
  const v = collect({ strict: true, root, project: root });
  assert.equal(v.get("llm_latency_p90")?.value, "9.1초");
  assert.equal(v.get("llm_latency_max")?.value, "11.1초");
  assert.equal(v.get("llm_n")?.value, "20");
});

test("percentile 은 최근접 순위 (20개면 18번째, 10개면 9번째)", async () => {
  const { percentile } = await import("../scripts/_common.ts");
  const v = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(v, 90), 18);
  assert.equal(percentile(v.slice(0, 10), 90), 9);
  assert.equal(percentile([5], 90), 5);
});

test("sensitivity_report.md 의 결과 줄을 sens_* 키로 읽는다 (폭이 비대칭이면 sens_range 는 비운다)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { collect } = await import("../scripts/sync_numbers.ts");
  const root = mkdtempSync(path.join(tmpdir(), "sn-"));
  mkdirSync(path.join(root, "tests"));
  const f = path.join(root, "tests", "sensitivity_report.md");
  const body = (range: string) => `# 심각도 가중치 민감도 점검 (D5-85)\n\n- 수행 2026-10-01 13:03 · 시드\n- 바꾼 가중치: W_FREQ=60.0 각각 ${range} → 3⁴ = **81개 조합 전부**.\n\n## 결과\n\n- 조합 수: **81**\n- ① 심각도 1위가 안전: **80/81**\n- ② 건수 1위(주차/교통, 54건)가 '즉시'가 아님: **81/81**\n- ①②가 모두 유지된 조합: **80/81** → 판정 **유지**\n- 안전 가중(W_SAFETY, 기준 2.0)을 낮출 때 안전이 1위로 남는 최저값: **1.00** (기준값 대비 50% 아래까지)\n`;
  writeFileSync(f, body("−20% · 0 · +20%"));
  const v = collect({ strict: true, root, project: root });
  assert.deepEqual(["sens_n", "sens_safety_top", "sens_count_not_immediate", "sens_hold", "sens_range", "sens_min_safety_w", "sens_at"].map((k) => v.get(k)?.value),
    ["81", "80/81", "81/81", "80/81", "±20%", "1.00", "2026-10-01 13:03"]);
  writeFileSync(f, body("−20% · 0 · +10%"));
  assert.equal(collect({ strict: true, root, project: root }).has("sens_range"), false);
});
