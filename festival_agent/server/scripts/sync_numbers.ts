// 문서 안의 숫자를 실제 측정 리포트에서 읽어 한 번에 갱신한다 (D5-70).
//
//   node server/scripts/sync_numbers.ts               원천 리포트 → 문서 표식 값 갱신
//   node server/scripts/sync_numbers.ts --dry-run     바뀔 목록만 보여 주고 파일은 쓰지 않는다
//   node server/scripts/sync_numbers.ts --list-keys   읽은 값(키·값·원천)을 표로 보여 준다
//   node server/scripts/sync_numbers.ts --strict      실제 API(anthropic) 측정만 인정한다 (제출 직전 용)
//   옵션: --file <문서> (여러 번 가능, 대상 문서를 직접 지정) · --cost <원가 리포트 경로>
//
// 표식 규칙 (문서에 넣는 쪽)
//   <!--n:키-->값<!--/n-->          한 줄 안에서, 값은 줄바꿈 없이. 값 자리만 바뀌고 표식 밖은 절대 건드리지 않는다.
//   값에는 단위가 이미 들어 있다 ("87.5%", "2.14초", "$0.00123", "74/75") — 표식 뒤에 단위를 또 쓰지 말 것.
//   예)  정확도 <!--n:accuracy-->87.5%<!--/n--> (95% 신뢰구간 <!--n:accuracy_ci-->[72%, 95%]<!--/n-->)
//
// 원천 (값을 지어내지 않는다 — 원천에 없으면 그 표식은 그대로 두고 경고만 한다)
//   tests/accuracy_report.md        정확도   (anthropic > claude_code > local 순, 같은 백엔드면 '평가셋' 절 우선)
//   tests/testcase_report.md        시나리오 5종
//   server/tests/latency_report.md  동시 접수·지연 (local 대역 — 모델 호출 없음)
//   tests/wall_clock_report.md      접수→분류 벽시계 (실제 LLM 경로; `wall_clock.ts --report` 의 1건 접수 줄)
//   tests/final_check.md            단위·화면 회귀 검사
//   tests/sensitivity_report.md     가중치 민감도 (local 규칙 · 합성 시드 — 모델 호출 없음)
//   제출_준비/원가측정.md (없으면 원가측정_참고.md)   민원 1건 원가
//
// 키 (--list-keys 로 현재 값을 볼 수 있다)
//   accuracy  accuracy_ci  accuracy_n  safety_recall  backend  measured_at
//   tc_pass  tc_backend  tc_mode  tc_at
//   latency_median  latency_max  latency_feed_median  latency_feed_max  latency_sse_median  latency_sse_max
//   latency_ack_median  latency_ack_max  latency_n  latency_backend  latency_at
//   llm_latency_median  llm_latency_p90  llm_latency_max  llm_n(1건 접수 횟수)  llm_backend  llm_mode  llm_at   (접수→분류 벽시계, 1건 접수 기준)
//   sens_n  sens_hold  sens_safety_top  sens_count_not_immediate  sens_range  sens_min_safety_w  sens_at   (가중치 민감도)
//   unit_pass  ui_pass  ui_skip  check_backend  check_at
//   cost_per_item  cost_per_item_krw  cost_classify  cost_backend  cost_at
//   (backend·measured_at 은 정확도 측정의 백엔드·시각)
//
// 종료 코드: 0 정상(경고가 있어도) · 2 사용법/읽기 오류
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const SERVER = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(SERVER, "..");               // festival_agent/
const PROJECT = path.dirname(ROOT);                    // "ai 대회" 폴더

const read = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n?/g, "\n");

export interface Val { value: string; source: string }
export type Values = Map<string, Val>;
export interface Opts { strict: boolean; cost?: string; root?: string; project?: string }

// ── 원천 읽기 ────────────────────────────────────────────────────

/** `## 이름` 절로 나눈다 */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = text.split(/^(?=## )/m);
  for (const p of parts.slice(1)) out.set(p.split("\n", 1)[0].slice(3).trim(), p);
  return out;
}

/** 표의 행 중 첫 칸 이후 `항목` 칸이 prefix 로 시작하는 행의 칸 목록 */
function table_row(text: string, item_prefix: string): string[] | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length >= 5 && cells[1].startsWith(item_prefix)) return cells;
  }
  return null;
}

