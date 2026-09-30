// 대량 데이터 속도 점검 (D5-37) — 민원 1,000건 · 조치할 일 카드 30장 규모의 복사본 DB 에서 관제 화면 속도를 잰다.
//   node tests/ui/perf_check.mjs [민원수=1000] [카드수=30]      (festival_agent 폴더에서)
// 자기만의 webapi(big DB 복사본)·vite·크롬을 빈 포트에 띄우고 끝나면 모두 끈다. 운영 DB 는 읽기만 한다.
// 출력: ✓ 통과 · ✗ 실패 + 측정값(ms). 예산을 넘으면 실패. 측정표는 표준출력 끝에 '측정' 줄로도 남긴다.
import { quitChrome } from "./chrome_util.mjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..", "..");
const WEB = join(APP, "web");
const VITE = join(WEB, "node_modules", "vite", "bin", "vite.js");
const PY = process.env.PYTHON ?? "python";
const SLOW = Math.max(1, Number(process.env.UI_SLOW) || 1);
const N = Number(process.argv[2] ?? 1000), M = Number(process.argv[3] ?? 30);

// 예산(ms) — 기계가 바쁘면(UI_SLOW) 같은 배율로 늘린다. 체감 기준: 0.2초 안이면 즉시, 1초 안이면 끊김 없음.
const BUDGET = { controlMedian: 150, controlMax: 600, firstDraw: 2500, redrawWork: 400, feedToScreen: 4000 };

let failed = 0, passed = 0;
const ok = (n, d = "") => { passed++; console.log(`✓ ${n}${d ? "  — " + d : ""}`); };
const bad = (n, d = "") => { failed++; console.log(`✗ ${n}${d ? "  — " + d : ""}`); };
const check = (n, c, d = "") => (c ? ok(n, d) : bad(n, d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000, step = 100) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms * SLOW) { const v = await fn().catch(() => null); if (v) return v; await sleep(step); }
  return null;
};
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const r1 = (x) => Math.round(x * 10) / 10;

const tmp = mkdtempSync(join(tmpdir(), "ui-suite-perf-"));
const kids = [];
const killTree = (c) => { try { if (c?.pid) spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* */ } };
let chrome, ws;
async function cleanup() {
  try { await quitChrome(chrome, ws); } catch { /* */ }
  for (const k of kids) killTree(k);
  await sleep(1500);
  for (let i = 0; i < 6; i++) { try { rmSync(tmp, { recursive: true, force: true }); break; } catch { await sleep(1000); } }
}
process.on("uncaughtException", async (e) => { bad("점검 중 예외", String(e?.stack ?? e).split("\n").slice(0, 3).join(" / ")); await cleanup(); process.exit(1); });
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

