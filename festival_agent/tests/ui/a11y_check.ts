// 접근성 점검 (할일 D5-38) — 관리자·방문객 화면을 라이트/다크로 돌며 다음을 잰다.
//   1. 키보드: 눈에 보이는 모든 조작 요소가 Tab 으로 닿는지 · 닿았을 때 포커스 표시가 있는지 · 양수 tabindex 없음
//   2. 스크린리더 이름: 버튼·링크·입력·이미지 역할에 접근 가능한 이름이 있는지 (Chrome 접근성 트리) · h1 하나 · id 중복 없음
//   3. 알림 영역: 토스트 컨테이너 aria-live · 경고 토스트 role
//   4. 색 대비 AA: 화면의 모든 글자(일반 4.5 · 큰 글자 3.0) 와 placeholder
//   5. 확대 200%: 폭 절반(1280→640)에서 가로 스크롤·넘침 없음
//
// 사용 (festival_agent 폴더에서):
//   node tests/ui/a11y_check.ts <base> <테스트DB> [--scheme=light|dark] [--shots=<폴더>] [--only=이름,이름] [--json=<파일>]
// 테스트 DB 에만 쓴다 (확인 필요·삭제 장면을 만든다). 운영 서버·DB 에는 돌리지 말 것.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const [base, db] = args.filter((a) => !a.startsWith("--"));   // db 는 안내용 (이 스크립트는 주소만 쓴다)
const SCHEME = opt("scheme", "light");
const SHOTS = opt("shots", "");
const ONLY = opt("only", "")?.split(",").filter(Boolean);
const JSON_OUT = opt("json", "");
const EMPTY = args.includes("--empty");   // 빈 서버(민원 0건)에서 빈 화면·오류 화면 장면을 잰다 (D5-39)
if (!base || !db) { console.error("사용: node tests/ui/a11y_check.ts <base> <테스트DB> [--scheme=dark] [--shots=폴더]"); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// 기계 부하 배율 + 조건 대기: 고정 대기는 CPU 가 바쁘면 모자라다. 검사 기준은 그대로.
const cpuBusy = () => new Promise<number>((res) => {
  const a = cpus();
  setTimeout(() => { const b = cpus(); let idle = 0, total = 0;
    b.forEach((c, i) => { for (const k of Object.keys(c.times)) { const d = c.times[k as keyof typeof c.times] - a[i].times[k as keyof typeof c.times]; total += d; if (k === "idle") idle += d; } });
    res(total ? 1 - idle / total : 0); }, 800);
});
const BUSY = await cpuBusy();
const SLOW = BUSY > 0.85 ? 3 : BUSY > 0.6 ? 2 : 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * SLOW));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms * SLOW;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
console.log(`[a11y] 테마 ${SCHEME} · CPU ${Math.round(BUSY * 100)}% → 기다리는 시간 ×${SLOW}`);

