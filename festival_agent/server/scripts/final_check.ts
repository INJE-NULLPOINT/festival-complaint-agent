// 제출 직전 회귀 검사 (D8) — 한 번에 돌리고 한 장의 표로 남긴다. (scripts/final_check.py 와 1:1, 서버 시험은 TypeScript 로)
//
// 순서
//   1. 단위 테스트            node --test server/tests/*.test.ts
//   2. 시나리오 5종           server/tests/scenarios.test.ts  (구조 모드, LLM 호출 없음)
//   3. 타입 검사              tsc — web · server · tests/ui 세 곳 (각자의 tsconfig.json)
//   4. 화면·서버 전체 점검    tests/ui/run_all.ts — 방문객·관리자·연결 끊김·대량 데이터 속도·보안·모바일 5폭,
//                             그리고 빌드 + 빌드본 최신 문법 0 + JS 실패 안내 + 빌드본 화면 (별도 포트·DB 복사본·임시 dist; web/dist 는 안 건드림)
//   5. 제외 확인 (D8-3)       git ls-files 에 .env · *.db · output/ · node_modules · 실제 키가 없어야 한다
//
// 안전
//   - 운영 DB(festival.db)는 쓰지 않는다. 시험들은 저마다 복사본으로 돈다 (run_all 은 자체 포트·임시 폴더).
//   - claude_code/anthropic 실측은 하지 않는다: LLM_BACKEND=local 로 고정. API 키·SUPABASE_DB_URL 은 자식 프로세스 환경에서 비운다.
//   - 시험이 덮어쓰는 제출용 기록(testcase_report.md)은 실행 전 내용을 저장했다가 끝에 되돌린다. 이번 실행 결과는 tests/final_check.md 에만 남는다.
//   - 키 검사 결과에는 파일 경로와 줄 번호만 적고, 키 값은 출력하지 않는다.
//
// 실행
//     node server/scripts/final_check.ts                 전체
//     node server/scripts/final_check.ts --skip=ui       화면 점검 빼고
//     node server/scripts/final_check.ts --only=exclude  제외 확인만
// 종료 코드: 0 전부 통과 · 1 실패 있음
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..", "..");          // festival_agent
const WEB = path.join(ROOT, "web");
const REPORT = path.join(ROOT, "tests", "final_check.md");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const NODE = process.execPath;

// 시험이 덮어쓰는 기록 — 끝에 되돌린다
const PRESERVE = [path.join(ROOT, "tests", "testcase_report.md")];
const KEY_ENV = ["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SUPABASE_KEY"];

// 시험이 만드는 조치요청서 DOCX 는 운영 output/ 이 아니라 이 임시 폴더로 간다 (D5-74)
const DOCS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "festival_final_docs_"));

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!KEY_ENV.includes(k)) env[k] = v;
  Object.assign(env, { LLM_BACKEND: "local", SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" });
  env.DOCS_DIR = DOCS_TMP;
  delete env.DB_PATH;          // 운영 DB 경로를 물려주지 않는다 (시험이 각자 복사본을 만든다)
  return env;
}

function run(cmd: string[], cwd: string, timeoutSec: number): [number, string] {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, env: childEnv(), encoding: "utf-8", timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" && cmd[0].endsWith(".cmd") });
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    if (e.code === "ETIMEDOUT") return [124, `${r.stdout ?? ""}${r.stderr ?? ""}\n(시간 초과 ${timeoutSec}초)`];
    return [127, `실행 파일을 찾지 못함: ${e.message}`];
  }
  return [r.status ?? 1, `${r.stdout ?? ""}${r.stderr ?? ""}`];
}

