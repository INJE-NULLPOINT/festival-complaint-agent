// 전체 페이지 캡처 + 구역 좌표 (영상 편집용) — 제품 코드는 건드리지 않는다.
//   node 제출_준비/최종/_capture_pages.ts [--llm local|claude_code] [--outdir <폴더>]
// 데이터: 시연 DB(demo_scenario --reset --no-wait) + 워커로 폰 민원·혼잡 2건을 넣어 '혼잡 카드 1위 · 브리핑 일치' 상태를 만든 뒤 찍는다.
// 다크 · 오버레이 없음 · 뷰포트 폭 1920(폰은 390) · DSF 2.
// 산출(기본 _영상편집/src/page/): page_control / page_action / page_dev_log·cls·sev·state / page_phone 의 .png 와 같은 이름 .json (CSS px 좌표)
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { freePort, killTree, openChrome, quitChrome } from "../../festival_agent/tests/ui/lib.ts";

const HERE = import.meta.dirname;
const APP = path.resolve(HERE, "..", "..", "festival_agent");
const { values: A } = parseArgs({ options: { llm: { type: "string", default: "claude_code" }, outdir: { type: "string" } } });
const OUT = path.resolve(A.outdir ?? path.join(HERE, "_영상편집", "src", "page"));
const tmp = mkdtempSync(path.join(tmpdir(), "demo-pages-"));
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<any> | any, ms = 10000, step = 200) => { const t0 = Date.now(); for (;;) { let v: any = null; try { v = await fn(); } catch { /* 아직 */ } if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const kids: ChildProcess[] = [];

async function main() {
  const DB = path.join(APP, "output", "demo_festival.db");
  const LLM = A.llm as string;
  const env = { ...process.env, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", DB_PATH: DB, LLM_BACKEND: LLM, DOCS_DIR: path.join(tmp, "docs"), PYTHONIOENCODING: "utf-8", VITE_NO_WATCH: "1" };
  const reset = spawnSync(process.execPath, ["server/scripts/demo_scenario.ts", "--reset", "--no-wait"], { cwd: APP, env: env as any, encoding: "utf-8" });
  if (reset.status !== 0) throw new Error("demo_scenario 실패\n" + reset.stdout + reset.stderr);
  const ap = await freePort(), vp = await freePort();
  const wk = spawn(process.execPath, ["server/worker.ts", "--agent-interval", "20"], { cwd: APP, env: env as any, stdio: ["ignore", "pipe", "pipe"] });
  wk.stdout!.on("data", (d) => process.stdout.write(`[worker] ${d}`)); wk.stderr!.on("data", (d) => process.stderr.write(`[worker!] ${d}`));
  kids.push(wk);
  kids.push(spawn(process.execPath, ["server/webapi.ts", "--port", String(ap)], { cwd: APP, env: env as any, stdio: "ignore" }));
  kids.push(spawn(process.execPath, [path.join(APP, "web/node_modules/vite/bin/vite.js"), "--port", String(vp), "--strictPort", "--host", "127.0.0.1"], { cwd: path.join(APP, "web"), env: { ...env, WEBAPI_PORT: String(ap) } as any, stdio: "ignore" }));
  const base = `http://127.0.0.1:${vp}`;
  const get = async (p: string) => (await (await fetch(base + p)).json()).data;
  if (!(await until(async () => (await fetch(`${base}/api/control`)).ok, 40000, 400))) throw new Error("서버가 뜨지 않음");
  if (!(await until(async () => { const c = await get("/api/control"); return c.total >= 24 && c.pending === 0 && c.issues.length > 0 && !!c.briefing; }, 360000, 1500))) throw new Error("배경 분류가 끝나지 않음");
  await sleep(15000);

  // 폰 민원 1건 + 혼잡 2건 → 혼잡 카드 1위 · 요청서 · 브리핑 일치까지 기다린다
  const zones = await get("/api/zones");
  const zid = (n: string) => zones.find((z: any) => z.name.includes(n)).id;
  const rpc = (name: string, body: any) => fetch(`${base}/api/rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await rpc("submit_feedback", { p_zone_id: zid("진주교"), p_text: "진주교 아래 산책로 조명이 꺼져서 깜깜하고 계단에서 넘어질 뻔했어요" });
  await sleep(8000);
  await rpc("submit_feedback", { p_zone_id: zid("유등터널"), p_text: "유등터널 안에서 사람들이 한꺼번에 몰려서 앞으로 나갈 수가 없어요" });
  await sleep(8000);
  await rpc("submit_feedback", { p_zone_id: zid("유등터널"), p_text: "터널 입구에 사람이 계속 들어와서 안쪽이 너무 붐비고 떠밀려요" });
  const KO: Record<string, string> = { crowd: "혼잡", safety: "안전", parking: "주차", price: "가격", restroom: "화장실", guide: "안내" };
  const top = await until(async () => { const c = await get("/api/control"); const i = c.issues[0]; return i && i.label === "crowd" ? i : null; }, 300000, 1000);
  console.log(`[상태] 혼잡 카드 ${top ? "1위" : "1위 아님(시간 초과)"}`);
  const hasDoc = async () => (await get("/api/action")).actions.some((a: any) => a.label === "crowd" && a.status !== "superseded");
  if (!(await until(hasDoc, 120000, 1000))) { await rpc("request_doc", { p_label: "crowd" }); await until(hasDoc, 120000, 1000); }
  const sync = await until(async () => { const c = await get("/api/control"); const i = c.issues[0]; return !!(i && c.briefing && String(c.briefing.text).includes(KO[i.label] ?? "§")); }, 120000, 1000);
  console.log(`[상태] 브리핑 ${sync ? "일치" : "일치하지 않음(시간 초과)"}`);
  await sleep(6000);

  const o = await openChrome({ prefix: "pages-", width: 1920, height: 1080 });
  const { send, ev } = o;
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  const metrics = (w: number, h: number, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile });
  await metrics(1920, 1080);
  await send("Page.navigate", { url: `${base}/#control` });
  await until(() => ev(`document.querySelectorAll(".icard").length > 0`), 20000);
  await ev(`try { localStorage.removeItem("festival_dev_view"); } catch (e) {}`);
  const go = async (url: string, w: number, ready: string) => {
    await metrics(w, 1080, w < 600);
    await send("Page.navigate", { url }); await until(() => ev(ready), 20000); await sleep(2500);
  };
  const docH = () => ev(`Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))`);
  /** 구역 목록 [이름, 선택자, 여러 개 여부(이름의 # 를 번호로), 이름을 DOM 에서 읽는 식(선택)] → [{name, selector, x, y, w, h}] (페이지 기준 CSS px) */
  const ZONES = (list: string) => `(() => { const out = []; const sy = window.scrollY, sx = window.scrollX; for (const [name, sel, all, nameJs] of ${list}) { const els = all ? [...document.querySelectorAll(sel)] : [document.querySelector(sel)]; els.forEach((e, i) => { if (!e) return; const r = e.getBoundingClientRect(); if (!r.width || !r.height) return; const nm = nameJs ? String(new Function("e", "i", "return " + nameJs)(e, i) || name) : (all ? name.replace("#", String(i + 1)) : name); out.push({ name: nm.trim().split(/\\s+/).join(" "), selector: all ? sel + ":nth-of-type(" + (i + 1) + ")" : sel, x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) }); }); } return out.sort((a, b) => a.y - b.y || a.x - b.x); })()`;
  const save = async (name: string, w: number, h: number, zonesJs: string, clip?: { x: number; y: number; w: number; h: number }) => {
    const params: any = { format: "png" };
    if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 };
    const r = await send("Page.captureScreenshot", params);
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
    const z = await ev(zonesJs);
    writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ file: `${name}.png`, note: "좌표는 CSS px (PNG 는 가로세로 2배). origin 은 PNG 왼쪽 위가 페이지의 어디인지", cssWidth: clip ? clip.w : w, cssHeight: clip ? clip.h : h, scale: 2, origin: clip ? { x: clip.x, y: clip.y } : { x: 0, y: 0 }, zones: z }, null, 1));
    console.log(`[캡처] ${name}.png · css ${clip ? clip.w : w}x${clip ? clip.h : h} · 구역 ${z.length}`);
  };
  /** 문서 높이에 맞춰 뷰포트를 키운 뒤(스크롤 끝까지 한 장) 찍는다 */
  const fullPage = async (name: string, w: number, zonesJs: string) => {
    await ev(`window.scrollTo(0, 0)`); await sleep(500);
    let h = await docH();
    for (let k = 0; k < 3; k++) { await metrics(w, h, w < 600); await sleep(900); const h2 = await docH(); if (h2 === h) break; h = h2; }
    await save(name, w, h, zonesJs);
    await metrics(w, 1080, w < 600);
  };

  // ── 관제 (패널 닫힘) ───────────────────────────────────────────────
  await go(`${base}/#control`, 1920, `document.querySelectorAll(".icard").length > 0`);
  await ev(`(() => { if (document.body.classList.contains("dev-open")) document.getElementById("dev-toggle").click(); })()`); await sleep(1000);
  await fullPage("page_control", 1920, ZONES(`[
    ["요약 숫자 4칸", ".kpis", false],
    ["#", ".kpis .kpi", true, "e.querySelector('.kpi-l')?.textContent"],
    ["지금 조치할 일 (브리핑)", ".card.brief", false],
    ["#번 카드", ".icards .icard", true, "(i + 1) + '번 카드 · ' + (e.querySelector('h3, .ic-title, .ic-name')?.textContent || '')"],
    ["#", "details.igrp", true, "e.querySelector('summary')?.textContent"],
    ["유형별 순위", "details.typerank", false],
    ["실시간 유입", "#app section.card:has(.feed)", false]]`));
  // ── 조치 (혼잡 요청서 펼침) ─────────────────────────────────────────
  await go(`${base}/#action`, 1920, `document.querySelectorAll(".docs li, .targets li").length > 0`);
  await ev(`(() => { const li = [...document.querySelectorAll(".docs li")].find((l) => l.querySelector(".name")?.textContent.includes("혼잡")); li?.querySelector("[data-toggle]")?.click(); })()`); await sleep(1500);
  await fullPage("page_action", 1920, ZONES(`[
    ["조치 대상 (심각도 순)", "#app section.card:has(.targets)", false],
    ["#", ".targets li", true, "'조치 대상 · ' + (e.querySelector('.name')?.textContent || '')"],
    ["조치요청서 · 처리 현황", "#app section.card:has(.docs)", false],
    ["#", ".docs > li", true, "'요청서 · ' + (e.querySelector('.name')?.textContent || '')"],
    ["조치요청서 미리보기 (종이)", ".docs li.open .paper", false],
    ["처리 상태 버튼 (요청·조치중·완료)", ".docs li.open .seg", false]]`));
  // ── AI 동작 보기 4개 탭 (패널만, 내부 스크롤 없이 끝까지) ─────────────
  await go(`${base}/#control`, 1920, `document.querySelectorAll(".icard").length > 0`);
  await ev(`(() => { if (!document.body.classList.contains("dev-open")) document.getElementById("dev-toggle").click(); })()`); await sleep(3500);
  for (const [tab, file] of [["log", "page_dev_log"], ["cls", "page_dev_cls"], ["sev", "page_dev_sev"], ["stat", "page_dev_state"]]) {
    await ev(`document.querySelector('[data-tab="${tab}"]')?.click()`); await sleep(1800);
    // 패널 높이를 내용만큼 늘려 한 장으로 — 찍은 뒤 되돌린다
    await ev(`(() => { const p = document.getElementById("dev-panel"), b = document.getElementById("dev-body"); window.__ps = [p.style.cssText, b.style.cssText]; p.style.cssText += ";position:absolute;top:0;bottom:auto;height:auto;right:0"; b.style.cssText += ";overflow:visible;max-height:none;flex:none"; })()`);
    await sleep(600);
    const ph = Math.ceil(await ev(`document.getElementById("dev-panel").getBoundingClientRect().height`));
    await metrics(1920, Math.max(1080, ph + 40)); await sleep(1200);
    const rect = await ev(`(() => { const r = document.getElementById("dev-panel").getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.ceil(r.height) }; })()`);
    // 구역 좌표는 패널 왼쪽 위를 (0,0)으로 (PNG 와 같은 좌표계)
    const zjs = `(${ZONES(`[
      ["머리 (제목·연결 상태)", ".dev-head", false],
      ["탭", ".dev-tabs", false],
      ["다섯 에이전트 흐름", ".dev-flow", false],
      ["도구 줄 (일시정지·줄 수)", ".dev-tools", false],
      ["목록 (항목마다 한 줄)", "#dev-body .dev-list", false],
      ["표", "#dev-body .dev-table", false]]`)}).map((z) => ({ ...z, x: z.x - ${rect.x}, y: z.y - ${rect.y} }))`;
    await save(file, 1920, rect.h, zjs, rect);
    await ev(`(() => { const p = document.getElementById("dev-panel"), b = document.getElementById("dev-body"); p.style.cssText = window.__ps[0]; b.style.cssText = window.__ps[1]; })()`);
    await metrics(1920, 1080); await sleep(500);
  }
  // ── 폰 접수 화면 ───────────────────────────────────────────────────
  await go(`${base}/?v=qr`, 390, `!!document.querySelector("#rf")`);
  await fullPage("page_phone", 390, ZONES(`[
    ["제목 · 안내 문구", ".rp > h1, .rp > .rp-lead", true, "e.textContent"],
    ["구역 선택", ".rp-zone", false],
    ["민원 입력", ".rp-field", false],
    ["개인정보 안내", ".rp-hint", false],
    ["접수하기 버튼", ".rp-bar", false],
    ["이런 것을 알려 주세요", ".rp-ex", false],
    ["자주 묻는 질문", ".rp-faq", false],
    ["맺음말", ".rp-foot", false]]`));
  await quitChrome(o.chrome, o.ws);
}
try { await main(); } catch (e) { console.error(e); process.exitCode = 1; } finally { kids.forEach(killTree); await sleep(500); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 파일 잠김 */ } process.exit(process.exitCode ?? 0); }