const port = 9200 + Math.floor(Math.random() * 90);
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", `--user-data-dir=${mkdtempSync(join(tmpdir(), "ax-"))}`,
  `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch { /* */ } });   // 검사가 오류로 죽어도 크롬을 남기지 않는다
let t;
for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
type CdpResult = Record<string, any>;     // DevTools 프로토콜 응답 (메서드마다 모양이 달라 키로 읽는다)
let id = 0;
const P = new Map<number, (v: CdpResult) => void>();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && P.has(m.id)) { P.get(m.id)(m.result ?? m.error); P.delete(m.id); } });
const send = (method: string, params: Record<string, unknown> = {}): Promise<CdpResult> => new Promise((r) => { const n = ++id; P.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (x: string): Promise<any> => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.value;

// ── 장면에서 재는 함수들 (페이지 안에서 실행) ─────────────────────────
const IN_PAGE = `(() => {
  const parse = (c) => {
    if (!c) return null;
    let m = c.match(/^rgba?\\(([^)]+)\\)/);
    if (m) { const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = c.match(/^color\\(srgb ([^)]+)\\)/);
    if (m) { const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (f, b) => { const a = f.a + b.a * (1 - f.a); if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: (f.r * f.a + b.r * b.a * (1 - f.a)) / a, g: (f.g * f.a + b.g * b.a * (1 - f.a)) / a, b: (f.b * f.a + b.b * b.a * (1 - f.a)) / a, a }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const canvas = parse(getComputedStyle(document.documentElement).backgroundColor);
  const page = (canvas && canvas.a > 0) ? canvas : (matchMedia("(prefers-color-scheme: dark)").matches && !document.documentElement.matches('[data-theme="light"]') ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 });
  const bgOf = (el) => {   // 요소 뒤의 실제 배경색 (불투명해질 때까지 겹침). 그라데이션·이미지가 있으면 null
    const chain = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { chain.push(c); if (c.a >= 1) break; }
    }
    let bg = page;
    for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg);
    return bg;
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const visible = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || e.hidden) return false;
      if (e.tagName === "DETAILS" && !e.open && el !== e && !e.querySelector(":scope > summary")?.contains(el)) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const sel = (el) => { const cls = [...el.classList].slice(0, 2).join("."); return el.tagName.toLowerCase() + (cls ? "." + cls : ""); };
  const out = { contrast: [], skipped: 0, checked: 0 };
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n; (n = tw.nextNode());) {
    const txt = n.textContent.replace(/\\s+/g, " ").trim();
    if (!txt) continue;
    const el = n.parentElement;
    if (!el || ["SCRIPT", "STYLE", "OPTION", "NOSCRIPT"].includes(el.tagName)) continue;
    if (!visible(el) || el.closest("[disabled], :disabled") || el.closest("select")) { continue; }
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); const bg = bgOf(el);
    if (!fg || !bg) { out.skipped++; continue; }
    const a = fg.a * opacityOf(el);
    const eff = over({ ...fg, a }, bg);
    const r = ratio(eff, bg);
    const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    out.checked++;
    if (r < need) {
      const key = sel(el) + "|" + txt.slice(0, 20);
      if (!seen.has(key)) { seen.add(key); out.contrast.push({ el: sel(el), text: txt.slice(0, 40), ratio: Math.round(r * 100) / 100, need, fg: cs.color, bg: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(",") + ")", px }); }
    }
  }
  // placeholder
  for (const el of document.querySelectorAll("textarea[placeholder], input[placeholder]")) {
    if (!visible(el)) continue;
    const pc = parse(getComputedStyle(el, "::placeholder").color); const bg = bgOf(el); if (!pc || !bg) continue;
    const eff = over({ ...pc, a: pc.a * opacityOf(el) }, bg); const r = ratio(eff, bg); out.checked++;
    if (r < 4.5) out.contrast.push({ el: "placeholder:" + sel(el), text: el.getAttribute("placeholder").slice(0, 30), ratio: Math.round(r * 100) / 100, need: 4.5 });
  }
  return out;
})()`;

const FOCUSABLE = `button:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type=hidden]), summary, [tabindex]:not([tabindex="-1"])`;

async function keyboardAudit() {
  // 눈에 보이고 inert 아닌 조작 요소에 번호를 붙인다
  const total = await ev(`(() => {
    let n = 0; const list = [];
    for (const e of document.querySelectorAll(${JSON.stringify(FOCUSABLE)})) {
      e.removeAttribute("data-a11y");
      let ok = true;
      for (let p = e; p && p.nodeType === 1; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.display === "none" || cs.visibility === "hidden" || p.hidden || p.inert) { ok = false; break; }
        if (p.tagName === "DETAILS" && !p.open && !p.querySelector(":scope > summary")?.contains(e) && p !== e) { ok = false; break; }
      }
      const r = e.getBoundingClientRect();
      if (!ok || (r.width === 0 && r.height === 0)) continue;
      e.setAttribute("data-a11y", String(n)); n++;
      list.push(e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : "") + ":" + (e.getAttribute("aria-label") || e.textContent.trim().slice(0, 12)));
    }
    window.__a11yList = list; return n;
  })()`);
  const positive = await ev(`[...document.querySelectorAll("[tabindex]")].filter((e) => Number(e.getAttribute("tabindex")) > 0).length`);
  await ev(`document.activeElement && document.activeElement.blur(); window.scrollTo(0,0)`);
  const reached = new Set(), noRing = [];
  const key = async (type, p = {}) => send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, ...p });
  const limit = Math.min(total + 12, 260);
  for (let i = 0; i < limit; i++) {
    await key("keyDown"); await key("keyUp");
    const st = await ev(`(() => { const e = document.activeElement; if (!e || e === document.body) return null;
      const ok = (el) => { const cs = getComputedStyle(el); const ow = parseFloat(cs.outlineWidth) || 0; return (cs.outlineStyle !== "none" && ow > 0) || (cs.boxShadow && cs.boxShadow !== "none"); };
      const ring = ok(e) || (e.closest("label") && ok(e.closest("label"))) || (e.closest(".kf") && ok(e.closest(".kf")));
      return { i: e.getAttribute("data-a11y"), ring: !!ring, name: window.__a11yList[Number(e.getAttribute("data-a11y"))] || e.tagName }; })()`);
    if (!st) continue;
    if (st.i !== null && st.i !== undefined) reached.add(st.i);
    if (!st.ring) noRing.push(st.name);
    if (reached.size >= total) break;
  }
  const unreached = await ev(`[...document.querySelectorAll("[data-a11y]")].filter((e) => !${JSON.stringify([...reached])}.includes(e.getAttribute("data-a11y"))).map((e) => window.__a11yList[Number(e.getAttribute("data-a11y"))])`);
  return { total, reached: reached.size, unreached, noRing: [...new Set(noRing)], positive };
}

async function nameAudit() {
  await send("Accessibility.enable"); await send("DOM.enable");
  const tree = await send("Accessibility.getFullAXTree");
  const need = new Set(["button", "link", "combobox", "textbox", "checkbox", "radio", "switch", "tab", "menuitem", "img", "listbox", "searchbox", "spinbutton", "slider", "dialog"]);
  const bad = [];
  let h1 = 0;
  for (const n of tree.nodes ?? []) {
    if (n.ignored) continue;
    const role = n.role?.value;
    if (role === "heading" && (n.properties ?? []).some((p) => p.name === "level" && p.value.value === 1)) h1++;
    if (!need.has(role)) continue;
    const name = (n.name?.value ?? "").trim();
    if (!name) {
      let html = "";
      try { html = (await send("DOM.getOuterHTML", { backendNodeId: n.backendDOMNodeId })).outerHTML?.slice(0, 90) ?? ""; } catch { /* */ }
      bad.push(`${role}: ${html}`);
    }
  }
  const dup = await ev(`(() => { const m = {}; for (const e of document.querySelectorAll("[id]")) m[e.id] = (m[e.id] || 0) + 1; return Object.keys(m).filter((k) => m[k] > 1); })()`);
  return { bad, h1, dup };
}

// ── 장면 ───────────────────────────────────────────────────────────
const Z = "%EC%9C%A0%EB%93%B1%ED%84%B0%EB%84%90";
const clickAll = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).forEach((e) => e.click())`);
interface Scene {
  name: string; url: string; ready: string; prep?: () => Promise<void>; toast?: boolean;
  phone?: boolean; seed?: string; init?: string; expect?: string[]; alertRole?: boolean;
}
const SCENES: Scene[] = [
  { name: "관제", url: "/#control", ready: `!!document.querySelector(".icard.big")` },
  { name: "관제-펼침", url: "/#control", ready: `!!document.querySelector(".icard.big")`, prep: async () => {
      await clickAll(".icard:not(.big) .ic-head"); await clickAll("details.igrp > summary"); await clickAll("details.typerank > summary");
      await clickAll("[data-fx]"); await ev(`document.querySelector("[data-rv-toggle]")?.click()`); await sleep(400); } },
  { name: "조치", url: "/#action", ready: `!!document.querySelector(".docs li, .targets li")`, prep: async () => { await ev(`document.querySelector("[data-toggle]")?.click(); document.querySelector("#toggle-old")?.click()`); await sleep(300); } },
  { name: "접수", url: `/?v=qr&zone=${Z}`, ready: `!!document.querySelector("#rf")`, prep: async () => { await clickAll("details summary"); await sleep(300); } },
  { name: "접수-모달", url: `/?v=qr&zone=${Z}`, ready: `!!document.querySelector("#rf")`, prep: async () => {
      await ev(`(() => { const t = document.querySelector("textarea"); t.value = "유등터널 입구 조명이 꺼져서 어두워요"; t.dispatchEvent(new Event("input")); document.querySelector("#rf button").click(); })()`);
      await waitFor(() => ev(`!!document.querySelector(".rp-modal[open]")`)); await sleep(500); } },
  { name: "토스트", url: "/#control", ready: `!!document.querySelector(".feed li .del")`, prep: async () => {
      await ev(`document.querySelector(".feed li[data-fid] .del").click()`); await waitFor(() => ev(`!!document.querySelector("#toasts .toast-act")`)); await sleep(300); }, toast: true },
];

