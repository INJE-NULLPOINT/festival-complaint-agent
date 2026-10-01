// 심각도 가중치 민감도 점검 (D5-85) — "가중치를 ±20% 바꿔도 결론(안전 1위·건수 1위는 즉시 아님)이 유지되는가"를 직접 센다.
//
//   node server/scripts/sensitivity.ts               시드 160건 → tests/sensitivity_report.md
//   node server/scripts/sensitivity.ts --seed <csv>  다른 시드
//   node server/scripts/sensitivity.ts --no-report   표만 출력하고 파일은 쓰지 않는다
//
// 방법
//   · 시드(seed/dev_sample.csv 160건, 합성)를 임시 SQLite 에 넣고 **local 규칙**으로 분류한다 (AI 호출 없음, 운영 DB 미사용).
//   · 시드 전체를 한 창으로 보고 core/severity.ts 의 rank_labels 로 라벨별 심각도를 계산한다 (급증·미조치는 데이터에서 읽는다).
//   · W_FREQ · W_INTENSITY · W_SAFETY · W_SPIKE 를 각각 −20% · 0 · +20% 로 바꿔 3^4 = 81개 조합 전부를 계산한다.
//     W_PENDING(미조치 ×1.2)은 시드에 조치 상태가 없어 점수에 닿지 않으므로 조합에서 뺀다 (리포트에 적는다).
//   · 조합마다: ① 심각도 1위가 안전(safety)인가  ② 건수 1위 유형이 '즉시'가 아닌가  ③ 기준값 대비 순위가 몇 칸 바뀌었나.
// 결과가 '유지'가 아니면 그대로 적는다. 숫자를 맞추지 않는다.
import "./_safe_env.ts";
import path from "node:path";
import { parseArgs } from "node:util";
import { BASE_DIR, config } from "../core/config.ts";
import * as db from "../core/db.ts";
import { dict_reader } from "../core/csv.ts";
import { fixed } from "../core/pyfmt.ts";
import * as severity from "../core/severity.ts";
import * as classifier from "../agents/classifier.ts";
import { refuse_live_db, use_temp_db, write_text, ymd_hm } from "./_common.ts";

const ROOT = BASE_DIR;
const REPORT = path.join(ROOT, "tests", "sensitivity_report.md");
const KEYS = ["W_FREQ", "W_INTENSITY", "W_SAFETY", "W_SPIKE"] as const;
const DELTAS = [-0.2, 0, 0.2] as const;
type Key = typeof KEYS[number];

interface Combo {
  delta: Record<Key, number>;
  ranked: string[];                       // 심각도 순 라벨
  top: string; top_grade: string; top_score: number;
  count_top: string; count_top_grade: string;
  ok_safety_first: boolean;               // ① 심각도 1위 = safety
  ok_count_top_not_immediate: boolean;    // ② 건수 1위가 즉시가 아님
  changed: number; max_shift: number;     // ③ 기준값 대비 순위가 달라진 유형 수 · 최대 이동 칸
}

const sign = (d: number): string => (d === 0 ? "0" : d > 0 ? `+${Math.round(d * 100)}%` : `${Math.round(d * 100)}%`);

/** 가중치를 바꿔 계산하고 원래대로 돌린다 */
function with_weights<T>(delta: Record<Key, number>, base: Record<Key, number>, fn: () => T): T {
  for (const k of KEYS) (config as any)[k] = base[k] * (1 + delta[k]);
  try { return fn(); } finally { for (const k of KEYS) (config as any)[k] = base[k]; }
}

