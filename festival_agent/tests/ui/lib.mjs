// 점검 스크립트 공용 — 크롬(CDP)·포트·프로세스 정리·결과 출력. 각 스크립트가 따로 베끼던 것을 한 곳에 모았다.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** 지금 비어 있는 포트 하나 */
export const freePort = () => new Promise((res) => {
  const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

/** 내가 띄운 프로세스와 그 하위를 끈다 (Windows: taskkill /T) */
export function killTree(c) {
  try {
    if (!c?.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGKILL");
  } catch { /* 이미 끝남 */ }
}

/** 헤드리스 크롬을 띄우고 DevTools 프로토콜로 연결한다.
 *  prefix: 임시 프로필 폴더 이름 앞부분(adm- · rf- …) · width/height: 창 크기 ·
 *  onMessage(m): 응답이 아닌 이벤트(Fetch.requestPaused 등)를 받는 곳 — 안에서 send 를 써도 된다.
 *  돌려주는 것: chrome · ws · send(method, params)→result(오류면 error) · ev(expr)→값(없으면 undefined, Promise 는 기다림) */
export async function openChrome({ prefix = "ui-", width, height, onMessage } = {}) {
  const port = await freePort();
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run",
    `--user-data-dir=${mkdtempSync(join(tmpdir(), prefix))}`, `--remote-debugging-port=${port}`,
    ...(width ? [`--window-size=${width},${height ?? 900}`] : []), "about:blank"], { stdio: "ignore" });
  let targets;
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  if (!targets) { killTree(chrome); throw new Error("크롬에 연결하지 못함"); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
    else if (onMessage) onMessage(m);
  });
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { chrome, ws, send, ev };
}

// chrome.kill() 은 본 프로세스만 강제로 끊는다. 그러면 하위(renderer · gpu · utility) 프로세스가 고아로 남아
// 프로필 파일을 붙잡고, 임시 폴더가 지워지지 않는다 (renderer 는 명령줄에 --user-data-dir 이 없어 경로로도 못 찾는다).
// 그래서 ① 크롬에게 스스로 닫으라고 하고(Browser.close) ② 안 닫히면 하위까지 한꺼번에 끈다(taskkill /T).
export async function quitChrome(chrome, ws) {
  const exited = new Promise((r) => chrome.once("exit", r));
  try { ws?.send(JSON.stringify({ id: 999999, method: "Browser.close" })); } catch { /* 이미 끊김 */ }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2500))]);
  if (chrome.exitCode === null) killTree(chrome);
  try { ws?.close(); } catch { /* */ }
}

/** ✓ 통과 · ✗ 실패 · ○ 건너뜀 출력 (run_all 이 이 모양을 읽는다) */
export function reporter() {
  const r = { passed: 0, failed: 0, skipped: 0 };
  r.ok = (n, d = "") => { r.passed++; console.log(`✓ ${n}${d ? "  — " + d : ""}`); };
  r.bad = (n, d = "") => { r.failed++; console.log(`✗ ${n}${d ? "  — " + d : ""}`); };
  r.check = (n, c, d = "") => (c ? r.ok(n, d) : r.bad(n, d));
  r.skip = (n, why) => { r.skipped++; console.log(`○ ${n}  — 건너뜀: ${why}`); };
  r.summary = () => console.log(`\n통과 ${r.passed} · 실패 ${r.failed} · 건너뜀 ${r.skipped}`);
  return r;
}
