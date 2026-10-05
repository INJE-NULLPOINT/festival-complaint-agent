// 영상 편집용 원본 녹화 — OS 화면 녹화(ddagrab, 60fps)판. 제품 코드는 건드리지 않는다.
//   node 제출_준비/최종/_record_os.ts [--llm local|claude_code] [--outdir <폴더>] [--no-captures]
// 보조 모니터(DISPLAY2, X=166 Y=-1440, 2560x1440)에 헤드풀 Chrome 을 kiosk 로 띄우고 ffmpeg ddagrab 으로 그 모니터만 녹화한다 (주 모니터는 건드리지 않는다).
//  · rec_pc.mp4     Chrome 창 CSS 1280x720 · DSF 2 → 2560x1440 을 1920x1080 으로 (QSV 하드웨어 스케일), 60fps, 다크, 오버레이 없음
//  · rec_phone.mp4  별도 kiosk 창(DSF 1.7, CSS 390x844 → 663x1435)을 780x1688 로 키워 60fps — PC 녹화가 끝난 뒤 찍는 별도 테이크 (폰 입력 장면, 같은 문장이라 서버가 같은 접수로 합친다)
//  · rec_pc_marks.txt  동작별 초 (rec_pc 기준) · 폰 테이크 정보
//  · cap_*.png (3840x2160) · page/*.png+json (전체 페이지, 구역 좌표) · agent_log.json — 같은 세션 끝의 같은 데이터 상태로, 헤드리스 탭에서
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { freePort, killTree, openChrome, quitChrome } from "../../festival_agent/tests/ui/lib.ts";

