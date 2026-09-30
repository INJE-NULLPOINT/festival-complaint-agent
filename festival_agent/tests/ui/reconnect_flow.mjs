// 연결 끊김 대응 점검 (D5-36) — 서버를 실제로 껐다 켠다.
//   node tests/ui/reconnect_flow.mjs            (festival_agent 폴더에서. 인자 없음)
// 이 스크립트가 **자기만의** webapi(운영 DB 복사본) + vite 를 빈 포트에 띄우고, 끝나면 모두 끈다.
// 그래서 다른 점검·다른 세션의 서버에는 영향이 없다. 출력: ✓ 통과 · ✗ 실패 · ○ 건너뜀. 실패가 있으면 종료 코드 1.
//
// 본 것:
//   관제 화면  연결되면 '실시간' → 서버를 끄면 '재연결 중' → 8초 넘게 안 붙으면 배너(서버에 연결할 수 없습니다 · 마지막 갱신 HH:MM)
//              → 서버를 켜면 저절로 '실시간'으로 돌아오고 배너가 사라지며, 그 사이 들어온 변화도 다시 그려진다.
//   방문객 화면 서버가 죽었을 때 접수하면 → 입력·구역이 그대로 남고 '다시 시도' 버튼이 뜬다 (성공 창 없음, 배너 없음)
//              → 서버를 켜고 '다시 시도' → 접수 완료 창이 뜨고 DB 에 1건 늘어난다.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));

let failed = 0, passed = 0, skipped = 0;
const ok = (n, d = "") => { passed++; console.log(`✓ ${n}${d ? "  — " + d : ""}`); };
const bad = (n, d = "") => { failed++; console.log(`✗ ${n}${d ? "  — " + d : ""}`); };
const check = (n, c, d = "") => (c ? ok(n, d) : bad(n, d));
const until = async (fn, ms = 6000, step = 200) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms * SLOW) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, step)); }
  return null;
};