function last(out: string, n = 1): string {
  const lines = out.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.slice(-n).join(" / ") : "(출력 없음)";
}
function findLast(out: string, re: RegExp): RegExpExecArray | null {
  const all = [...out.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
  return all.length ? all[all.length - 1] : null;
}

type StepResult = [boolean, string];

/** node --test 요약(ℹ tests N / pass N / fail N) 읽기 */
function nodeTestSummary(out: string): { tests: number; pass: number; fail: number } | null {
  const g = (k: string) => { const m = findLast(out, new RegExp(`ℹ ${k} (\\d+)`)); return m ? Number(m[1]) : null; };
  const tests = g("tests"), pass = g("pass"), fail = g("fail");
  return tests === null || pass === null || fail === null ? null : { tests, pass, fail };
}

function step_unit(): StepResult {
  const [rc, out] = run([NODE, "--test", "server/tests/*.test.ts"], ROOT, 600);
  const s = nodeTestSummary(out);
  if (rc === 0 && s) return [true, `${s.pass}/${s.tests}개 통과`];
  return [false, s ? `${s.fail}개 실패 · ${s.pass}/${s.tests} 통과` : last(out, 2)];
}

function step_scenarios(): StepResult {
  const [rc, out] = run([NODE, "--test", "server/tests/scenarios.test.ts"], ROOT, 600);
  const s = nodeTestSummary(out);
  return [rc === 0 && !!s && s.fail === 0, s ? `${s.pass}/${s.tests} 통과 · 구조 모드` : last(out)];
}

function step_tsc(): StepResult {
  // 세 곳을 모두 검사한다: 웹(web/tsconfig.json) · 서버(server/tsconfig.json) · 시험 도구(tests/ui/tsconfig.json). tsc 는 웹의 것을 같이 쓴다.
  const targets: [string, string[]][] = [["web", ["tsc", "--noEmit"]], ["server", ["tsc", "-p", "../server"]], ["tests/ui", ["tsc", "-p", "../tests/ui"]]];
  const parts: string[] = [];
  let ok = true;
  for (const [name, args] of targets) {
    const [rc, out] = run([NPX, ...args], WEB, 300);
    const n = (out.match(/error TS\d+/g) ?? []).length;
    parts.push(rc === 0 ? `${name} 0` : `${name} ${n || "?"}건`);
    if (rc !== 0) { ok = false; parts.push(last(out, 2)); }
  }
  return [ok, `오류: ${parts.join(" · ")}`];
}

function step_ui(): StepResult {
  const [rc, out] = run([NODE, "tests/ui/run_all.ts"], ROOT, 1800);
  const m = findLast(out, /결과: (.+?) →/);
  return [rc === 0, m ? m[1] : last(out, 2)];
}

function step_exclude(): StepResult {
  let [rc, top] = run(["git", "rev-parse", "--show-toplevel"], ROOT, 120);
  if (rc !== 0) return [false, "git 저장소가 아님: " + last(top)];
  top = top.trim();
  const ls = spawnSync("git", ["ls-files", "-z"], { cwd: top, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });     // 저장소 맨 위에서: 경로가 전부 top 기준이 된다
  if (ls.status !== 0) return [false, "git ls-files 실패: " + last(String(ls.stderr))];
  const files = String(ls.stdout).split("\0").filter(Boolean);
  const bad: string[] = [];
  for (const f of files) {
    const parts = f.split("/");
    const name = parts[parts.length - 1];
    const dirs = parts.slice(0, -1);
    if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) bad.push(`${f} (환경 파일)`);
    else if (/\.db(-wal|-shm)?$/.test(name)) bad.push(`${f} (DB 파일)`);
    else if (dirs.includes("output")) bad.push(`${f} (output/)`);
    else if (dirs.includes("node_modules")) bad.push(`${f} (node_modules)`);
  }
  // 키 패턴: 내용에서 찾는다. 값은 적지 않고 경로:줄 만 남긴다.
  const ant = /sk-ant-[A-Za-z0-9_-]{20,}/;
  const jwt = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;
  let scanned = 0;
  for (const f of files) {
    const p = path.join(top, f);
    let data: Buffer;
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 5_000_000) continue;
      data = fs.readFileSync(p);
    } catch { continue; }
    if (data.subarray(0, 2048).includes(0)) continue;          // 이진 파일
    scanned++;
    const lines = data.toString("latin1").split("\n");
    lines.forEach((line, i) => {
      if (ant.test(line)) bad.push(`${f}:${i + 1} (sk-ant- 키 형태)`);
      for (const m of line.matchAll(jwt)) {
        let role: unknown = null;
        try { role = JSON.parse(Buffer.from(m[1], "base64url").toString("utf-8")).role; } catch { /* 해석 못 하면 키가 아니다 */ }
        if (role === "service_role") bad.push(`${f}:${i + 1} (service_role JWT)`);
      }
    });
  }
  if (bad.length) return [false, `${bad.length}건: ${bad.slice(0, 8).join("; ")}${bad.length > 8 ? " …" : ""}`];
  return [true, `추적 파일 ${files.length}개 · 내용 검사 ${scanned}개 — .env·*.db·output/·node_modules·실제 키 없음`];
}

