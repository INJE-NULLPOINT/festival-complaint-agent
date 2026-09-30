// 폰 폭 점검: 가로 스크롤 · 넘친 요소 · 터치 영역 · 입력 글꼴. 사용: node mobile_check.mjs <base> <출력폴더> [접두어]
import { quitChrome } from "./chrome_util.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base, outDir, prefix = ""] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const SIZES = [[320, 640], [360, 740], [390, 844], [430, 932], [844, 390]];
const VIEWS = [
  ["report", "/?v=qr", []],
  ["report-open", "/?v=qr&zone=%EC%9C%A0%EB%93%B1%ED%84%B0%EB%84%90", ["details summary"]],
  ["control", "/#control", []],
  // 옛 화면(#hero-formula · .rank .row)과 카드 화면(D5-29: 카드 행 · 계산식 · 묶음 · 유형별 순위)을 둘 다 펼쳐 잰다
  ["control-open", "/#control", ["#hero-formula", ".alert-row", "details[data-grp] > summary", ".icard:not(.big) .ic-head", "[data-fx]", ".rank .row", ".feed-item"]],
  ["action", "/#action", []],
  ["action-open", "/#action", ["[data-toggle]", "#toggle-old"]],
];

const port = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${mkdtempSync(join(tmpdir(), "mob-"))}`,
  `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
await send("Page.enable"); await send("Runtime.enable");

const MEASURE = (W) => `(() => {
  const vw = ${W}, sw = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const over = [];
  for (const el of document.querySelectorAll("#app *, header *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).visibility === "hidden") continue;
    if (r.right > vw + 0.5 || r.left < -0.5) {
      // 넘친 요소 중 가장 바깥(부모가 안 넘친) 것만
      const p = el.parentElement?.getBoundingClientRect();
      if (!p || p.right <= vw + 0.5) over.push(el.tagName.toLowerCase() + "." + [...el.classList].join(".") + " " + Math.round(r.right - vw) + "px");
    }
  }
  const small = [];
  for (const el of document.querySelectorAll("button, a.btn, select, textarea, input, .tabs a")) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    const linkbtn = el.classList.contains("linkbtn") || el.classList.contains("alert-row") || el.classList.contains("feed-item") || el.classList.contains("row");
    if (r.height < 44 && !linkbtn) small.push(el.tagName.toLowerCase() + "." + [...el.classList].join(".") + " " + Math.round(r.height) + "px");
    if (linkbtn && r.height < 32) small.push(el.tagName.toLowerCase() + "." + [...el.classList].join(".") + " " + Math.round(r.height) + "px(글자버튼)");
  }
  const inputs = [...document.querySelectorAll("select, textarea, input")].map((e) => parseFloat(getComputedStyle(e).fontSize)).filter((x) => x < 16);
  return { vw, sw, scroll: sw > vw, over: [...new Set(over)].slice(0, 6), small: [...new Set(small)].slice(0, 6), inputFontUnder16: inputs.length,
           app: document.getElementById("app")?.innerHTML.length ?? 0 };
})()`;

let fails = 0;
const rows = [];
for (const [w, h] of SIZES) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  for (const [name, path, clicks] of VIEWS) {
    await send("Page.navigate", { url: base + path });
    await sleep(3500);
    if ((await evalJs(`document.getElementById("app")?.innerHTML.length ?? 0`)) < 50) await sleep(3000);
    for (const sel of clicks) {
      await evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).forEach((e) => e.click())`);
      await sleep(400);
    }
    await sleep(600);
    const m = await evalJs(MEASURE(w));
    const bad = m.scroll || m.over.length || m.inputFontUnder16;
    fails += bad ? 1 : 0;
    rows.push(`${bad ? "✗" : "✓"} ${String(w).padStart(3)}×${h} ${name.padEnd(13)} scroll ${m.sw}/${m.vw}` +
      (m.over.length ? `  넘침: ${m.over.join(", ")}` : "") + (m.small.length ? `  작은터치: ${m.small.join(", ")}` : "") +
      (m.inputFontUnder16 ? `  입력글꼴<16: ${m.inputFontUnder16}` : "") + (m.app < 50 ? "  (내용 없음!)" : ""));
    const lm = await send("Page.getLayoutMetrics");
    const fullH = Math.min(6000, Math.ceil(lm.cssContentSize.height));
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: Math.max(h, fullH), deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(250);
    const s = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, `${prefix}${w}x${h}_${name}.png`), Buffer.from(s.data, "base64"));
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  }
}
console.log(rows.join("\n"));
console.log(`\n실패 ${fails}/${rows.length}`);
await quitChrome(chrome, ws); process.exit(0);
