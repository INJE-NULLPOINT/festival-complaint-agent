// D5-84 시간순 재현 엔진. 앞의 세 시험 입력은 **엔진 시험용 가상 신고**(이태원 실제 기록 아님), 마지막 시험만 실제 공개 녹취 seed/itaewon_112.csv.
// 안전 N건이 채워진 그 분에 즉시가 되고, 유입이 급증한 그 분에 급증이 잡히며, 그 전에는 아니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { need } from "./_helpers.ts";

const T = (hm: string) => `2026-10-01T${hm}:20`;

test("안전 신고가 3건째 들어온 분에 S-04 즉시, 그 전 분에는 즉시가 아니다", async (t) => {
  const m = await need(t, "scripts/_itaewon.ts"); if (!m) return;
  const [{ timeline }] = m;
  const calls = [
    { posted_at: T("20:40"), zone: "골목", text: "골목에 사람이 너무 몰려서 위험해요", label: "crowd", is_safety: true },
    { posted_at: T("20:47"), zone: "골목", text: "사람들이 밀려서 다칠 것 같아요", label: "crowd", is_safety: true },
    { posted_at: T("20:53"), zone: "골목", text: "넘어진 사람이 있어요 빨리 와 주세요", label: "crowd", is_safety: true },
  ];
  const tl = timeline(calls, { tail_min: 5 });
  assert.equal(tl.first_s04.crowd, "2026-10-01T20:53");
  assert.equal(tl.first_immediate.crowd, "2026-10-01T20:53");
  assert.notEqual(tl.moments.find((x: any) => x.at === "2026-10-01T20:52" && x.label === "crowd")?.grade, "immediate");
});

test("최근 15분 유입이 직전 평균의 2배 넘게 늘면 그 분 안에 S-03 급증", async (t) => {
  const m = await need(t, "scripts/_itaewon.ts"); if (!m) return;
  const [{ timeline }] = m;
  const calls: any[] = [];
  for (const hm of ["20:00", "20:10", "20:20", "20:30", "20:40", "20:50"]) calls.push({ posted_at: T(hm), text: "x", label: "parking", is_safety: false });   // 느린 유입
  for (const hm of ["21:00", "21:03", "21:05", "21:07", "21:09", "21:10"]) calls.push({ posted_at: T(hm), text: "x", label: "parking", is_safety: false });   // 몰림
  const tl = timeline(calls, { tail_min: 3 });
  const at = tl.first_spike.parking;
  assert.ok(at && at >= "2026-10-01T21:00" && at <= "2026-10-01T21:10", `급증 시각 ${at}`);
  assert.equal(tl.moments.some((x: any) => x.label === "parking" && x.at < "2026-10-01T21:00" && x.spiked), false);
});

test("신고 기록이 없으면 빈 결과, 분류를 주지 않으면 규칙 분류기를 쓴다", async (t) => {
  const m = await need(t, "scripts/_itaewon.ts"); if (!m) return;
  const [{ timeline }] = m;
  assert.deepEqual(timeline([]).moments, []);
  const tl = timeline([{ posted_at: T("20:00"), text: "주차장이 만차라 차를 못 댔어요" }]);
  assert.equal(tl.rows[0].label, "parking");
});

test("실제 공개 녹취 CSV: 18:34 첫 신고(압사)에서 crowd 가 바로 즉시 등급이 된다", async (t) => {
  const m = await need(t, "scripts/_itaewon.ts", "core/csv.ts"); if (!m) return;
  const [{ timeline }, { dict_reader }] = m;
  const { SEED } = await import("./_helpers.ts");
  const calls = dict_reader(SEED.replace("dev_sample.csv", "itaewon_112.csv"))
    .map((r: any) => ({ posted_at: r.posted_at, zone: r.zone, text: r.text }));
  assert.equal(calls[0].posted_at, "2022-10-29T18:34:00");
  const tl = timeline(calls);                                                  // 분류는 규칙(local) 대역
  assert.equal(tl.rows[0].label, "crowd");
  assert.equal(tl.first_immediate.crowd, "2022-10-29T18:34");
});