// 빈 화면·오류 화면 장면 (--empty): 빈 DB 에 붙은 서버에서. expect 문구가 보여야 하고 forbid(개발자 말투)는 없어야 한다.
const FORBID = ["워커", "local 대역", "webapi", "SSE", "에이전트를 한 바퀴", "undefined", "[object", "TypeError"];
const EMPTY_SCENES = [
  { name: "관제-빈", url: "/#control", ready: `!!document.querySelector(".state")`,
    expect: ["접수된 민원 없음", "브리핑 없음"] },
  { name: "조치-빈", url: "/#action", ready: `!!document.querySelector(".state")`,
    expect: ["조치할 대상 없음", "조치요청서 없음"] },
  { name: "관제-조치할일없음", url: "/#control", ready: `!!document.querySelector("details.igrp")`,
    seed: "no-main", expect: ["지금 바로 조치할 일 없음"] },
  { name: "접수-구역없음", url: "/?v=qr", ready: `!!document.querySelector(".state.error")`, phone: true,
    init: `(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes("/api/zones") ? Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } })) : f(u, o); })();`,
    expect: ["지금은 접수할 수 없습니다", "잠시 뒤 다시 열어 주세요"], alertRole: true },
];
if (EMPTY) SCENES.splice(0, SCENES.length, ...EMPTY_SCENES);