const STEPS: [string, () => string, () => StepResult][] = [
  ["unit", () => "단위 테스트 (node --test server/tests)", step_unit],
  ["scenarios", () => "시나리오 5종 (구조 모드)", step_scenarios],
  ["tsc", () => "타입 검사 (tsc: web · server · tests/ui)", step_tsc],
  ["ui", () => "화면·서버 전체 점검 (run_all: 방문객·관리자·연결 끊김·속도·보안·모바일·빌드본 문법 0·JS 실패 안내)", step_ui],
  ["exclude", () => "제외 확인 (D8-3)", step_exclude],
];

function main(): number {
  const { values: v } = parseArgs({ options: { only: { type: "string", default: "" }, skip: { type: "string", default: "" } } });
  const only = new Set((v.only as string).split(",").filter(Boolean));
  const skip = new Set((v.skip as string).split(",").filter(Boolean));
  const known = new Set(STEPS.map((s) => s[0]));
  const unknown = [...only, ...skip].filter((k) => !known.has(k));
  if (unknown.length) { console.error("알 수 없는 단계:", unknown.sort().join(", ")); return 2; }

  const saved = new Map<string, Buffer>();
  for (const p of PRESERVE) if (fs.existsSync(p)) saved.set(p, fs.readFileSync(p));
  const rows: [string, string, string, string][] = [];
  const t_all = Date.now();
  try {
    for (const [key, title, fn] of STEPS) {
      const t = title();
      if ((only.size && !only.has(key)) || skip.has(key)) { rows.push([t, "건너뜀", "-", "선택에서 제외"]); continue; }
      console.log(`[final_check] ${t} …`);
      const t0 = Date.now();
      let ok: boolean, note: string;
      try { [ok, note] = fn(); } catch (e) { ok = false; note = `검사 중 예외: ${(e as Error).name}: ${(e as Error).message}`; }   // 한 단계가 터져도 나머지는 계속
      const sec = (Date.now() - t0) / 1000;
      rows.push([t, ok ? "통과" : "실패", `${sec.toFixed(0)}초`, note]);
      console.log(`[final_check]   → ${ok ? "통과" : "실패"} (${sec.toFixed(0)}초) ${note}`);
    }
  } finally {
    for (const [p, b] of saved) { try { fs.writeFileSync(p, b); } catch { /* */ } }
  }

  const fails = rows.filter((r) => r[1] === "실패");
  const ran = rows.filter((r) => r[1] !== "건너뜀");
  const head = !fails.length && ran.length ? "**전부 통과**" : fails.length ? `**실패 ${fails.length}건**` : "실행한 단계 없음";
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const md = [
    "# 제출 직전 회귀 검사 (D8)", "",
    `- 수행 ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} · 총 ${((Date.now() - t_all) / 1000).toFixed(0)}초 · 결과 ${head}`,
    `- 모드: LLM_BACKEND=local (claude_code·API 실측 없음) · 운영 DB 미사용 (시험별 복사본·별도 포트) · 서버 TypeScript`,
    "- 제출용 기록(testcase_report.md)은 실행 전 내용으로 되돌림 (화면 점검 상세는 tests/ui/report.md)", "",
    "| # | 항목 | 결과 | 시간 | 내용 |", "|---|---|---|---|---|",
  ];
  const mark: Record<string, string> = { 통과: "✅ 통과", 실패: "❌ 실패", 건너뜀: "○ 건너뜀" };
  rows.forEach(([title, verdict, sec, note], i) => md.push(`| ${i + 1} | ${title} | ${mark[verdict]} | ${sec} | ${note.replace(/\|/g, "/")} |`));
  md.push("");
  fs.writeFileSync(REPORT, md.join("\n"), "utf-8");
  console.log(`\n[final_check] ${head} → ${REPORT}`);
  return fails.length ? 1 : 0;
}

process.exit(main());