function accuracy(root: string, strict: boolean, out: Values): void {
  const p = path.join(root, "tests", "accuracy_report.md");
  if (!existsSync(p)) return;
  const secs = sections(read(p));
  const order = ["anthropic · 평가셋", "anthropic", ...(strict ? [] : ["claude_code · 평가셋", "claude_code", "local · 평가셋", "local"])];
  const key = order.find((k) => secs.has(k));
  if (!key) return;
  const s = secs.get(key)!;
  const src = `tests/accuracy_report.md ## ${key}`;
  const put = (k: string, v: string | undefined): void => { if (v) out.set(k, { value: v, source: src }); };
  const m = /^- \*\*정확도(?:평균)? ([\d.]+%)\*\* \((\d+\/\d+)\)(?: · Wilson 95% CI (\[[^\]]+\]))?/m.exec(s);
  put("accuracy", m?.[1]);
  put("accuracy_n", m?.[2]);
  put("accuracy_ci", m?.[3]);
  put("safety_recall", /^- 안전 재현율(?:평균)? (\d+\/\d+)/m.exec(s)?.[1]);
  put("backend", key.split(" ")[0]);
  put("measured_at", /^측정 (\d{4}-\d\d-\d\d \d\d:\d\d)/m.exec(s)?.[1]);
}

function testcase(root: string, strict: boolean, out: Values): void {
  const p = path.join(root, "tests", "testcase_report.md");
  if (!existsSync(p)) return;
  const t = read(p);
  const backend = /^- 백엔드: (\S+)/m.exec(t)?.[1];
  const mode = /^- 수행모드: (.+)$/m.exec(t)?.[1]?.trim() ?? "";
  const live = mode.includes("--live") && mode.includes("실제 LLM 호출");
  if (strict && !(live && backend === "anthropic")) return;      // 제출 기준은 API 실측만
  const src = "tests/testcase_report.md";
  const put = (k: string, v: string | undefined): void => { if (v) out.set(k, { value: v, source: src }); };
  put("tc_pass", /\*\*(\d+\/\d+) 통과\*\*/.exec(t)?.[1]);
  put("tc_backend", backend);
  put("tc_mode", live ? "실제 LLM 호출" : "구조 검증");
  put("tc_at", /^- 수행일시: (.+)$/m.exec(t)?.[1]?.trim());
}

function latency(root: string, out: Values): void {
  const p = path.join(root, "server", "tests", "latency_report.md");
  if (!existsSync(p)) return;
  const t = read(p);
  const src = "server/tests/latency_report.md";
  const put = (k: string, v: string | undefined): void => { if (v && !v.includes("측정 못함")) out.set(k, { value: v, source: src }); };
  const row = (label: string): string[] | null => {
    const m = new RegExp(`^\\| ${label}[^|]*\\| ([^|]+) \\| ([^|]+) \\|`, "m").exec(t);
    return m ? [m[1].trim(), m[2].trim()] : null;
  };
  for (const [label, pre] of [["접수 → 분류 완료", "latency"], ["접수 → 관제 유입", "latency_feed"], ["접수 → 화면에 알림", "latency_sse"], ["접수 응답", "latency_ack"]] as const) {
    const r = row(label);
    if (r) { put(`${pre}_median`, r[0]); put(`${pre}_max`, r[1]); }
  }
  put("latency_n", /방문객 (\d+)명이/.exec(t)?.[1]);
  put("latency_backend", /분류 백엔드 `(\w+)`/.exec(t)?.[1]);
  put("latency_at", /수행 (\d{4}-\d\d-\d\d \d\d:\d\d)/.exec(t)?.[1]);
}

/** tests/sensitivity_report.md — 가중치를 각각 ±N% 바꾼 조합 전부에서 결론이 유지됐는가. sensitivity.ts 가 쓴 형식 그대로 읽는다. */
function sensitivity(root: string, out: Values): void {
  const p = path.join(root, "tests", "sensitivity_report.md");
  if (!existsSync(p)) return;
  const t = read(p);
  const put = (k: string, v: string | undefined): void => { if (v) out.set(k, { value: v, source: "tests/sensitivity_report.md" }); };
  put("sens_n", /^- 조합 수: \*\*(\d+)\*\*/m.exec(t)?.[1]);
  put("sens_safety_top", /^- ① 심각도 1위가 안전: \*\*(\d+\/\d+)\*\*/m.exec(t)?.[1]);
  put("sens_count_not_immediate", /^- ② 건수 1위\([^)]*\)가 '즉시'가 아님: \*\*(\d+\/\d+)\*\*/m.exec(t)?.[1]);
  put("sens_hold", /^- ①②가 모두 유지된 조합: \*\*(\d+\/\d+)\*\*/m.exec(t)?.[1]);
  const r = /각각 [−-](\d+)% · 0 · \+(\d+)%/.exec(t);
  if (r && r[1] === r[2]) put("sens_range", `±${r[1]}%`);                 // 아래위 폭이 다르면 한 값으로 줄이지 않는다
  put("sens_min_safety_w", /안전이 1위로 남는 최저값: \*\*([\d.]+)\*\*/.exec(t)?.[1]);
  put("sens_at", /^- 수행 (\d{4}-\d\d-\d\d \d\d:\d\d)/m.exec(t)?.[1]);
}

