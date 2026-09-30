// 분류 정확도 측정 — ①분류 에이전트의 출력을 정답 라벨과 대조한다. (scripts/measure_accuracy.py 와 1:1)
//
// 신청서의 '분류 정확도 85% 이상' 목표를 숫자로 확인하는 스크립트다.
// 운영 DB(festival.db · Supabase)는 건드리지 않는다. 늘 임시 SQLite 에 시드를 넣고
// 실제 분류 에이전트(classifier.run_once)를 그대로 돌린 뒤 결과를 비교한다 (--live-db 는 받지 않는다).
//
// 두 가지 모드
//   시드 모드   --seed (기본 seed/dev_sample.csv). 정답은 `_label_hint` 열. 같은 문장은 1번만 센다
//               (중복은 캐시로 처리돼 정확도를 부풀리기 때문이다). 합성 시드라 **참고값**이다.
//   평가셋 모드 --labels <csv>. 사람이 직접 모은 실제 리뷰 + 2인 독립 라벨.
//               열: text · label_a · label_b · label_final (+ zone · posted_at · source_url · …)
//               scripts/templates/eval_labels_template.csv, 라벨 방법은 제출_준비/라벨링_가이드.md.
//               라벨은 사람이 붙인다. 합성·생성 문장으로 채우면 안 된다 (source_url 이 없는 행은 제외하고,
//               dev_sample.csv 는 거부한다).
//
// 출력: 정확도와 안전 재현율을 Wilson 95% 신뢰구간과 함께 보여 준다. --repeat N 번(평가셋 모드 기본 3) 돌려
// 반복 사이의 편차와 예측 안정도를 보이고, 평가셋 모드는 라벨러 간 일치율·Cohen's κ 도 보인다.
// 건수가 적으면 구간이 넓다 — 32건 합성에서 정확도 100% 는 [89%, 100%], 안전 4/4 는 [51%, 100%] 일 뿐이다.
//
// 사용법
//     node server/scripts/measure_accuracy.ts                        local 대역
//     node server/scripts/measure_accuracy.ts --backend anthropic    실제 모델 (API 비용 발생)
//     node server/scripts/measure_accuracy.ts --backend anthropic --limit 40
//     node server/scripts/measure_accuracy.ts --backend claude_code --limit 10   CLI 경유 참고값
//     node server/scripts/measure_accuracy.ts --seed seed/real.csv   다른 시드
//     node server/scripts/measure_accuracy.ts --backend anthropic --labels ../평가셋.csv --repeat 3   실제 평가셋
//
// 결과는 tests/accuracy_report.md 의 백엔드별 절에 기록된다(다른 절은 보존).
import "./_safe_env.ts";
import path from "node:path";
import { parseArgs } from "node:util";
import { BASE_DIR, config } from "../core/config.ts";
import * as db from "../core/db.ts";
import * as llm from "../core/llm.ts";
import * as classifier from "../agents/classifier.ts";
import { parse as csv_parse } from "../core/csv.ts";
import { fixed } from "../core/pyfmt.ts";
import { comma, exists, mkdtemp, read_text, refuse_live_db, stdev, write_text, ymd_hm } from "./_common.ts";
import { Random } from "./_pyrandom.ts";
import { readFileSync } from "node:fs";

const ROOT = BASE_DIR;
const REPORT = path.join(ROOT, "tests", "accuracy_report.md");
const LABELS = ["parking", "restroom", "price", "guide", "crowd", "safety", "positive"];   // core/config.ts LABELS 와 같게

type Row = Record<string, any>;

// ── 통계 ──────────────────────────────────────────────────────────

/** 이항 비율 k/n 의 Wilson 95% 신뢰구간. 건수가 적어도 [0,1] 안에서 믿을 만하다. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0.0, 0.0];
  const p = k / n;
  const d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0.0, center - half), Math.min(1.0, center + half)];
}

const counter = (xs: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/** 두 라벨러 a, b 의 Cohen's κ. 우연 일치를 뺀 일치도. 계산할 수 없으면 null (표본 없음·한쪽이 한 가지 라벨뿐). */
export function cohen_kappa(a: string[], b: string[]): number | null {
  const n = a.length;
  if (n === 0 || n !== b.length) return null;
  const po = a.reduce((s, x, i) => s + (x === b[i] ? 1 : 0), 0) / n;
  const ca = counter(a), cb = counter(b);
  const keys = new Set([...ca.keys(), ...cb.keys()]);
  let pe = 0;
  for (const k of keys) pe += (ca.get(k) ?? 0) * (cb.get(k) ?? 0);
  pe /= n * n;
  if (pe >= 1.0) return null;
  return (po - pe) / (1 - pe);
}