async function main(): Promise<number> {
  refuse_live_db("sensitivity");
  const { values: v } = parseArgs({ options: { seed: { type: "string", default: path.join(ROOT, "seed", "dev_sample.csv") }, "no-report": { type: "boolean", default: false } } });
  process.env.LLM_BACKEND = "local";
  use_temp_db("sensitivity.db");
  await db.init_db();

  // ── 시드 투입 + local 규칙 분류 ──
  const zone_by_name = new Map((await db.zones()).map((z) => [z.name as string, z.id as number]));
  let inserted = 0;
  for (const r of dict_reader(v.seed as string)) {
    if (!(r.text || "").trim()) continue;
    const fid = await db.insert_feedback(zone_by_name.get((r.zone || "").trim()) ?? null, r.text!, "dev", r.posted_at || null);
    if (fid !== null) inserted += 1;
  }
  for (let i = 0; i < 40 && (await db.pending_count()) > 0; i++) await classifier.run_once(50);
  const rows = await db.window_rows(10_000_000);                 // 시드 전체를 한 창으로
  const ref = await db.data_now();
  if (!rows.length) { console.error("분류된 민원이 없습니다."); return 1; }

  const counts = new Map<string, number>();
  for (const r of rows) if (!config.EXCLUDED_FROM_SEVERITY.has(r.label)) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  const count_top = [...counts].sort((a, b) => b[1] - a[1])[0][0];     // 건수 1위 (동률이면 먼저 나온 유형)

  const base: Record<Key, number> = { W_FREQ: config.W_FREQ, W_INTENSITY: config.W_INTENSITY, W_SAFETY: config.W_SAFETY, W_SPIKE: config.W_SPIKE };
  const rank = (): any[] => severity.rank_labels(rows, null, { ref });
  const baseline = rank();
  const base_pos = new Map(baseline.map((r, i) => [r.label as string, i]));
  const spiked_labels = baseline.filter((r) => r.spike?.spiked).map((r) => r.label as string);
  const name = (l: string): string => config.LABELS[l] ?? l;

  // ── 81개 조합 ──
  const combos: Combo[] = [];
  const zero: Record<Key, number> = { W_FREQ: 0, W_INTENSITY: 0, W_SAFETY: 0, W_SPIKE: 0 };
  for (const a of DELTAS) for (const b of DELTAS) for (const c of DELTAS) for (const d of DELTAS) {
    const delta: Record<Key, number> = { W_FREQ: a, W_INTENSITY: b, W_SAFETY: c, W_SPIKE: d };
    const r = with_weights(delta, base, rank);
    const pos = new Map(r.map((x, i) => [x.label as string, i]));
    let changed = 0, max_shift = 0;
    for (const [l, p0] of base_pos) { const s = Math.abs((pos.get(l) ?? p0) - p0); if (s) changed += 1; max_shift = Math.max(max_shift, s); }
    const ct = r.find((x) => x.label === count_top)!;
    combos.push({
      delta, ranked: r.map((x) => x.label), top: r[0].label, top_grade: r[0].grade, top_score: r[0].score,
      count_top, count_top_grade: ct.grade,
      ok_safety_first: r[0].label === "safety", ok_count_top_not_immediate: ct.grade !== "immediate",
      changed, max_shift,
    });
  }
  const n = combos.length;
  const ok1 = combos.filter((c) => c.ok_safety_first).length;
  const ok2 = combos.filter((c) => c.ok_count_top_not_immediate).length;
  const okAll = combos.filter((c) => c.ok_safety_first && c.ok_count_top_not_immediate).length;
  const reversed = combos.filter((c) => c.top !== c.count_top).length;       // 건수 1위와 심각도 1위가 다름(역전)
  const same_rank = combos.filter((c) => c.changed === 0).length;
  const max_shift = Math.max(...combos.map((c) => c.max_shift));
  const max_changed = Math.max(...combos.map((c) => c.changed));

  // 안전 가중이 어디까지 내려가도 안전이 1위인가 (나머지는 기준값, 0.01 단위) — 여유 폭
  let w_min = base.W_SAFETY;
  for (let w = base.W_SAFETY; w >= 1.0 - 1e-9; w = Math.round((w - 0.01) * 100) / 100) {
    const r = with_weights({ ...zero, W_SAFETY: w / base.W_SAFETY - 1 }, base, rank);
    if (r[0].label === "safety") w_min = w; else break;
  }

  // ── 출력 ──
  const verdict = okAll === n ? "유지" : "일부 깨짐";
  console.log(`조합 ${n}개 · ① 심각도 1위=안전 ${ok1}/${n} · ② 건수 1위(${name(count_top)}) 즉시 아님 ${ok2}/${n} · 둘 다 ${okAll}/${n} → ${verdict}`);
  console.log(`③ 순위 변화: 기준값과 같은 순위 ${same_rank}개 · 최대 ${max_changed}개 유형 · 최대 ${max_shift}칸 이동 · 안전 가중 하한 ${fixed(w_min, 2)}(기준 ${fixed(base.W_SAFETY, 1)})`);
  if (v["no-report"]) return okAll === n ? 0 : 1;

  const L: string[] = [];
  L.push("# 심각도 가중치 민감도 점검 (D5-85)", "");
  L.push(`- 수행 ${ymd_hm(new Date())} · 시드 \`${path.basename(v.seed as string)}\` ${inserted}건(합성 — 실제 방문객 글이 아님) · 분류는 **local 규칙**(AI 호출 없음) · 임시 SQLite(운영 DB 미사용)`);
  L.push(`- 창: 시드 전체를 한 창으로 계산 · 분류된 민원 ${rows.length}건(긍정은 심각도에서 제외) · 기준 시각 = 마지막 민원 시각`);
  L.push(`- 바꾼 가중치: ${KEYS.map((k) => `${k}=${floatS(base[k])}`).join(" · ")} 각각 −20% · 0 · +20% → 3⁴ = **${n}개 조합 전부**. W_PENDING(미조치 ×${floatS(config.W_PENDING)})은 시드에 조치 상태가 없어 점수에 닿지 않아 뺐다.`);
  L.push(`- 급증(S-03)이 적용된 유형: ${spiked_labels.length ? spiked_labels.map(name).join(", ") : "없음"}${spiked_labels.length ? "" : " → W_SPIKE 는 이 시드에서 점수를 바꾸지 않는다(그래서 W_SPIKE 축은 결과에 영향이 없다). 급증 장면은 시나리오 시험으로 따로 본다."}`, "");
  L.push("## 결과", "");
  L.push(`- 조합 수: **${n}**`);
  L.push(`- ① 심각도 1위가 안전: **${ok1}/${n}**`);
  L.push(`- ② 건수 1위(${name(count_top)}, ${counts.get(count_top)}건)가 '즉시'가 아님: **${ok2}/${n}**`);
  L.push(`- ①②가 모두 유지된 조합: **${okAll}/${n}** → 판정 **${verdict}**`);
  L.push(`- 건수 1위(${name(count_top)})와 심각도 1위가 다른 조합(역전): ${reversed}/${n}`);
  L.push(`- ③ 순위 변화: 기준값과 순위가 완전히 같은 조합 ${same_rank}/${n} · 최대 ${max_changed}개 유형이 자리를 바꾼 조합 있음 · 가장 많이 움직인 유형은 **최대 ${max_shift}칸**`);
  L.push(`- 안전 가중(W_SAFETY, 기준 ${floatS(base.W_SAFETY)})을 다른 값은 그대로 두고 낮출 때 안전이 1위로 남는 최저값: **${fixed(w_min, 2)}** (기준값 대비 ${fixed((1 - w_min / base.W_SAFETY) * 100, 0)}% 아래까지)`);
  if (okAll !== n) L.push("", `> ⚠ ${n - okAll}개 조합에서 결론이 유지되지 않았다. 아래 표의 ✗ 를 그대로 적는다 — 문서의 '±20% 바꿔도 유지'는 이 결과와 같게 고쳐야 한다.`);
  L.push("", "## 기준값(변경 없음)의 심각도 순위", "", "| 순위 | 유형 | 건수 | 점수 | 등급 | 안전 민원 | 급증 |", "|---|---|---|---|---|---|---|");
  baseline.forEach((r, i) => L.push(`| ${i + 1} | ${name(r.label)} | ${r.freq} | ${r.score} | ${config.GRADE_KO[r.grade] ?? r.grade} | ${r.safety_freq} | ${r.spike?.spiked ? "예" : "-"} |`));
  L.push("", `## ${n}개 조합 전체`, "", "가중치 열은 기준값 대비 변화율. ① 심각도 1위=안전 · ② 건수 1위가 즉시 아님 · ③ 기준값 대비 순위가 달라진 유형 수(최대 이동 칸).", "",
    "| # | W_FREQ | W_INTENSITY | W_SAFETY | W_SPIKE | 심각도 1위 | ① | ② | ③ | 순위 |", "|---|---|---|---|---|---|---|---|---|---|");
  combos.forEach((c, i) => L.push(`| ${i + 1} | ${sign(c.delta.W_FREQ)} | ${sign(c.delta.W_INTENSITY)} | ${sign(c.delta.W_SAFETY)} | ${sign(c.delta.W_SPIKE)} | ` +
    `${name(c.top)} ${floatS(c.top_score)} | ${c.ok_safety_first ? "✓" : "✗"} | ${c.ok_count_top_not_immediate ? "✓" : `✗(${config.GRADE_KO[c.count_top_grade]})`} | ` +
    `${c.changed ? `${c.changed}개·${c.max_shift}칸` : "같음"} | ${c.ranked.map(name).join(" > ")} |`));
  L.push("");
  write_text(REPORT, L.join("\n"));
  console.log(`→ ${REPORT}`);
  return okAll === n ? 0 : 1;
}

const floatS = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(Math.round(x * 100) / 100));

if (import.meta.main) {
  const code = await main();
  await db.close_all();
  process.exit(code);
}