/** tests/wall_clock_report.md — `wall_clock.ts --report` 의 '1건 접수: 중앙값 Xs · 최대 Ys' 줄. 동시 접수(--concurrent) 리포트에는 이 줄이 없어 읽지 않는다. */
function wall_clock(root: string, strict: boolean, out: Values): void {
  const p = path.join(root, "tests", "wall_clock_report.md");
  if (!existsSync(p)) return;
  const t = read(p);
  const backend = /백엔드 `(\w+)`/.exec(t)?.[1];
  if (strict && backend !== "anthropic") return;             // 제출 기준은 API 실측만
  const src = "tests/wall_clock_report.md";
  const put = (k: string, v: string | undefined): void => { if (v) out.set(k, { value: v, source: src }); };
  // '1건 접수: 중앙값 Xs · p90 Ys · 최대 Zs (N회 …)'
  const m = /\*\*1건 접수: 중앙값 ([\d.]+)s · p90 ([\d.]+)s · 최대 ([\d.]+)s\*\*(?: \((\d+)회)?/.exec(t);
  if (m) {
    put("llm_latency_median", `${m[1]}초`);
    put("llm_latency_p90", `${m[2]}초`);
    put("llm_latency_max", `${m[3]}초`);
    if (m[4]) put("llm_n", m[4]);
  }
  put("llm_backend", backend);
  put("llm_mode", /모드 `(\w+)`/.exec(t)?.[1]);
  put("llm_at", /^# 접수→분류 벽시계 측정 \((\d{4}-\d\d-\d\d \d\d:\d\d)\)/m.exec(t)?.[1]);
}

function final_check(root: string, out: Values): void {
  const p = path.join(root, "tests", "final_check.md");
  if (!existsSync(p)) return;
  const t = read(p);
  const src = "tests/final_check.md";
  const put = (k: string, v: string | undefined): void => { if (v) out.set(k, { value: v, source: src }); };
  put("unit_pass", table_row(t, "단위 테스트") ? /(\d+\/\d+)개 통과/.exec(table_row(t, "단위 테스트")![4])?.[1] : undefined);
  const ui = table_row(t, "화면·서버 전체 점검");
  if (ui) {
    put("ui_pass", /통과 (\d+)/.exec(ui[4])?.[1]);
    put("ui_skip", /건너뜀 (\d+)/.exec(ui[4])?.[1] ?? "0");
  }
  put("check_backend", /LLM_BACKEND=(\w+)/.exec(t)?.[1]);
  put("check_at", /^- 수행 (\d{4}-\d\d-\d\d \d\d:\d\d)/m.exec(t)?.[1]);
}

function cost(project: string, strict: boolean, explicit: string | undefined, out: Values): void {
  const cands = explicit ? [explicit] : [path.join(project, "제출_준비", "원가측정.md"), path.join(project, "제출_준비", "원가측정_참고.md")];
  const p = cands.find((c) => existsSync(c));
  if (!p) return;
  const t = read(p);
  const reference = t.includes("참고값") || /참고\.md$/.test(p);
  if (strict && reference) return;
  const src = path.relative(project, p).replace(/\\/g, "/") + (reference ? " (참고값)" : "");
  const put = (k: string, v: string | undefined): void => { if (v) out.set(k, { value: v, source: src }); };
  const all = /^- \*\*전체 원가: 민원 1건당 (\$[\d.]+)\*\*(?: \(약 ([\d,.]+원)\))?/m.exec(t);
  put("cost_per_item", all?.[1]);
  put("cost_per_item_krw", all?.[2]);
  put("cost_classify", /^- \*\*분류 원가: 민원 1건당 (\$[\d.]+)\*\*/m.exec(t)?.[1]);
  put("cost_backend", reference ? "claude_code" : "anthropic");
  put("cost_at", /^측정 (\d{4}-\d\d-\d\d \d\d:\d\d)/m.exec(t)?.[1]);
}

export function collect(o: Opts): Values {
  const root = o.root ?? ROOT, project = o.project ?? PROJECT;
  const v: Values = new Map();
  accuracy(root, o.strict, v);
  testcase(root, o.strict, v);
  latency(root, v);
  wall_clock(root, o.strict, v);
  sensitivity(root, v);
  final_check(root, v);
  cost(project, o.strict, o.cost, v);
  return v;
}

// ── 문서 갱신 ────────────────────────────────────────────────────

const MARK = /<!--n:([A-Za-z0-9_]+)-->([^\n]*?)<!--\/n-->/g;

export interface Change { key: string; old: string; now: string }
export interface Result { file: string; changes: Change[]; same: number; unknown: string[]; text: string }

/** 문서 텍스트의 표식 값을 바꾼다. 표식 밖은 그대로(바이트 단위). */
export function apply(text: string, values: Values, file = ""): Result {
  const changes: Change[] = [];
  const unknown: string[] = [];
  let same = 0;
  const next = text.replace(MARK, (whole, key: string, old: string) => {
    const v = values.get(key);
    if (!v) { unknown.push(key); return whole; }
    if (v.value === old) { same += 1; return whole; }
    changes.push({ key, old, now: v.value });
    return `<!--n:${key}-->${v.value}<!--/n-->`;
  });
  return { file, changes, same, unknown, text: next };
}

function default_targets(root: string, project: string): string[] {
  const out: string[] = [];
  for (const p of [path.join(root, "README.md"), path.join(project, "README.md")]) if (existsSync(p)) out.push(p);
  const dirs = [path.join(project, "제출_준비"), path.join(root, "docs")];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d).sort()) if (n.endsWith(".md") && !/^원가측정/.test(n)) out.push(path.join(d, n));
  }
  return out;
}