/** Landis & Koch 의 해석 구간. */
export function kappa_word(k: number | null): string {
  if (k === null) return "계산 불가";
  if (k <= 0.2) return "거의 없음";
  if (k <= 0.4) return "약함";
  if (k <= 0.6) return "보통";
  if (k <= 0.8) return "상당함";
  return "거의 완전";
}

const pct = (x: number): string => `${fixed(x * 100, 1)}%`;
const pct0 = (x: number): string => `${fixed(x * 100, 0)}%`;

export function ci_text(k: number, n: number): string {
  const [lo, hi] = wilson(k, n);
  return `[${pct0(lo)}, ${pct0(hi)}]`;
}

// ── 데이터 ────────────────────────────────────────────────────────

/** csv.DictReader(utf-8-sig) — 열 이름 목록과 행을 함께 돌려준다 (없는 칸은 null) */
function read_dicts(p: string): { fieldnames: string[]; rows: Record<string, string | null>[] } {
  const rows = csv_parse(readFileSync(p, "utf-8"));
  if (!rows.length) return { fieldnames: [], rows: [] };
  const head = rows[0];
  return {
    fieldnames: head,
    rows: rows.slice(1).map((r) => {
      const o: Record<string, string | null> = {};
      head.forEach((h, i) => { o[h] = i < r.length ? r[i] : null; });
      return o;
    }),
  };
}

export function load_gold(p: string): Row[] {
  const rows = read_dicts(p).rows.filter((r) => (r.text || "").trim() && (r._label_hint || "").trim());
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of rows) {
    const t = r.text!.trim();
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(r);
  }
  return out;
}

interface LabelStat { input: number; no_text: number; no_source: number; no_final: number; dup: number; a: string[]; b: string[]; disagree: number }

/** 평가셋 CSV → (정답 행 목록, 집계·제외 사유). 사람이 붙인 라벨만 쓴다.
 *
 *  포함 조건: text 가 있고, source_url 이 있고(실제 리뷰 증빙), label_final 이 7개 유형 중 하나.
 *  label_a·label_b 가 둘 다 유효한 행만 κ 에 쓴다. 같은 문장은 1번만 센다. */
export function load_labels(p: string): [Row[], LabelStat] {
  if (path.basename(p) === "dev_sample.csv") {
    throw new Error("dev_sample.csv 는 합성 데이터입니다. 평가셋에는 실제 리뷰만 넣으세요.");
  }
  const { fieldnames, rows: raw } = read_dicts(p);
  const need = ["text", "label_a", "label_b", "label_final"].filter((c) => !fieldnames.includes(c));
  if (need.length) {
    throw new Error(`필수 열이 없습니다: ${need.sort().join(", ")} (scripts/templates/eval_labels_template.csv 참고)`);
  }
  const stat: LabelStat = { input: raw.length, no_text: 0, no_source: 0, no_final: 0, dup: 0, a: [], b: [], disagree: 0 };
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const text = (r.text || "").trim();
    if (!text) { stat.no_text += 1; continue; }
    if (!(r.source_url || "").trim()) { stat.no_source += 1; continue; }     // 출처 없는 행은 실제 수집분이라는 증빙이 없다
    const fin = (r.label_final || "").trim();
    if (!LABELS.includes(fin)) { stat.no_final += 1; continue; }             // 합의가 안 됐거나 모르는 유형
    if (seen.has(text)) { stat.dup += 1; continue; }
    seen.add(text);
    const a = (r.label_a || "").trim(), b = (r.label_b || "").trim();
    if (LABELS.includes(a) && LABELS.includes(b)) {
      stat.a.push(a);
      stat.b.push(b);
      stat.disagree += a !== b ? 1 : 0;
    }
    out.push({ ...r, text, _label_hint: fin });
  }
  return [out, stat];
}

/** 운영자가 유형을 지정했거나 닫은 건(decided_by='operator')은 모델이 맞힌 것이 아니라서 정답 집합에서 뺀다.
 *  빼낸 민원 id 목록을 돌려준다 (expected 를 직접 고친다). */
export function drop_operator(expected: Map<number, string>, got: Map<number, Row>): number[] {
  const operator = [...expected.keys()].filter((f) => got.get(f)?.decided_by === "operator");
  for (const f of operator) expected.delete(f);
  return operator;
}