// ── 서버 ────────────────────────────────────────────────────────
const DB = join(tmp, "big.db");
const mk = spawnSync(PY, [join(HERE, "make_big_db.py"), DB, String(N), String(M)], { cwd: APP, encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
if (mk.status !== 0) { bad("준비: 큰 DB 복사본 만들기", (mk.stderr || mk.stdout || "").trim().split("\n").pop()); await cleanup(); process.exit(1); }
const apiPort = await freePort();
const CODE = "perf-" + Math.random().toString(36).slice(2);
const apiEnv = { ...process.env, DB_PATH: DB, PYTHONIOENCODING: "utf-8", LLM_BACKEND: "local", SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", ADMIN_CODE: CODE };
const api = spawn(PY, ["webapi.py", "--port", String(apiPort)], { cwd: APP, env: apiEnv, stdio: "ignore" }); kids.push(api);
const A = `http://127.0.0.1:${apiPort}`;
if (!(await until(async () => (await fetch(`${A}/api/control`)).ok, 25000, 300))) { bad("준비: webapi 가 안 뜸"); await cleanup(); process.exit(1); }
const vitePort = await freePort();
const vite = spawn(process.execPath, [VITE, "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB, env: { ...process.env, WEBAPI_PORT: String(apiPort) }, stdio: "ignore" }); kids.push(vite);
const base = `http://127.0.0.1:${vitePort}`;
if (!(await until(async () => (await fetch(`${base}/api/control`)).ok, 30000, 300))) { bad("준비: vite 가 안 뜸"); await cleanup(); process.exit(1); }

const c0 = (await (await fetch(`${A}/api/control`)).json()).data;
check(`준비: 민원 ${N}건 이상 · 카드 ${M}장 규모`, c0.total >= N && (c0.issues?.length ?? 0) >= M, `total ${c0.total} · 카드 ${c0.issues?.length}`);

// ① /api/control 응답 시간 (서버 직접, 순차 30회 — 첫 회는 워밍업이라 뺀다)
const ms = [];
let bytes = 0;
for (let i = 0; i < 31; i++) {
  const t = performance.now();
  const r = await fetch(`${A}/api/control`); const txt = await r.text();
  if (i > 0) ms.push(performance.now() - t);
  bytes = txt.length;
}
const cm = median(ms), cx = Math.max(...ms);
ok(`측정 /api/control: 중앙값 ${r1(cm)}ms · 최대 ${r1(cx)}ms · 응답 ${Math.round(bytes / 1024)}KB`);
check("/api/control 중앙값", cm <= BUDGET.controlMedian * SLOW, `${r1(cm)}ms (예산 ${BUDGET.controlMedian * SLOW})`);
check("/api/control 최대", cx <= BUDGET.controlMax * SLOW, `${r1(cx)}ms (예산 ${BUDGET.controlMax * SLOW})`);
// 관제 화면을 여러 대가 켜 둔 상황: SSE 30개를 붙인 채로 다시 잰다 (연결마다 1초에 한 번 DB 를 훑으면 응답이 느려진다 — webapi 는 그 조회를 공유한다)
const acs = [];
for (let i = 0; i < 30; i++) { const ac = new AbortController(); acs.push(ac); fetch(`${A}/api/events`, { signal: ac.signal }).then(async (r) => { for await (const _ of r.body) { /* 받기만 */ } }).catch(() => {}); }
await sleep(2500);
const ms30 = [];
for (let i = 0; i < 21; i++) { const t = performance.now(); await (await fetch(`${A}/api/control`)).text(); if (i > 0) ms30.push(performance.now() - t); }
const cm30 = median(ms30);
ok(`측정 /api/control (SSE 30개 연결 중): 중앙값 ${r1(cm30)}ms · 최대 ${r1(Math.max(...ms30))}ms`);
check("SSE 30개 연결 중 /api/control 중앙값", cm30 <= BUDGET.controlMedian * 2 * SLOW, `${r1(cm30)}ms (예산 ${BUDGET.controlMedian * 2 * SLOW})`);
for (const ac of acs) ac.abort();
// 나머지 읽기도 같이 (조치 화면)
const ta = performance.now(); await (await fetch(`${A}/api/action`)).text();
ok(`측정 /api/action: ${r1(performance.now() - ta)}ms`);

// ── 크롬 ────────────────────────────────────────────────────────
const cport = 11400 + Math.floor(Math.random() * 400);
chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run",
  `--user-data-dir=${join(tmp, "chrome")}`, `--remote-debugging-port=${cport}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cport}/json`)).json(); break; } catch { await sleep(200); } }
ws = new WebSocket(targets.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const n = ++seq; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
await send("Performance.enable");
const metrics = async () => Object.fromEntries(((await send("Performance.getMetrics"))?.metrics ?? []).map((m) => [m.name, m.value]));
const busyOf = (a, b) => ((b.ScriptDuration - a.ScriptDuration) + (b.LayoutDuration - a.LayoutDuration) + (b.RecalcStyleDuration - a.RecalcStyleDuration)) * 1000;

// ② 관제 첫 그리기: 주소를 연 뒤 카드가 화면에 나올 때까지
await send("Page.navigate", { url: "about:blank" });
await sleep(300);
const m0 = await metrics();
const t0 = performance.now();
await send("Page.navigate", { url: `${base}/#control` });
const drawn = await until(() => ev(`document.querySelectorAll("#app .icard, #app details[data-grp], #app .hero-main").length > 0 && document.getElementById("app").innerText.length > 500`), 20000, 50);
const firstDraw = performance.now() - t0;
const nodes = await ev(`document.getElementById("app").getElementsByTagName("*").length`);
ok(`측정 관제 첫 그리기: ${Math.round(firstDraw)}ms · 화면 요소 ${nodes}개`);
check("관제 첫 그리기에 카드가 나옴", !!drawn);
check("관제 첫 그리기 시간", firstDraw <= BUDGET.firstDraw * SLOW, `${Math.round(firstDraw)}ms (예산 ${BUDGET.firstDraw * SLOW})`);
await sleep(800);

// ③ SSE 로 한 번 다시 그리기: 민원 1건을 지워 변화를 일으키고, 화면에 반영될 때까지(서버 감지 1초 + 0.5초 모음 포함) + 그동안 브라우저가 일한 시간
const total0 = (await (await fetch(`${A}/api/control`)).json()).data;
const victim = total0.feed[0].id;
const mA = await metrics();
const tc = performance.now();
const del = await fetch(`${A}/api/rpc/delete_feedback`, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Code": CODE }, body: JSON.stringify({ p_id: victim }) });
const reflected = await until(() => ev(`document.getElementById("app").innerText.includes("누적 ${total0.total - 1}")`), 15000, 50);
const feedToScreen = performance.now() - tc;
await sleep(600);
const mB = await metrics();
const work = busyOf(mA, mB);
ok(`측정 변경→화면 반영: ${Math.round(feedToScreen)}ms · 그동안 브라우저 작업(스크립트+레이아웃+스타일) ${Math.round(work)}ms`);
check("변경이 화면에 반영됨", del.ok && !!reflected);
check("변경→화면 반영 시간", feedToScreen <= BUDGET.feedToScreen * SLOW, `${Math.round(feedToScreen)}ms (예산 ${BUDGET.feedToScreen * SLOW})`);
check("다시 그리기 때 브라우저 작업 시간", work <= BUDGET.redrawWork * SLOW, `${Math.round(work)}ms (예산 ${BUDGET.redrawWork * SLOW})`);
void m0;

console.log(`\n통과 ${passed} · 실패 ${failed}`);
await cleanup();
process.exit(failed ? 1 : 0);