const tmp = mkdtempSync(join(tmpdir(), "ui-suite-recon-"));
const kids = [];
const killTree = (c) => { try { if (c?.pid) spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* */ } };
let chrome, ws;
async function cleanup() {
  try { await quitChrome(chrome, ws); } catch { /* */ }
  for (const k of kids) killTree(k);
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 6; i++) { try { rmSync(tmp, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
}
process.on("uncaughtException", async (e) => { bad("점검 중 예외", String(e?.stack ?? e).split("\n").slice(0, 3).join(" / ")); await cleanup(); process.exit(1); });

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

// ── 서버 ────────────────────────────────────────────────────────
const DB = join(tmp, "recon.db");
const mk = spawnSync(PY, [join(HERE, "make_mobile_db.py"), DB], { cwd: APP, encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
if (mk.status !== 0) { bad("준비: DB 복사본 만들기", (mk.stderr || mk.stdout || "").trim().split("\n").pop()); await cleanup(); process.exit(1); }
const apiPort = await freePort();
const apiEnv = { ...process.env, DB_PATH: DB, PYTHONIOENCODING: "utf-8", LLM_BACKEND: "local", SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", ADMIN_CODE: "recon-" + Math.random().toString(36).slice(2) };
let api = null;
async function startApi() {
  api = spawn(PY, ["webapi.py", "--port", String(apiPort)], { cwd: APP, env: apiEnv, stdio: "ignore" });
  kids.push(api);
  return !!(await until(async () => (await fetch(`http://127.0.0.1:${apiPort}/api/control`)).ok, 25000, 300));
}
function stopApi() { killTree(api); api = null; }
const total = async () => (await (await fetch(`http://127.0.0.1:${apiPort}/api/control`)).json()).data.total;
// 방문객 접수는 feedback_inbox 로 들어가고 워커가 나중에 feedback 으로 옮긴다 (이 점검에는 워커가 없다) → 받은 건수는 DB 에서 직접 센다
const inbox = () => Number(spawnSync(PY, ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT COUNT(*) FROM feedback_inbox').fetchone()[0])", DB], { encoding: "utf-8" }).stdout.trim());

if (!(await startApi())) { bad("준비: webapi 가 안 뜸"); await cleanup(); process.exit(1); }
const vitePort = await freePort();
const vite = spawn(process.execPath, [VITE, "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB, env: { ...process.env, WEBAPI_PORT: String(apiPort) }, stdio: "ignore" });
kids.push(vite);
const base = `http://127.0.0.1:${vitePort}`;
if (!(await until(async () => (await fetch(`${base}/api/control`)).ok, 30000, 300))) { bad("준비: vite 가 안 뜸"); await cleanup(); process.exit(1); }

// ── 크롬 ────────────────────────────────────────────────────────
const cport = 10900 + Math.floor(Math.random() * 400);
chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run",
  `--user-data-dir=${join(tmp, "chrome")}`, `--remote-debugging-port=${cport}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cport}/json`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
ws = new WebSocket(targets.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const n = ++seq; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim().replace(/\\s+/g, " ") ?? ""`);
const visible = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`);
const open = async (url) => { await send("Page.navigate", { url }); await until(() => ev(`document.getElementById("app")?.children.length > 0`), 12000); await sleep(500); };

// ══ 관제 화면 ══════════════════════════════════════════════════════
await open(`${base}/#control`);
check("관제: 처음에 '실시간' 연결 표시", !!(await until(async () => (await text("#live")).startsWith("실시간"), 10000)), await text("#live"));
check("관제: 끊기기 전에는 배너가 없음", !(await visible("#conn-banner")));
const hhmmNow = new Date().toTimeString().slice(0, 5);

stopApi();
const tOff = Date.now();
check("관제: 서버를 끄면 머리 배지가 '재연결 중'", !!(await until(async () => (await text("#live")).startsWith("재연결 중"), 15000)), await text("#live"));
check("관제: 끊긴 지 얼마 안 돼서는 배너가 아직 없음 (잠깐 끊김에 놀라지 않게)", !(await visible("#conn-banner")) || Date.now() - tOff > 8000 * SLOW);
const shown = await until(() => visible("#conn-banner"), 20000);
const bt = await text("#conn-banner");
check("관제: 오래 끊기면 배너 — '서버에 연결할 수 없습니다 · 마지막 갱신 HH:MM'", !!shown && /서버에 연결할 수 없습니다 · 마지막 갱신 \d{2}:\d{2}/.test(bt), bt);
const m = bt.match(/마지막 갱신 (\d{2}):(\d{2})/);
const minutesOf = (h, mi) => Number(h) * 60 + Number(mi);
const [nh, nm] = hhmmNow.split(":");
check("관제: 마지막 갱신 시각이 끊기기 직전(분 단위)", !!m && Math.abs(minutesOf(m[1], m[2]) - minutesOf(nh, nm)) <= 2, `${m?.[1]}:${m?.[2]} ≈ ${hhmmNow}`);
check("관제: 배너 글자 15px 이상", parseFloat(await ev(`getComputedStyle(document.getElementById("conn-banner")).fontSize`)) >= 15);

// 끊긴 채로 다시 그리기를 일으킨다(같은 화면에서 hashchange) — 그려진 화면을 '불러오지 못했습니다'로 덮어쓰면 안 된다
await ev(`window.dispatchEvent(new Event("hashchange"))`);
await sleep(2000);
const before = await ev(`document.getElementById("app").innerHTML.length`);
// 서버가 꺼진 사이 DB 에 변화가 생기는 상황: 켜기 전에 DB 를 직접 바꿀 수는 없으니(서버가 없다) 켠 뒤 접수 1건으로 갈음한다.
check("관제: 끊긴 동안에도 화면이 지워지지 않음", before > 200, `${before}자`);

let up = await startApi();
check("관제: 서버를 다시 켜면 (webapi 기동)", up);
check("관제: 저절로 '실시간'으로 돌아옴 (새로고침 없이)", !!(await until(async () => (await text("#live")).startsWith("실시간"), 40000)), await text("#live"));
check("관제: 배너가 사라짐", !!(await until(async () => !(await visible("#conn-banner")), 8000)));
// 서버가 없던 사이의 변화를 복구하는지: 다시 붙은 뒤 민원 1건을 지워(관리자 코드는 이 스크립트가 만든 테스트 서버 것) 누적이 바뀌는지 본다.
const t0 = await total();
const victim = (await (await fetch(`http://127.0.0.1:${apiPort}/api/control`)).json()).data.feed[0]?.id;
const del = await fetch(`http://127.0.0.1:${apiPort}/api/rpc/delete_feedback`, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Code": apiEnv.ADMIN_CODE }, body: JSON.stringify({ p_id: victim }) });
check("관제: 다시 붙은 뒤 서버에서 일어난 변화가 화면에 반영됨 (실시간 복구)", del.ok && !!(await until(async () => (await text("#app")).includes(`누적 ${t0 - 1}`), 10000)), `누적 ${t0} → ${t0 - 1} 기대`);

// ══ 방문객 화면 ═════════════════════════════════════════════════════
await open(`${base}/?v=qr`);
check("방문객: 접수 화면에 배너가 없음 (화면에 붙지 않음)", !(await ev(`!!document.getElementById("conn-banner")`)));
await ev(`(() => { const s = document.querySelector("#rf select"); s.value = s.options[1].value; s.dispatchEvent(new Event("change")); const t = document.querySelector("#rf textarea"); t.value = "네트워크가 끊겼을 때 접수해도 내용이 남는지 확인"; t.dispatchEvent(new Event("input")); })()`);
const zoneVal = await ev(`document.querySelector("#rf select").value`);
stopApi();
await sleep(1200);
await ev(`document.querySelector("#rf button").click()`);
check("방문객: 서버가 꺼진 채 접수 → 오류 안내가 뜸", !!(await until(() => visible("#rerr"), 8000)), await text("#rerr"));
check("방문객: 안내에 '다시 시도'와 입력이 남아 있다는 말", /다시 시도/.test(await text("#rerr")) && /그대로/.test(await text("#rerr")), await text("#rerr"));
check("방문객: 버튼이 '다시 시도'로 바뀌고 눌러볼 수 있음", (await text("#rf button")) === "다시 시도" && !(await ev(`document.querySelector("#rf button").disabled`)));
check("방문객: 적은 내용·구역이 그대로", (await ev(`document.querySelector("#rf textarea").value`)) === "네트워크가 끊겼을 때 접수해도 내용이 남는지 확인" && (await ev(`document.querySelector("#rf select").value`)) === zoneVal);
check("방문객: 성공 창은 뜨지 않음", !(await ev(`!!document.querySelector(".rp-modal")`)));
check("방문객: 개발 용어(python · webapi · local)가 안내에 없음", !/python|webapi|local/i.test(await text("#rerr")));

up = await startApi();
const t1 = up ? inbox() : -1;
await ev(`document.querySelector("#rf button").click()`);
check("방문객: 서버를 켜고 '다시 시도' → 접수 완료 창", !!(await until(() => ev(`!!document.querySelector(".rp-modal")`), 10000)));
check("방문객: 접수함에 정확히 1건 늘어남 (실패한 시도는 저장되지 않았고, 재시도는 한 번만)", up && inbox() === t1 + 1, `${t1} → ${inbox()}`);

console.log(`\n통과 ${passed} · 실패 ${failed} · 건너뜀 ${skipped}`);
await cleanup();
process.exit(failed ? 1 : 0);