// ── 한 번 돌리기 ──────────────────────────────────────────────────

interface Args { backend: string; seed: string; labels: string; repeat: number; limit: number; batch: number; no_report: boolean }

interface Run {
  expected: Map<number, string>; texts: Map<number, string>; got: Map<number, Row>; operator: number[]; elapsed: number;
  tok: { calls: number; i: number; o: number; c: number }; n: number; unfinished: number; held: number; correct: number;
  safety_n: number; safety_hit: number; pred: Map<string, string>;
}

/** 새 임시 DB 에 gold 를 넣고 분류 에이전트를 돌려 결과를 모은다. 반복마다 DB 가 새것이라 캐시가 섞이지 않는다. */
async function run_once(args: Args, gold: Row[], run_no: number): Promise<Run> {
  config.DB_PATH = path.join(mkdtemp("acc-"), `accuracy_${run_no}.db`);
  await db.init_db();
  const zone_by_name = new Map((await db.zones()).map((z) => [z.name as string, z.id as number]));
  const expected = new Map<number, string>();
  const texts = new Map<number, string>();
  for (const r of gold) {
    const fid = await db.insert_feedback(zone_by_name.get((r.zone || "").trim()) ?? null,      // 모르면 NULL(구역 미상)
      r.text, "eval", r.posted_at || null);
    if (fid !== null) {
      expected.set(fid, r._label_hint.trim());
      texts.set(fid, r.text.trim());
    }
  }

  console.log(`[${args.backend}] ${run_no}회차 · ${expected.size}건 분류 시작 (임시 DB ${config.DB_PATH})`);
  const started = Date.now();
  for (let i = 0; i < Math.floor(expected.size / Math.max(args.batch, 1)) + 5; i++) {
    if ((await db.pending_count()) === 0) break;
    await classifier.run_once(args.batch);
  }
  const elapsed = (Date.now() - started) / 1000;

  const conn = await db.connect();
  const got = new Map<number, Row>();
  for (const r of (await conn.execute("SELECT feedback_id, label, is_safety, confidence, status, decided_by FROM classification")).fetchall()) {
    got.set(Number(r.feedback_id), { ...r });
  }
  const t = (await conn.execute(
    `SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) i,
                      COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_read_tokens),0) c
               FROM agent_log WHERE action IN ('api_call','cli_call')`)).fetchone()!;
  const operator = drop_operator(expected, got);        // 운영자가 처리한 건은 정확도에서 뺀다 (모델 정답이 아님)
  const safety_ids = [...expected].filter(([, y]) => y === "safety").map(([f]) => f);
  const pred = new Map<string, string>();
  for (const f of expected.keys()) pred.set(texts.get(f)!, got.get(f)?.label || "-");
  return {
    expected, texts, got, operator, elapsed,
    tok: { calls: Number(t.calls), i: Number(t.i), o: Number(t.o), c: Number(t.c) }, n: expected.size,
    unfinished: [...expected.keys()].filter((f) => !["done", "review"].includes(got.get(f)?.status)).length,
    held: [...expected.keys()].filter((f) => got.get(f)?.status === "review").length,     // 신뢰도 낮아 유형 미정
    correct: [...expected].filter(([f, y]) => got.get(f)?.label === y).length,
    safety_n: safety_ids.length,
    // 안전: 놓치면 안 되는 쪽이라 재현율을 따로 본다 (라벨=safety 또는 is_safety 플래그)
    safety_hit: safety_ids.filter((f) => got.get(f)?.label === "safety" || got.get(f)?.is_safety).length,
    pred,
  };
}

const py_round = (x: number): number => Number(fixed(x, 0));