await send("Page.enable");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: SCHEME }] });

if (EMPTY) execFileSync(process.execPath, [join(HERE, "seed_states.ts"), db, "clear"], { stdio: "ignore" });
const findings = [];
let fails = 0;
const note = (scene: string, kind: string, ok: boolean, detail: string = "") => { if (!ok) fails++; console.log(`${ok ? "✓" : "✗"} [${scene}] ${kind}${detail ? "  — " + detail : ""}`); if (!ok) findings.push({ scene, kind, detail }); };

for (const sc of SCENES) {
  if (ONLY?.length && !ONLY.includes(sc.name)) continue;
  const phone = sc.phone ?? sc.name.includes("접수");
  const W = phone ? 390 : 1280;
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: phone ? 844 : 1000, deviceScaleFactor: 1, mobile: phone });
  if (sc.seed) execFileSync(process.execPath, [join(HERE, "seed_states.ts"), db, sc.seed], { stdio: "ignore" });   // 테스트 DB 에만
  let initId = null;
  if (sc.init) initId = (await send("Page.addScriptToEvaluateOnNewDocument", { source: sc.init })).identifier;
  await send("Page.navigate", { url: "about:blank" });   // 같은 주소로 다시 가면 새로 로드되지 않아 앞 장면(토스트 등)이 남는다 — 매번 빈 페이지를 거친다
  await send("Page.navigate", { url: base + sc.url });
  await waitFor(() => ev(sc.ready), 20000);
  await sleep(700);
  await sc.prep?.();
  const tag = `${sc.name}·${SCHEME}`;
  // 토스트는 5초만 보인다 — 아래 대비·접근성 트리 검사가 오래 걸려도 사라지기 전에 먼저 읽어 둔다
  const toastState = sc.toast ? await ev(`(() => { const t = document.querySelector("#toasts .toast"); return { live: document.getElementById("toasts").getAttribute("aria-live"), role: t ? t.getAttribute("role") : "(토스트 없음)" }; })()`) : null;

  if (EMPTY) {
    const body = await ev(`document.body.innerText`);
    for (const w of sc.expect ?? []) note(tag, `안내 문구: "${w}"`, body.includes(w));
    const bad = FORBID.filter((w) => body.includes(w));
    note(tag, "개발자 말투·내부 용어 없음", bad.length === 0, bad.join(", "));
    if (sc.alertRole) note(tag, "오류 안내는 role=alert", await ev(`!!document.querySelector(".state.error[role=alert]")`));
  }
  // 1. 색 대비
  const c = await ev(IN_PAGE);
  note(tag, `색 대비 AA (글자 ${c.checked}곳 검사)`, c.contrast.length === 0,
    c.contrast.length ? c.contrast.slice(0, 6).map((x) => `${x.el} "${x.text}" ${x.ratio}<${x.need}`).join(" / ") + (c.contrast.length > 6 ? ` 외 ${c.contrast.length - 6}건` : "") : "");
  // 2. 이름 · 제목 · id
  const na = await nameAudit();
  note(tag, "접근 가능한 이름 (버튼·링크·입력·이미지)", na.bad.length === 0, na.bad.slice(0, 4).join(" / "));
  // 모달이 떠 있으면 뒤 화면은 접근성 트리에서 빠진다(그게 정상) — 그때는 h1 을 요구하지 않는다
  if (sc.name !== "접수-모달") note(tag, "h1 이 정확히 하나", na.h1 === 1, `h1 ${na.h1}개`);
  note(tag, "id 중복 없음", na.dup.length === 0, na.dup.join(","));
  // 3. 알림 영역
  if (sc.toast) note(tag, "토스트 알림 영역 (aria-live + 토스트 role)", toastState.live === "polite" && (toastState.role === "status" || toastState.role === "alert"), JSON.stringify(toastState));
  // 4. 키보드 (토스트는 타이머라 건너뜀)
  if (!sc.toast) {
    const kb = await keyboardAudit();
    note(tag, `키보드로 모두 닿음 (${kb.reached}/${kb.total})`, kb.unreached.length === 0 || sc.name === "접수-모달", kb.unreached.slice(0, 5).join(" / "));
    note(tag, "포커스 표시가 보임", kb.noRing.length === 0, kb.noRing.slice(0, 5).join(" / "));
    note(tag, "양수 tabindex 없음", kb.positive === 0);
  }
  // 5. 확대 200% (폭 절반)
  if (!sc.toast && sc.name !== "접수-모달") {
    const half = Math.round(W / 2);
    await send("Emulation.setDeviceMetricsOverride", { width: half, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const z = await ev(`(() => { const w = ${half}; const over = []; for (const e of document.querySelectorAll("#app *, header *")) { const r = e.getBoundingClientRect(); if (r.width && (r.right > w + 1 || r.left < -1)) { const p = e.parentElement.getBoundingClientRect(); if (p.right <= w + 1) over.push(e.tagName.toLowerCase() + "." + String(e.className).split(" ")[0]); } } return { sw: document.documentElement.scrollWidth, over: [...new Set(over)].slice(0, 5) }; })()`);
    note(tag, `확대 200% (폭 ${half}px) 에서 가로 스크롤·넘침 없음`, z.sw <= half + 1 && z.over.length === 0, `scrollWidth ${z.sw} ${z.over.join(",")}`);
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: phone ? 844 : 1000, deviceScaleFactor: 1, mobile: phone });
    await sleep(300);
  }
  if (initId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: initId });
  if (sc.seed) execFileSync(process.execPath, [join(HERE, "seed_states.ts"), db, "clear"], { stdio: "ignore" });   // 시드를 지워 다음 실행도 진짜 빈 상태에서 시작한다
  if (SHOTS) {
    const h = await ev(`Math.min(6000, Math.ceil(document.documentElement.scrollHeight))`);
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: Math.max(phone ? 844 : 1000, h), deviceScaleFactor: 1, mobile: phone });
    await sleep(300);
    const s = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${sc.name}_${W}_${SCHEME}.png`), Buffer.from(s.data, "base64"));
  }
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(findings, null, 1));
console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
ws.close(); chrome.kill(); process.exit(fails ? 1 : 0);