function main(): number {
  const { values: a } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false }, "list-keys": { type: "boolean", default: false }, strict: { type: "boolean", default: false },
      file: { type: "string", multiple: true }, cost: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (a.help) { console.log("사용: node server/scripts/sync_numbers.ts [--dry-run] [--list-keys] [--strict] [--file 문서]… [--cost 원가리포트]"); return 0; }
  const values = collect({ strict: a.strict as boolean, cost: a.cost });

  if (a["list-keys"]) {
    if (!values.size) console.log("읽을 수 있는 원천 값이 없습니다.");
    const w = Math.max(...[...values.keys()].map((k) => k.length), 4);
    for (const [k, v] of [...values].sort((x, y) => (x[0] < y[0] ? -1 : 1))) console.log(`${k.padEnd(w)}  ${v.value.padEnd(16)}  ${v.source}`);
    return 0;
  }

  const files = (a.file as string[] | undefined)?.map((f) => path.resolve(f)) ?? default_targets(ROOT, PROJECT);
  let total = 0, changed = 0, same = 0, warns = 0;
  const missing = new Map<string, string[]>();
  for (const f of files) {
    if (!existsSync(f)) { console.error(`파일이 없습니다: ${f}`); return 2; }
    const raw = readFileSync(f, "utf-8");                 // 줄바꿈·BOM 을 그대로 두려고 변환하지 않는다
    const r = apply(raw, values, f);
    const n = r.changes.length + r.same + r.unknown.length;
    total += n; changed += r.changes.length; same += r.same;
    for (const k of r.unknown) { warns += 1; (missing.get(k) ?? missing.set(k, []).get(k)!).push(path.basename(f)); }
    if (!n) continue;
    const rel = path.relative(PROJECT, f).replace(/\\/g, "/");
    console.log(`${rel}  표식 ${n}개 · 바뀜 ${r.changes.length} · 같음 ${r.same}${r.unknown.length ? ` · 원천에 없음 ${r.unknown.length}` : ""}`);
    for (const c of r.changes) console.log(`   ${c.key}: ${c.old} → ${c.now}`);
    if (r.changes.length && !a["dry-run"]) writeFileSync(f, r.text, "utf-8");
  }
  for (const [k, fs_] of missing) console.log(`⚠ 원천에 없는 키 ${k} (${[...new Set(fs_)].join(", ")}) — 값을 바꾸지 않았습니다`);
  console.log(`${a["dry-run"] ? "[dry-run] " : ""}표식 ${total}개 · 바뀜 ${changed} · 같음 ${same} · 경고 ${warns}` +
    (a.strict ? " · --strict(API 실측만)" : ""));
  return 0;
}

if (import.meta.main) process.exit(main());