async function main(): Promise<number> {
  refuse_live_db("measure_accuracy");
  const { values: v } = parseArgs({
    options: {
      backend: { type: "string", default: "local" },
      seed: { type: "string", default: path.join(ROOT, "seed", "dev_sample.csv") },
      labels: { type: "string", default: "" },
      repeat: { type: "string", default: "0" },
      limit: { type: "string", default: "0" },
      batch: { type: "string", default: "20" },
      "no-report": { type: "boolean", default: false },
    },
  });
  if (!["local", "anthropic", "claude_code"].includes(v.backend as string)) {
    console.error("--backend 은 local, anthropic, claude_code 중 하나여야 합니다.");
    return 2;
  }
  const args: Args = {
    backend: v.backend as string, seed: v.seed as string, labels: v.labels as string, repeat: Number(v.repeat),
    limit: Number(v.limit), batch: Number(v.batch), no_report: v["no-report"] as boolean,
  };
  const repeat = args.repeat || (args.labels ? 3 : 1);

  // 임시 DB 로 고정하고 (운영 연결 값은 _safe_env 가 이미 비웠다) 백엔드를 정한다
  config.SUPABASE_DB_URL = "";
  config.DB_PATH = path.join(mkdtemp("acc-"), "accuracy.db");
  process.env.LLM_BACKEND = args.backend;

  if (args.backend === "claude_code" && !llm.cli_path()) {
    console.log("claude CLI 를 찾을 수 없습니다 (PATH 확인).");
    return 1;
  }
  if (args.backend === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY 가 없습니다. .env 를 확인하세요.");
    return 1;
  }

  let lab: LabelStat | null = null;
  let gold: Row[];
  let source: string;
  if (args.labels) {
    try {
      [gold, lab] = load_labels(args.labels);
    } catch (e) {
      console.log(`평가셋을 읽을 수 없습니다: ${(e as Error).message}`);
      return 1;
    }
    source = `평가셋 \`${path.basename(args.labels)}\``;
    console.log(`평가셋 ${lab.input}행 → 사용 ${gold.length}행  ` +
      `(제외: 출처 URL 없음 ${lab.no_source} · 합의 라벨 없음 ${lab.no_final} · 문장 없음 ${lab.no_text} · 중복 ${lab.dup})`);
    if (lab.no_source) console.log("  ※ 출처 URL 이 없는 행은 실제 수집분이라는 증빙이 없어 뺐습니다.");
  } else {
    gold = load_gold(args.seed);
    source = `시드 \`${path.basename(args.seed)}\``;
  }
  if (!gold.length) {
    console.log(!args.labels ? "정답 라벨이 있는 행이 없습니다." : "쓸 수 있는 평가 행이 없습니다.");
    return 1;
  }
  if (args.limit && args.limit < gold.length) {
    new Random(42).shuffle(gold);            // 라벨 분포를 유지하도록 고정 시드로 표본 추출
    gold = gold.slice(0, args.limit);
  }

  const runs: Run[] = [];
  for (let i = 0; i < repeat; i++) runs.push(await run_once(args, gold, i + 1));
  const r0 = runs[0];
  const n = r0.n;
  const operator_total = runs.reduce((s, r) => s + r.operator.length, 0);

  // 반복 평균과 편차
  const accs = runs.map((r) => (r.n ? r.correct / r.n : 0.0));
  const mean_k = py_round(runs.reduce((s, r) => s + r.correct, 0) / repeat);
  const safety_n = r0.safety_n;
  const mean_safe_k = py_round(runs.reduce((s, r) => s + r.safety_hit, 0) / repeat);
  const safe_rates = runs.filter((r) => r.safety_n).map((r) => r.safety_hit / r.safety_n);
  let stable: number | null = null;
  if (repeat > 1) {
    const same = [...r0.pred.keys()].filter((t) => new Set(runs.map((r) => r.pred.get(t))).size === 1).length;
    stable = r0.pred.size ? same / r0.pred.size : null;
  }

  const labels = Object.keys(config.LABELS);
  const confusion = new Map<string, number>();
  const cget = (y: string, p: string): number => confusion.get(`${y}\u0000${p}`) ?? 0;
  for (const [f, y] of r0.expected) {
    const k = `${y}\u0000${r0.got.get(f)?.label || "-"}`;
    confusion.set(k, (confusion.get(k) ?? 0) + 1);
  }
  const rows: [string, number, number, number][] = [];
  for (const lb of labels) {
    const tp = cget(lb, lb);
    let support = 0, predicted = 0;
    for (const [k, c] of confusion) {
      const [y, p] = k.split("\u0000");
      if (y === lb) support += c;
      if (p === lb) predicted += c;
    }
    if (support === 0 && predicted === 0) continue;
    rows.push([lb, support, predicted ? tp / predicted : 0.0, support ? tp / support : 0.0]);
  }
  const wrong: [string, string, string][] = [];
  for (const [f, y] of r0.expected) {
    if (r0.got.get(f)?.label !== y) wrong.push([r0.texts.get(f)!, y, r0.got.get(f)?.label || "-"]);
  }

  let cost_line = "";
  if (runs.some((r) => r.tok.calls)) {
    const [pin, pout, pcache] = config.PRICE_PER_MTOK[config.MODEL] ?? [0, 0, 0];
    const calls = runs.reduce((s, r) => s + r.tok.calls, 0);
    const tin = runs.reduce((s, r) => s + r.tok.i, 0), tout = runs.reduce((s, r) => s + r.tok.o, 0), tcache = runs.reduce((s, r) => s + r.tok.c, 0);
    const usd = (tin * pin + tout * pout + tcache * pcache) / 1_000_000;
    cost_line = `모델 호출 ${calls}회(${repeat}회 반복 합) · 입력 ${comma(tin)} · 출력 ${comma(tout)} · ` +
      `캐시읽기 ${comma(tcache)} 토큰 · 약 $${fixed(usd, 4)} ` +
      `(평가 1건당 $${fixed(usd / (n * repeat), 5)}, ${config.MODEL} 단가 기준)`;
  }

  let kappa: number | null = null, agree: number | null = null;
  if (lab && lab.a.length) {
    kappa = cohen_kappa(lab.a, lab.b);
    agree = 1 - lab.disagree / lab.a.length;
  }
  const kap = kappa === null ? "-" : fixed(kappa, 2);

  // ── 출력 ──
  const tag = repeat > 1 ? "평균" : "";
  console.log(`\n정확도${tag} ${mean_k}/${n} = ${pct(mean_k / n)}   Wilson 95% CI ${ci_text(mean_k, n)}   ` +
    `(미처리 ${r0.unfinished}건, 확인 필요 ${r0.held}건, 1회 ${fixed(r0.elapsed, 0)}초)`);
  if (repeat > 1) {
    const sd = stdev(accs);
    console.log(`  반복별 ${accs.map(pct).join(", ")} · 편차 sd ${fixed(sd * 100, 1)}%p · 범위 ${pct(Math.min(...accs))}~${pct(Math.max(...accs))}`);
    if (stable !== null) console.log(`  예측 안정도(반복해도 같은 답) ${pct(stable)}`);
  }
  if (r0.held) console.log(`  ※ 확인 필요 ${r0.held}건은 유형을 정하지 않아 오답으로 셉니다`);
  if (operator_total) console.log("  ※ 운영자가 처리한 건은 정확도에서 뺐습니다 (모델 정답이 아님)");
  console.log(`안전 재현율${tag} ${mean_safe_k}/${safety_n}` +
    (safety_n ? ` = ${pct(mean_safe_k / safety_n)}   Wilson 95% CI ${ci_text(mean_safe_k, safety_n)}` : ""));
  if (repeat > 1 && safe_rates.length) console.log(`  반복별 ${safe_rates.map(pct).join(", ")}`);
  if (lab) {
    if (kappa === null && !lab.a.length) {
      console.log("라벨러 간 일치: 2인 라벨(label_a·label_b)이 유효한 행이 없어 계산하지 못했습니다.");
    } else {
      console.log(`라벨러 간 일치 ${pct(agree!)} (${lab.a.length}행 중 불일치 ${lab.disagree}건) · ` +
        `Cohen's κ = ${kap} (${kappa_word(kappa)})`);
      if (kappa !== null && kappa < 0.6) {
        console.log("  ※ κ 가 0.6 미만이면 유형 정의부터 다시 맞춘 뒤 라벨링해야 합니다 (제출_준비/라벨링_가이드.md)");
      }
    }
  }
  for (const [lb, s, p, r] of rows) {
    console.log(`  ${lb.padEnd(9)} n=${String(s).padStart(3)}  정밀도 ${pct(p).padStart(5)}  재현율 ${pct(r).padStart(5)}`);
  }
  if (cost_line) console.log(cost_line);
  for (const [t, y, p] of wrong.slice(0, 15)) console.log(`  ✗ [${y}→${p}] ${t}`);
  if (!args.labels) console.log("  ※ 합성 시드 기준 참고값입니다. 실제 평가셋(--labels)으로 다시 재야 합니다.");

  if (args.no_report) return 0;

  const cols = [...labels, "-"];
  const head = "| 정답＼예측 | " + cols.join(" | ") + " |";
  const sep = "|" + "---|".repeat(labels.length + 2);
  const mat = labels.filter((y) => cols.some((p) => cget(y, p)))
    .map((y) => `| **${y}** | ` + cols.map((p) => String(cget(y, p) || "")).join(" | ") + " |");
  const [lo, hi] = wilson(mean_k, n);
  const [slo, shi] = wilson(mean_safe_k, safety_n);
  const model_name = args.backend === "local" ? "규칙 기반 대역" : config.MODEL;
  const key = !args.labels ? args.backend : `${args.backend} · 평가셋`;
  const section = [
    `## ${key}`,
    "",
    `측정 ${ymd_hm(new Date())} · ${source} · 고유 문장 ${n}건 · 반복 ${repeat}회 · 모델 \`${model_name}\`` +
      (args.backend === "claude_code" ? " (Claude Code CLI 경유 — 참고값, 최종값은 anthropic)" : ""),
    ...(args.labels ? [] : ["", "> 합성 시드 기준 **참고값**입니다. 실제 평가셋으로 다시 재야 합니다."]),
    "",
    `- **정확도${tag} ${pct(mean_k / n)}** (${mean_k}/${n}) · Wilson 95% CI [${pct(lo)}, ${pct(hi)}] · 미처리 ${r0.unfinished}건 · 1회 ${fixed(r0.elapsed, 0)}초`,
    ...(repeat > 1 ? [`- 반복별 ${accs.map(pct).join(", ")} · 편차 sd ${fixed(stdev(accs) * 100, 1)}%p · ` +
      `범위 ${pct(Math.min(...accs))}~${pct(Math.max(...accs))}`] : []),
    ...(stable !== null ? [`- 예측 안정도(반복해도 같은 답) ${pct(stable)}`] : []),
    `- 안전 재현율${tag} ${mean_safe_k}/${safety_n}` +
      (safety_n ? ` = ${pct(mean_safe_k / safety_n)} · Wilson 95% CI [${pct(slo)}, ${pct(shi)}]` : "") +
      " (라벨 safety 이거나 is_safety=true)",
    ...(lab && lab.a.length ? [`- 라벨러 간 일치 ${pct(agree!)} · Cohen's κ = ${kap} (${kappa_word(kappa)})`] : []),
    ...(cost_line ? [`- ${cost_line}`] : []),
    "",
    "| 라벨 | 건수 | 정밀도 | 재현율 |",
    "|---|---|---|---|",
    ...rows.map(([lb, s, p, r]) => `| ${lb} | ${s} | ${pct(p)} | ${pct(r)} |`),
    "",
    "혼동 행렬 (첫 반복)",
    "",
    head, sep, ...mat,
    "",
    `오분류 ${wrong.length}건` + (wrong.length > 20 ? " (상위 20)" : ""),
    "",
    ...wrong.slice(0, 20).map(([t, y, p]) => `- \`${y}\`→\`${p}\` ${t}`),
    "",
  ].join("\n");

  const header = "# 분류 정확도 리포트\n\n" +
    "`node server/scripts/measure_accuracy.ts --backend <local|anthropic|claude_code> [--labels 평가셋.csv --repeat 3]` 로 생성.\n" +
    "정답은 시드의 `_label_hint`(합성·참고값) 또는 평가셋의 `label_final`(사람이 합의한 라벨). 같은 문장은 1번만 센다.\n" +
    "정확도·안전 재현율에는 Wilson 95% 신뢰구간을 함께 적는다 — 건수가 적으면 구간이 넓다.\n\n";
  const old = exists(REPORT) ? read_text(REPORT) : header;
  // re.split(r"(?m)^(?=## )", old) — 줄 맨 앞의 '## ' 앞에서 자른다 (맨 처음 위치에서도 잘라 빈 조각을 만든다)
  const cuts = [...old.matchAll(/^(?=## )/gm)].map((m) => m.index!);
  const parts: string[] = [];
  let prev = 0;
  for (const c of cuts) { parts.push(old.slice(prev, c)); prev = c; }
  parts.push(old.slice(prev));
  const body = new Map<string, string>();
  for (const p of parts.slice(1)) body.set(p.split("\n")[0].slice(3).trim(), p);
  body.set(key, section + "\n");
  const known = ["local", "claude_code", "anthropic"].filter((b) => body.has(b));
  const order = [...known, ...[...body.keys()].filter((k) => !known.includes(k))];
  write_text(REPORT, parts[0] + order.map((b) => body.get(b)).join(""));
  console.log(`\n→ ${REPORT}`);
  return 0;
}

if (import.meta.main) {
  const code = await main();
  await db.close_all();
  process.exit(code);
}