const HERE = import.meta.dirname;
const APP = path.resolve(HERE, "..", "..", "festival_agent");
const { values: A } = parseArgs({ options: { llm: { type: "string", default: "claude_code" }, outdir: { type: "string" }, "no-captures": { type: "boolean", default: false }, keep: { type: "boolean", default: false } } });
const LLM = A.llm as string;
const OUTDIR = path.resolve(A.outdir ?? path.join(HERE, "_영상편집", "src"));
const PAGEDIR = path.join(OUTDIR, "page");
const DB = path.join(APP, "output", "demo_festival.db");
const FFMPEG = process.env.FFMPEG ?? path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-9.0.2-full_build", "bin", "ffmpeg.exe");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const MON = { x: 166, y: -1440, w: 2560, h: 1440 };           // DISPLAY2
const tmp = mkdtempSync(path.join(tmpdir(), "demo-os-"));
mkdirSync(OUTDIR, { recursive: true }); mkdirSync(PAGEDIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<any> | any, ms = 10000, step = 200) => { const t0 = Date.now(); for (;;) { let v: any = null; try { v = await fn(); } catch { /* 아직 */ } if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const kids: ChildProcess[] = [];

// ── 보조 모니터의 ddagrab 출력 번호 찾기 (2560x1440 인 것 — 화면 내용은 저장하지 않고 크기만 본다) ──────────
function findOutputIdx(): number {
  for (let i = 0; i < 4; i++) {
    const r = spawnSync(FFMPEG, ["-hide_banner", "-f", "lavfi", "-i", `ddagrab=output_idx=${i}:framerate=10:draw_mouse=0`, "-frames:v", "1", "-vf", "hwdownload,format=bgra", "-f", "null", "-"], { encoding: "utf-8" });
    const m = /Video: [^\n]*?(\d{3,5})x(\d{3,5})/.exec(r.stderr ?? "");
    if (m && Number(m[1]) === MON.w && Number(m[2]) === MON.h) return i;
  }
  throw new Error("2560x1440 출력을 찾지 못함 (보조 모니터가 켜져 있는지 확인)");
}

// ── 헤드풀 Chrome kiosk 를 보조 모니터에 ───────────────────────────────
type Page = { snd: (m: string, p?: Record<string, any>) => Promise<any>; ev: (e: string) => Promise<any>; proc: ChildProcess; close: () => Promise<void> };
async function kiosk(url: string, dsf: number): Promise<Page> {
  const port = await freePort();
  const proc = spawn(CHROME, ["--kiosk", `--window-position=${MON.x},${MON.y}`, `--window-size=${MON.w},${MON.h}`, `--force-device-scale-factor=${dsf}`,
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "kiosk-"))}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "--disable-infobars",
    "--disable-features=Translate", "about:blank"], { stdio: "ignore" });
  const tab = await until(async () => { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); return t.find((x: any) => x.type === "page"); }, 15000, 300);
  if (!tab) throw new Error("kiosk Chrome 연결 실패");
  const w = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => w.addEventListener("open", r));
  let id = 0; const pend = new Map<number, (v: any) => void>();
  w.addEventListener("message", (e) => { const m = JSON.parse(e.data as string); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result ?? m.error); pend.delete(m.id); } });
  const snd = (method: string, params: Record<string, any> = {}) => new Promise<any>((res) => { const n = ++id; pend.set(n, res); w.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expr: string) => (await snd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await snd("Page.enable");
  await snd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await snd("Page.navigate", { url });
  return { snd, ev, proc, close: async () => { try { w.send(JSON.stringify({ id: 999999, method: "Browser.close" })); } catch { /* */ } await sleep(800); killTree(proc); } };
}

// ── ddagrab 녹화 ───────────────────────────────────────────────────────
function startGrab(idx: number, out: string, crop: { w: number; h: number } | null, outW: number, outH: number) {
  const src = `ddagrab=output_idx=${idx}:framerate=60:draw_mouse=0${crop ? `:video_size=${crop.w}x${crop.h}:offset_x=0:offset_y=0` : ""}`;
  const p = spawn(FFMPEG, ["-y", "-f", "lavfi", "-i", src, "-vf", `hwmap=derive_device=qsv,format=qsv,scale_qsv=w=${outW}:h=${outH}`, "-c:v", "h264_qsv", "-global_quality", "18", "-g", "120", out], { stdio: ["pipe", "ignore", "pipe"] });
  let log = "", first: number | null = null;
  p.stderr!.on("data", (d) => { log += d; if (first === null && /frame=\s*\d+/.test(String(d))) first = Date.now(); });
  return {
    started: async () => { await until(() => first, 10000, 50); return first ?? Date.now(); },
    stop: async () => {
      p.stdin!.write("q"); await Promise.race([new Promise((r) => p.on("exit", r)), sleep(15000)]);
      if (p.exitCode === null) killTree(p);
      const m = [...log.matchAll(/frame=\s*(\d+) fps=\s*([\d.]+).*?time=([\d:.]+).*?dup=(\d+) drop=(\d+)/g)].pop();
      return m ? { frames: Number(m[1]), time: m[3], dup: Number(m[4]), drop: Number(m[5]) } : null;
    },
  };
}

async function main() {
  for (const k of ["SUPABASE_DB_URL", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) process.env[k] = "";
  process.env.DB_PATH = DB; process.env.DOCS_DIR = path.join(tmp, "docs");
  const env = { ...process.env, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", DB_PATH: DB, LLM_BACKEND: LLM, DOCS_DIR: path.join(tmp, "docs"), PYTHONIOENCODING: "utf-8", VITE_NO_WATCH: "1" };
  const idx = findOutputIdx();
  console.log(`[녹화] 백엔드 ${LLM} · 보조 모니터 출력 번호 ${idx} · 출력 ${OUTDIR}`);
  const reset = spawnSync(process.execPath, ["server/scripts/demo_scenario.ts", "--reset", "--no-wait"], { cwd: APP, env: env as any, encoding: "utf-8" });
  if (reset.status !== 0) throw new Error("demo_scenario 실패\n" + reset.stdout + reset.stderr);
  const ap = await freePort(), vp = await freePort();
  kids.push(spawn(process.execPath, ["server/worker.ts", "--agent-interval", "20"], { cwd: APP, env: env as any, stdio: "ignore" }));
  kids.push(spawn(process.execPath, ["server/webapi.ts", "--port", String(ap)], { cwd: APP, env: env as any, stdio: "ignore" }));
  kids.push(spawn(process.execPath, [path.join(APP, "web/node_modules/vite/bin/vite.js"), "--port", String(vp), "--strictPort", "--host", "127.0.0.1"], { cwd: path.join(APP, "web"), env: { ...env, WEBAPI_PORT: String(ap) } as any, stdio: "ignore" }));
  const base = `http://127.0.0.1:${vp}`;
  const get = async (p: string) => (await (await fetch(base + p)).json()).data;
  const rpc = (name: string, body: any) => fetch(`${base}/api/rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!(await until(async () => (await fetch(`${base}/api/control`)).ok, 40000, 400))) throw new Error("서버가 뜨지 않음");
  if (!(await until(async () => { const c = await get("/api/control"); return c.total >= 24 && c.pending === 0 && c.issues.length > 0 && !!c.briefing; }, 360000, 1500))) throw new Error("배경 분류가 끝나지 않음");
  await sleep(15000);
  const zones = await get("/api/zones");
  const zid = (n: string) => zones.find((z: any) => z.name.includes(n)).id;
  const dbmod: any = await import(pathToFileURL(path.join(APP, "server", "core", "db.ts")).href);
  const iso = (d: Date) => { const p = (x: number) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const CROWD = ["유등터널 안에서 사람들이 한꺼번에 몰려서 앞으로 나갈 수가 없어요", "터널 입구에 사람이 계속 들어와서 안쪽이 너무 붐비고 떠밀려요"];
  const PHONE_TEXT = "진주교 아래 산책로 조명이 꺼져서 깜깜하고 계단에서 넘어질 뻔했어요";
  const KO: Record<string, string> = { crowd: "혼잡", safety: "안전", parking: "주차", price: "가격", restroom: "화장실", guide: "안내" };

  // ══ 1. PC 테이크 (보조 모니터 kiosk, ddagrab 60fps) ═════════════════════════════
  const pc = await kiosk(`${base}/#control`, 2);
  await until(() => pc.ev(`document.querySelectorAll(".icard").length > 0`), 30000);
  await pc.ev(`try { localStorage.removeItem("festival_dev_view"); } catch (e) {}`);
  await pc.snd("Page.reload"); await until(() => pc.ev(`document.querySelectorAll(".icard").length > 0`), 30000);
  console.log("[PC] 화면:", await pc.ev(`innerWidth + "x" + innerHeight + " dpr" + devicePixelRatio`));
  await sleep(2000);
  const click = (sel: string) => pc.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const slowScroll = (y: number, ms = 1800) => pc.ev(`new Promise((res) => { const y0 = window.scrollY, y1 = ${y}, t0 = performance.now(); const step = (t) => { const k = Math.min(1, (t - t0) / ${ms}); window.scrollTo(0, y0 + (y1 - y0) * (k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)); k < 1 ? requestAnimationFrame(step) : res(true); }; requestAnimationFrame(step); })`);
  const topOf = (js: string) => pc.ev(`(() => { const e = ${js}; return e ? Math.round(e.getBoundingClientRect().top + window.scrollY) : -1; })()`);
  const pcRaw = path.join(tmp, "pc_raw.mp4");
  const grab = startGrab(idx, pcRaw, null, 1920, 1080);
  const T0 = await grab.started();
  const now = () => (Date.now() - T0) / 1000;
  const marks: string[] = [];
  const mark = (name: string) => { marks.push(`${now().toFixed(1)}\t${name}`); console.log(`[장면] ${now().toFixed(1)}s ${name}`); };
  const pause = () => sleep(3500);
  mark("① 관제 그대로"); await sleep(5000); await pause();
  mark("② AI 동작 보기 열기 (실시간 로그)"); await click("#dev-toggle"); await sleep(5000);
  mark("② 심각도 탭 (계산식)"); await click('[data-tab="sev"]'); await sleep(5000);
  mark("② 실시간 로그 복귀"); await click('[data-tab="log"]'); await sleep(3500);
  mark("③ 폰 입력 시점 (PC: 실시간 유입 피드)");
  await slowScroll(Math.max(0, (await topOf(`document.querySelector(".feed")`)) - 110), 2000);
  const submitAt = now();
  await rpc("submit_feedback", { p_zone_id: zid("진주교"), p_text: PHONE_TEXT });
  mark("③ 폰 제출 (rec_phone 의 '제출' 장면과 같은 시점)");
  const label = await until(async () => { const c = await get("/api/control"); const f = c.feed.find((x: any) => String(x.raw_text).includes("산책로 조명")); return f?.label && f.status === "done" ? f.label : null; }, 150000, 500);
  mark(`③ 산책로 민원 분류됨: ${label ?? "시간 안에 안 붙음"}`);
  await sleep(5000); await pause();
  mark("④ 혼잡 2건 입력 (PC: 유입 피드)");
  await dbmod.insert_feedback(zid("유등터널"), CROWD[0], "demo", iso(new Date()));
  await sleep(8000);
  await dbmod.insert_feedback(zid("유등터널"), CROWD[1], "demo", iso(new Date()));
  const crowdTop = await until(async () => { const c = await get("/api/control"); const i = c.issues[0]; return i && i.label === "crowd" && i.zone_name === "유등터널" ? i : null; }, 180000, 1000);
  mark(`④ 혼잡 카드 ${crowdTop ? "1위로 올라옴" : "1위가 되지 않음(시간 초과)"}`);
  await slowScroll(Math.max(0, (await topOf(`document.querySelector(".icards")`)) - 110), 2200);
  await sleep(5000); await pause();
  mark("⑤ 조치 화면"); await click("#dev-toggle"); await sleep(800);
  await pc.ev(`window.scrollTo(0, 0); location.hash = "#action"`);
  await until(() => pc.ev(`!!document.querySelector(".docs li, .targets li")`), 10000); await sleep(2500);
  const findLi = `[...document.querySelectorAll(".docs li")].find((l) => l.querySelector(".name")?.textContent.includes("혼잡"))`;
  if (!(await until(() => pc.ev(`!!(${findLi})`), 40000, 500))) {
    await pc.ev(`(() => { const li = [...document.querySelectorAll(".targets li")].find((l) => l.textContent.includes("혼잡")); li?.querySelector("[data-gen]")?.click(); })()`);
    marks.push(`${now().toFixed(1)}\t(자동 요청서가 아직 없어 [조치요청서 생성]을 눌렀음)`);
    await until(() => pc.ev(`!!(${findLi})`), 60000, 500);
  }
  await pause();
  mark("⑤ 혼잡 조치요청서 펼치기");
  await pc.ev(`(${findLi})?.querySelector("[data-toggle]")?.click()`); await sleep(1200);
  await slowScroll(Math.max(0, (await topOf(findLi)) - 90), 2000); await sleep(5000);
  await slowScroll((await topOf(findLi)) + 260, 3500); await sleep(2500); await pause();
  mark("⑥ 조치중 버튼이 화면에 보임");
  await slowScroll(Math.max(0, (await topOf(findLi)) - 90), 1800); await sleep(2500);
  mark("⑥ '조치중' 클릭");
  await pc.ev(`(${findLi})?.querySelector('[data-status="in_progress"]')?.click()`); await sleep(4500); await pause();
  mark("⑦ 관제 복귀");
  await pc.ev(`window.scrollTo(0, 0); location.hash = "#control"`); await sleep(1500);
  const sync = await until(async () => { const c = await get("/api/control"); const t = c.issues.find((i: any) => i.grp === "main") ?? c.issues[0]; return !!(t && c.briefing && String(c.briefing.text).includes(KO[t.label] ?? "§")); }, 45000, 1000);
  mark(`⑦ 브리핑 ${sync ? "갱신됨" : "(45초 안에 맞춰지지 않음)"}`); await sleep(5000);
  mark("끝");
  const pcStat = await grab.stop();
  await pc.close();
  renameSync(pcRaw, path.join(OUTDIR, "rec_pc.mp4"));
  console.log("[PC 녹화]", JSON.stringify(pcStat));

  // ══ 2. 캡처 · 전체 페이지 (헤드리스, 같은 서버·같은 데이터 상태 — 폰 테이크 전에) ══════════
  if (!A["no-captures"]) {
    try {
      const crowdDoc = (await get("/api/action")).actions.find((a: any) => a.label === "crowd" && a.status !== "superseded");
      if (crowdDoc && crowdDoc.status !== "requested") await rpc("set_action_status", { p_id: crowdDoc.id, p_status: "requested" });
      await until(async () => { const c = await get("/api/control"); const i = c.issues[0]; return !!(i && i.label === "crowd" && c.briefing && String(c.briefing.text).includes(KO[i.label])); }, 60000, 1000);
      await sleep(3000);
      await captures(base, findLi);
    } catch (e) { console.log("[캡처 오류] " + (e as Error).message); }
  }
  // ══ 3. 폰 테이크 (별도 kiosk 창 DSF 1.7, CSS 390x844 → 663x1435 → 780x1688) ═══════════
  const ph = await kiosk(`${base}/?v=qr`, 1.7);
  await ph.snd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1.7, mobile: true });
  await ph.snd("Page.reload"); await until(() => ph.ev(`!!document.querySelector("#rf textarea")`), 20000); await sleep(1500);
  const pgrab = startGrab(idx, path.join(tmp, "phone_raw.mp4"), { w: 663, h: 1435 }, 780, 1688);
  const P0 = await pgrab.started();
  const pnow = () => (Date.now() - P0) / 1000;
  await sleep(1500);
  await ph.ev(`(() => { const s = document.querySelector('#rf select[name=zone]'); const o = [...s.options].find((x) => x.textContent.includes("진주교")); s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(1500);
  await ph.ev(`document.querySelector("#rf textarea").focus()`);
  for (let i = 1; i <= PHONE_TEXT.length; i++) { await ph.ev(`(() => { const t = document.querySelector("#rf textarea"); t.value = ${JSON.stringify(PHONE_TEXT.slice(0, i))}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`); await sleep(90); }
  await sleep(1500);
  const phSubmit = pnow();
  await ph.ev(`document.querySelector('#rf button[type=submit]').click()`);
  await until(() => ph.ev(`!!document.querySelector(".rp-modal[open], .rp-overlay")`), 8000);
  await sleep(4000);
  const phLen = pnow();
  const phStat = await pgrab.stop();
  await ph.close();
  renameSync(path.join(tmp, "phone_raw.mp4"), path.join(OUTDIR, "rec_phone.mp4"));
  console.log("[폰 녹화]", JSON.stringify(phStat));
  writeFileSync(path.join(OUTDIR, "rec_pc_marks.txt"), `# 초(rec_pc.mp4 기준)\t동작\n${marks.join("\n")}\n` +
    `# rec_phone.mp4: PC 녹화가 끝난 뒤 별도 kiosk 창(CSS 390x844, DSF 1.7 = 663x1435)에서 찍은 테이크를 780x1688 로 키운 것. 같은 문장이라 서버가 같은 접수로 합쳐 화면은 PC 테이크 ③ 과 같다.\n` +
    `# rec_phone 길이 ${phLen.toFixed(1)}초 · 제출 클릭 ${phSubmit.toFixed(1)}초(rec_phone 기준) ↔ PC 테이크의 같은 장면은 rec_pc ${submitAt.toFixed(1)}초(폰 제출) — 이 두 시점을 맞춰 합성하세요 (rec_phone 시작 = rec_pc ${(submitAt - phSubmit).toFixed(1)}초에 대응)\n` +
    `# 녹화 방식: OS 화면 녹화(ddagrab 60fps, h264_qsv). rec_pc ${JSON.stringify(pcStat)} · rec_phone ${JSON.stringify(phStat)}\n`);

  const d = new DatabaseSync(DB, { readOnly: true });
  const rows = d.prepare("SELECT id, created_at, agent, action, latency_ms FROM agent_log ORDER BY id").all() as any[];
  d.close();
  writeFileSync(path.join(OUTDIR, "agent_log.json"), JSON.stringify(rows.map((r) => ({ id: r.id, time: r.created_at, agent: r.agent, action: r.action, tool: r.action, ms: r.latency_ms })), null, 1));
  console.log(`[agent_log] ${rows.length}행`);
  console.log(`\n저장: ${OUTDIR}`);
}

// ── 헤드리스 캡처: cap_*.png (3840x2160) + page/*.png,json ───────────────────────
async function captures(base: string, findLi: string) {
  const o = await openChrome({ prefix: "os-cap-", width: 1920, height: 1080 });
  const { send, ev } = o;
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  const metrics = (w: number, h: number, dsf: number, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dsf, mobile });
  const panel = async (on: boolean) => { await ev(`(() => { if (document.body.classList.contains("dev-open") !== ${on}) document.getElementById("dev-toggle").click(); })()`); await sleep(1200); };
  const png = async (file: string, params: any = {}) => { const r = await send("Page.captureScreenshot", { format: "png", ...params }); writeFileSync(file, Buffer.from(r.data, "base64")); };
  const go = async (url: string, w: number, h: number, dsf: number, ready: string, mobile = false) => { await metrics(w, h, dsf, mobile); await send("Page.navigate", { url }); await until(() => ev(ready), 20000); await sleep(2500); };
  // ① cap_*.png — 1280x720 CSS, DSF 3 = 3840x2160
  await go(`${base}/#control`, 1280, 720, 3, `document.querySelectorAll(".icard").length > 0`);
  await ev(`try { localStorage.removeItem("festival_dev_view"); } catch (e) {}`);
  await panel(false); await panel(true); await sleep(3900); await png(path.join(OUTDIR, "cap_flow.png")); console.log("[캡처] cap_flow.png");
  await ev(`document.querySelector('[data-tab="sev"]')?.click()`); await sleep(1500); await png(path.join(OUTDIR, "cap_score.png")); console.log("[캡처] cap_score.png");
  await panel(false); await ev(`window.scrollTo(0, 0)`); await sleep(900); await png(path.join(OUTDIR, "cap_brief.png")); console.log("[캡처] cap_brief.png");
  await ev(`(() => { const c = [...document.querySelectorAll(".icard")].find((e) => e.textContent.includes("유등터널") && e.textContent.includes("혼잡")) ?? document.querySelector(".icards"); window.scrollTo(0, c.getBoundingClientRect().top + window.scrollY - 40); })()`); await sleep(900); await png(path.join(OUTDIR, "cap_card.png")); console.log("[캡처] cap_card.png");
  await ev(`location.hash = "#action"`); await until(() => ev(`!!(${findLi})`), 20000);
  await ev(`(${findLi})?.querySelector("[data-toggle]")?.click()`); await sleep(900);
  await ev(`(() => { const li = ${findLi}; window.scrollTo(0, li.getBoundingClientRect().top + window.scrollY - 24); })()`); await sleep(900); await png(path.join(OUTDIR, "cap_doc.png")); console.log("[캡처] cap_doc.png");

  // ② page/*.png + json — 뷰포트 폭 1920 (폰 390), DSF 2, 세로는 끝까지
  const docH = () => ev(`Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))`);
  const ZONES = (list: string) => `(() => { const out = []; const sy = window.scrollY, sx = window.scrollX; for (const [name, sel, all, nameJs] of ${list}) { const els = all ? [...document.querySelectorAll(sel)] : [document.querySelector(sel)]; els.forEach((e, i) => { if (!e) return; const r = e.getBoundingClientRect(); if (!r.width || !r.height) return; const nm = nameJs ? String(new Function("e", "i", "return " + nameJs)(e, i) || name) : (all ? name.replace("#", String(i + 1)) : name); out.push({ name: nm.trim().split(/\\s+/).join(" "), selector: all ? sel + ":nth-of-type(" + (i + 1) + ")" : sel, x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) }); }); } return out.sort((a, b) => a.y - b.y || a.x - b.x); })()`;
  const save = async (name: string, w: number, h: number, zonesJs: string, clip?: { x: number; y: number; w: number; h: number }) => {
    await png(path.join(PAGEDIR, `${name}.png`), clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 } } : {});
    const z = await ev(zonesJs);
    writeFileSync(path.join(PAGEDIR, `${name}.json`), JSON.stringify({ file: `${name}.png`, note: "좌표는 CSS px (PNG 는 가로세로 2배). origin 은 PNG 왼쪽 위가 페이지의 어디인지", cssWidth: clip ? clip.w : w, cssHeight: clip ? clip.h : h, scale: 2, origin: clip ? { x: clip.x, y: clip.y } : { x: 0, y: 0 }, zones: z }, null, 1));
    console.log(`[페이지] ${name}.png · css ${clip ? clip.w : w}x${clip ? clip.h : h} · 구역 ${z.length}`);
  };
  const fullPage = async (name: string, w: number, zonesJs: string) => {
    await ev(`window.scrollTo(0, 0)`); await sleep(500);
    let h = await docH();
    for (let k = 0; k < 3; k++) { await metrics(w, h, 2, w < 600); await sleep(900); const h2 = await docH(); if (h2 === h) break; h = h2; }
    await save(name, w, h, zonesJs);
    await metrics(w, 1080, 2, w < 600);
  };
  await go(`${base}/#control`, 1920, 1080, 2, `document.querySelectorAll(".icard").length > 0`);
  await panel(false);
  await fullPage("page_control", 1920, ZONES(`[
    ["요약 숫자 4칸", ".kpis", false],
    ["#", ".kpis .kpi", true, "e.querySelector('.kpi-l')?.textContent"],
    ["지금 조치할 일 (브리핑)", ".card.brief", false],
    ["#번 카드", ".icards .icard", true, "(i + 1) + '번 카드 · ' + (e.querySelector('h3, .ic-title, .ic-name')?.textContent || '')"],
    ["#", "details.igrp", true, "e.querySelector('summary')?.textContent"],
    ["유형별 순위", "details.typerank", false],
    ["실시간 유입", "#app section.card:has(.feed)", false]]`));
  await go(`${base}/#action`, 1920, 1080, 2, `document.querySelectorAll(".docs li, .targets li").length > 0`);
  await ev(`(${findLi})?.querySelector("[data-toggle]")?.click()`); await sleep(1500);
  await fullPage("page_action", 1920, ZONES(`[
    ["조치 대상 (심각도 순)", "#app section.card:has(.targets)", false],
    ["#", ".targets li", true, "'조치 대상 · ' + (e.querySelector('.name')?.textContent || '')"],
    ["조치요청서 · 처리 현황", "#app section.card:has(.docs)", false],
    ["#", ".docs > li", true, "'요청서 · ' + (e.querySelector('.name')?.textContent || '')"],
    ["조치요청서 미리보기 (종이)", ".docs li.open .paper", false],
    ["처리 상태 버튼 (요청·조치중·완료)", ".docs li.open .seg", false]]`));
  await go(`${base}/#control`, 1920, 1080, 2, `document.querySelectorAll(".icard").length > 0`);
  await panel(true); await sleep(2500);
  for (const [tab, file] of [["log", "page_dev_log"], ["cls", "page_dev_cls"], ["sev", "page_dev_sev"], ["stat", "page_dev_state"]]) {
    await ev(`document.querySelector('[data-tab="${tab}"]')?.click()`); await sleep(1800);
    await ev(`(() => { const p = document.getElementById("dev-panel"), b = document.getElementById("dev-body"); window.__ps = [p.style.cssText, b.style.cssText]; p.style.cssText += ";position:absolute;top:0;bottom:auto;height:auto;right:0"; b.style.cssText += ";overflow:visible;max-height:none;flex:none"; })()`);
    await sleep(600);
    const ph = Math.ceil(await ev(`document.getElementById("dev-panel").getBoundingClientRect().height`));
    await metrics(1920, Math.max(1080, ph + 40), 2); await sleep(1200);
    const rect = await ev(`(() => { const r = document.getElementById("dev-panel").getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.ceil(r.height) }; })()`);
    const zjs = `(${ZONES(`[
      ["머리 (제목·연결 상태)", ".dev-head", false],
      ["탭", ".dev-tabs", false],
      ["다섯 에이전트 흐름", ".dev-flow", false],
      ["도구 줄 (일시정지·줄 수)", ".dev-tools", false],
      ["목록 (항목마다 한 줄)", "#dev-body .dev-list", false],
      ["표", "#dev-body .dev-table", false]]`)}).map((z) => ({ ...z, x: z.x - ${rect.x}, y: z.y - ${rect.y} }))`;
    await save(file, 1920, rect.h, zjs, rect);
    await ev(`(() => { const p = document.getElementById("dev-panel"), b = document.getElementById("dev-body"); p.style.cssText = window.__ps[0]; b.style.cssText = window.__ps[1]; })()`);
    await metrics(1920, 1080, 2); await sleep(500);
  }
  await go(`${base}/?v=qr`, 390, 1080, 2, `!!document.querySelector("#rf")`, true);
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

try { await main(); } catch (e) { console.error(e); process.exitCode = 1; } finally { kids.forEach(killTree); await sleep(500); if (!A.keep) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 파일 잠김 */ } process.exit(process.exitCode ?? 0); }
