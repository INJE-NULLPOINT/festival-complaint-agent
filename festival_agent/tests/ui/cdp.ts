// 헤드리스 크롬을 DevTools 프로토콜로 몰아 콘솔·네트워크·DOM 을 기록한다.
// 사용: node cdp.ts <url> [대기ms] [가로] [세로] [스크린샷경로]
import { quitChrome } from "./lib.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, waitMs = "6000", w = "1440", h = "900", shotPath, scheme = "light", clickSel = ""] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(join(tmpdir(), "cdp-"));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${prof}`,
  `--remote-debugging-port=${port}`, `--window-size=${w},${h}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); }
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
type CdpResult = Record<string, any>;     // DevTools 프로토콜 응답 (메서드마다 모양이 달라 키로 읽는다)
let id = 0; const pending = new Map<number, (v: CdpResult) => void>();
const send = (method: string, params: Record<string, unknown> = {}): Promise<CdpResult> => new Promise((res) => {
  const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
});
const reqs = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
  const p = m.params;
  if (m.method === "Runtime.consoleAPICalled") console.log(`[console.${p.type}]`, p.args.map((a) => a.value ?? a.description).join(" "));
  if (m.method === "Runtime.exceptionThrown") console.log("[exception]", p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
  if (m.method === "Network.requestWillBeSent" && p.request.url.includes("/api/")) reqs.set(p.requestId, { url: p.request.url.replace(/^.*\/api/, "/api"), t0: p.timestamp });
  if (m.method === "Network.responseReceived" && reqs.has(p.requestId)) reqs.get(p.requestId).status = p.response.status;
  if (m.method === "Network.loadingFinished" && reqs.has(p.requestId)) reqs.get(p.requestId).done = ((p.timestamp - reqs.get(p.requestId).t0) * 1000).toFixed(0) + "ms";
  if (m.method === "Network.loadingFailed" && reqs.has(p.requestId)) reqs.get(p.requestId).fail = p.errorText;
});
await send("Runtime.enable"); await send("Network.enable"); await send("Page.enable");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
// 창 최소폭(약 500px) 제한을 피해 실제 폰 폭으로 그린다
await send("Emulation.setDeviceMetricsOverride", {
  width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 600,
});
await send("Page.navigate", { url });
await sleep(Number(waitMs));
if (clickSel) {
  const c = await send("Runtime.evaluate", { expression: `(() => { const e = document.querySelector(${JSON.stringify(clickSel)}); if (!e) return "없음"; e.click(); return "클릭"; })()`, returnByValue: true });
  console.log("[click]", clickSel, c.result.value);
  await sleep(1500);
}
const r = await send("Runtime.evaluate", { expression: `(() => {
  // 보이는 글자가 있는 요소 중 가장 작은 글자 크기
  let min = 99, where = "";
  for (const el of document.querySelectorAll("body *")) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own || !el.getClientRects().length) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < min) { min = px; where = el.tagName.toLowerCase() + "." + [...el.classList].join(".") + " " + el.textContent.trim().slice(0, 12); }
  }
  return JSON.stringify({live: document.getElementById('live')?.textContent, app: document.getElementById('app')?.innerHTML.length,
    err: document.querySelector('#app .err')?.textContent ?? null, minFont: min, minAt: where});
})()`, returnByValue: true });
console.log("[dom]", r.result.value);
for (const q of reqs.values()) console.log("[net]", q.url, q.status ?? "-", q.done ?? (q.fail ? `FAIL ${q.fail}` : "pending"));
if (shotPath) {
  // 문서 전체 높이로 찍는다
  const m = await send("Page.getLayoutMetrics");
  const full = Math.min(4000, Math.ceil(m.cssContentSize?.height ?? Number(h)));
  await send("Emulation.setDeviceMetricsOverride", {
    width: Number(w), height: Math.max(Number(h), full), deviceScaleFactor: 1, mobile: Number(w) < 600,
  });
  await sleep(300);
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(shotPath, Buffer.from(s.data, "base64"));
  console.log("[shot]", shotPath);
}
await quitChrome(chrome, ws);
process.exit(0);
