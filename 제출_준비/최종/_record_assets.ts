// 영상 편집용 원본 녹화 (총괄 전달: [영상] 요청 목록) — 제품 코드는 건드리지 않는다.
//   node 제출_준비/최종/_record_assets.ts [--llm local|claude_code] [--outdir <폴더>] [--keep]
// 산출물(기본 _영상편집/src/): rec_pc.mp4 · rec_pc_marks.txt · rec_phone.mp4 · cap_flow/score/card/doc/brief.png · agent_log.json
//  · rec_pc.mp4    PC 화면 1920x1080 60fps 타임라인 (CSS 1280x720 + DSF 1.5), 다크, 자막·폰 오버레이·확대 없음, 동작 사이 3~4초 멈춤
//  · rec_phone.mp4 ?v=qr 390x844 DSF 2 (780x1688) 60fps 타임라인, 폰 틀 없이 화면만 — PC 녹화와 같은 세션에서 찍고 시작 시각을 marks 에 적는다
//  · cap_*.png     3840x2160 (DSF 3) 오버레이 없음 — 영상 탭과 다른 탭에서, 녹화가 끝난 뒤 같은 데이터 상태로
//  · agent_log.json  그 세션 시연 DB 의 agent_log (agent, action=tool, 시각, ms)
// 데이터: output/demo_festival.db (demo_scenario.ts --reset --no-wait), SUPABASE_* 빈 값, DOCS_DIR 임시.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { freePort, killTree, openChrome, quitChrome } from "../../festival_agent/tests/ui/lib.ts";

const HERE = import.meta.dirname;
const APP = path.resolve(HERE, "..", "..", "festival_agent");
const { values: A } = parseArgs({ options: { llm: { type: "string", default: "local" }, outdir: { type: "string" }, keep: { type: "boolean", default: false } } });
const LLM = A.llm as string;
const OUTDIR = path.resolve(A.outdir ?? path.join(HERE, "_영상편집", "src"));
const DB = path.join(APP, "output", "demo_festival.db");
const FFMPEG = process.env.FFMPEG ?? path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-9.0.2-full_build", "bin", "ffmpeg.exe");
const FPS = 60, W = 1280, H = 720;          // 출력 프레임률. captureScreenshot 은 초당 60장을 못 따라가므로, 실제로 얻은 고유 프레임 수(초당)를 따로 센다
const tmp = mkdtempSync(path.join(tmpdir(), "demo-assets-"));
mkdirSync(OUTDIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<any> | any, ms = 10000, step = 200) => { const t0 = Date.now(); for (;;) { let v: any = null; try { v = await fn(); } catch { /* 아직 */ } if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };

const kids: ChildProcess[] = [];
let chrome: ChildProcess | null = null; let mainWs: WebSocket | null = null;
async function cleanup() {
  if (chrome) await quitChrome(chrome, mainWs).catch(() => {});
  for (const k of kids) killTree(k);
  await sleep(500);
  if (!A.keep) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 파일 잠김 */ }
}
const baseEnv = { ...process.env, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "",
  DB_PATH: DB, LLM_BACKEND: LLM, DOCS_DIR: path.join(tmp, "docs"), PYTHONIOENCODING: "utf-8" };
function run(label: string, args: string[], env: Record<string, string | undefined>, cwd = APP): ChildProcess {
  const c = spawn(process.execPath, args, { cwd, env: env as any, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout!.on("data", (d) => process.stdout.write(`[${label}] ${d}`.replace(/\n(?=.)/g, `\n[${label}] `)));
  c.stderr!.on("data", (d) => process.stderr.write(`[${label}!] ${d}`));
  kids.push(c);
  return c;
}

// ── 탭(타깃) 하나를 CDP 로 다룬다 ─────────────────────────────────────
type Tab = { snd: (m: string, p?: Record<string, any>) => Promise<any>; ev: (e: string) => Promise<any>; close: () => Promise<void> };
let DPORT = 0;
async function openTab(url: string, o: { w: number; h: number; dsf: number; mobile?: boolean }): Promise<Tab> {
  const t = await (await fetch(`http://127.0.0.1:${DPORT}/json/new?${url}`, { method: "PUT" })).json();
  const w = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => w.addEventListener("open", r));
  let id = 0; const pend = new Map<number, (v: any) => void>();
  w.addEventListener("message", (e) => { const m = JSON.parse(e.data as string); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result ?? m.error); pend.delete(m.id); } });
  const snd = (method: string, params: Record<string, any> = {}) => new Promise<any>((res) => { const n = ++id; pend.set(n, res); w.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expr: string) => (await snd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await snd("Page.enable");
  await snd("Emulation.setDeviceMetricsOverride", { width: o.w, height: o.h, deviceScaleFactor: o.dsf, mobile: !!o.mobile });
  await snd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  return { snd, ev, close: async () => { try { w.close(); } catch { /* */ } await fetch(`http://127.0.0.1:${DPORT}/json/close/${t.id}`).catch(() => {}); } };
}

const stats: Record<string, { secs: number; unique: number; uniqueFps: number }> = {};
// ── 녹화기: captureScreenshot 을 계속 찍고(고유 프레임만 저장), 찍힌 시각대로 길이를 줘서 FPS 로 맞춘다 ──────────
function startRecorder(snd: Tab["snd"], name: string, quality: number) {
  const dir = path.join(tmp, name); mkdirSync(dir);
  const ts: number[] = [];
  let going = true;
  const t0 = Date.now();
  const loop = (async () => {
    while (going) {
      const r = await snd("Page.captureScreenshot", { format: "jpeg", quality });
      if (r?.data) { writeFileSync(path.join(dir, `f${String(ts.length).padStart(6, "0")}.jpg`), Buffer.from(r.data, "base64")); ts.push(Date.now()); }
    }
  })();
  return {
    t0,
    stop: async (outFile: string) => {
      going = false; await loop;
      const end = Date.now();
      // concat 목록: 프레임마다 다음 프레임이 찍힐 때까지의 시간만큼 보여 준다 (첫 프레임은 녹화 시작부터)
      const lines: string[] = [];
      for (let i = 0; i < ts.length; i++) {
        const from = i === 0 ? t0 : ts[i - 1], to = i === ts.length - 1 ? end : ts[i];
        lines.push(`file '${path.join(dir, `f${String(i).padStart(6, "0")}.jpg`).split(path.sep).join("/")}'`, `duration ${Math.max(0.001, (to - from) / 1000).toFixed(4)}`);
      }
      lines.push(`file '${path.join(dir, `f${String(ts.length - 1).padStart(6, "0")}.jpg`).split(path.sep).join("/")}'`);
      const list = path.join(dir, "list.txt"); writeFileSync(list, lines.join("\n"));
      const ff = spawnSync(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=${FPS}`,
        "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outFile], { encoding: "utf-8" });
      if (ff.status !== 0) throw new Error("ffmpeg 실패\n" + ff.stderr.slice(-600));
      const secs = (end - t0) / 1000;
      console.log(`[녹화기] ${name}: ${secs.toFixed(1)}초 · 고유 프레임 ${ts.length}장 = 초당 ${(ts.length / secs).toFixed(1)}장 (${FPS}fps 로 맞추려고 직전 프레임을 반복해 늘림)`);
      stats[name] = { secs, unique: ts.length, uniqueFps: ts.length / secs };
      return secs;
    },
  };
}

async function main() {
  for (const k of ["SUPABASE_DB_URL", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) process.env[k] = "";
  process.env.DB_PATH = DB; process.env.DOCS_DIR = path.join(tmp, "docs");
  console.log(`[녹화] 백엔드 ${LLM} · 출력 ${OUTDIR}`);
  const reset = spawnSync(process.execPath, ["server/scripts/demo_scenario.ts", "--reset", "--no-wait"], { cwd: APP, env: baseEnv as any, encoding: "utf-8" });
  if (reset.status !== 0) throw new Error("demo_scenario 실패\n" + reset.stdout + reset.stderr);

  const apiPort = await freePort(), vitePort = await freePort();
  run("worker", ["server/worker.ts", "--agent-interval", "20"], baseEnv);
  run("webapi", ["server/webapi.ts", "--port", String(apiPort)], baseEnv);
  run("vite", [path.join(APP, "web", "node_modules", "vite", "bin", "vite.js"), "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"],
    { ...baseEnv, WEBAPI_PORT: String(apiPort), VITE_NO_WATCH: "1" }, path.join(APP, "web"));
  const base = `http://127.0.0.1:${vitePort}`;
  const get = async (p: string) => (await (await fetch(base + p)).json()).data;
  if (!(await until(async () => (await fetch(`${base}/api/control`)).ok, 40000, 400))) throw new Error("서버가 뜨지 않음");
  const ready = await until(async () => { const c = await get("/api/control"); return c.total >= 24 && c.pending === 0 && c.issues.length > 0 && !!c.briefing && c; }, 360000, 1500);
  if (!ready) throw new Error("배경 분류가 끝나지 않음");
  console.log(`[녹화] 배경 준비 완료: 접수 ${ready.total} · 카드 ${ready.issues.length}장`);
  await sleep(15000);

  const dbmod: any = await import(pathToFileURL(path.join(APP, "server", "core", "db.ts")).href);
  const iso = (d: Date) => { const p = (x: number) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const tunnel = (await dbmod.zones()).find((z: any) => z.name === "유등터널").id;
  const CROWD = ["유등터널 안에서 사람들이 한꺼번에 몰려서 앞으로 나갈 수가 없어요", "터널 입구에 사람이 계속 들어와서 안쪽이 너무 붐비고 떠밀려요"];
  const PHONE_TEXT = "진주교 아래 산책로 조명이 꺼져서 깜깜하고 계단에서 넘어질 뻔했어요";

  // ── PC 탭 (openChrome 의 첫 탭을 쓴다) ────────────────────────────
  const o = await openChrome({ prefix: "assets-", width: W, height: H });
  chrome = o.chrome; mainWs = o.ws;
  DPORT = Number(o.chrome.spawnargs.find((a) => a.startsWith("--remote-debugging-port="))!.split("=")[1]);
  const pc: Tab = { snd: o.send, ev: o.ev, close: async () => {} };
  await pc.snd("Page.enable");
  await pc.snd("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1.5, mobile: false });
  await pc.snd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await pc.snd("Page.navigate", { url: `${base}/#control` });
  await until(() => pc.ev(`document.querySelectorAll(".icard").length > 0`), 20000);
  await pc.ev(`try { localStorage.removeItem("festival_dev_view"); } catch (e) {}`);
  await pc.snd("Page.reload"); await until(() => pc.ev(`document.querySelectorAll(".icard").length > 0`), 20000);
  await sleep(1500);

  const click = (sel: string) => pc.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  /** 천천히 스크롤 (ms 동안 일정하게) */
  const slowScroll = (y: number, ms = 1800) => pc.ev(`new Promise((res) => { const y0 = window.scrollY, y1 = ${y}, t0 = performance.now(); const step = (t) => { const k = Math.min(1, (t - t0) / ${ms}); window.scrollTo(0, y0 + (y1 - y0) * (k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)); k < 1 ? requestAnimationFrame(step) : res(true); }; requestAnimationFrame(step); })`);
  const topOf = (js: string) => pc.ev(`(() => { const e = ${js}; return e ? Math.round(e.getBoundingClientRect().top + window.scrollY) : -1; })()`);
  const pcMarks: string[] = [];
  let rec: ReturnType<typeof startRecorder>;
  const now = () => (Date.now() - rec.t0) / 1000;
  const mark = (name: string) => { pcMarks.push(`${now().toFixed(1)}\t${name}`); console.log(`[장면] ${now().toFixed(1)}s ${name}`); };
  const pause = () => sleep(3500);

  rec = startRecorder(pc.snd, "pc", 92);
  // ① 관제 그대로 5초
  mark("① 관제 그대로"); await sleep(5000); await pause();
  // ② AI 동작 보기 → 실시간 로그 5초 → 심각도 탭 5초 → 로그 복귀
  mark("② AI 동작 보기 열기 (실시간 로그)"); await click("#dev-toggle"); await sleep(5000);
  mark("② 심각도 탭 (계산식)"); await click('[data-tab="sev"]'); await sleep(5000);
  mark("② 실시간 로그 복귀"); await click('[data-tab="log"]'); await sleep(3500);
  // ③ 폰 입력 → 피드에 「안전」
  mark("③ 폰 입력 시작 (PC: 실시간 유입 피드)");
  await slowScroll(Math.max(0, (await topOf(`document.querySelector(".feed")`)) - 110), 2000);
  let phoneOffset = -1, phoneLen = 0;
  const phoneFlow = (async () => {
    const ph = await openTab(`${base}/?v=qr`, { w: 390, h: 844, dsf: 2, mobile: true });
    try {
      await until(() => ph.ev(`!!document.querySelector("#rf textarea")`), 15000);
      await sleep(800);
      const pr = startRecorder(ph.snd, "phone", 92);
      phoneOffset = (pr.t0 - rec.t0) / 1000;
      mark(`③ 폰 녹화 시작 (rec_phone.mp4 의 0초 = PC 녹화 ${phoneOffset.toFixed(1)}초)`);
      await sleep(1500);
      await ph.ev(`(() => { const s = document.querySelector('#rf select[name=zone]'); const o = [...s.options].find((x) => x.textContent.includes("진주교")); s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await sleep(1500);
      await ph.ev(`document.querySelector("#rf textarea").focus()`);
      for (let i = 1; i <= PHONE_TEXT.length; i++) {
        await ph.ev(`(() => { const t = document.querySelector("#rf textarea"); t.value = ${JSON.stringify(PHONE_TEXT.slice(0, i))}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await sleep(90);
      }
      await sleep(1500);
      mark("③ 폰 제출");
      await ph.ev(`document.querySelector('#rf button[type=submit]').click()`);
      await until(() => ph.ev(`!!document.querySelector(".rp-modal[open], .rp-overlay")`), 8000);
      await sleep(4000);
      phoneLen = await pr.stop(path.join(OUTDIR, "rec_phone.mp4"));
    } finally { await ph.close(); }
  })();
  const label = await until(async () => {
    const c = await get("/api/control");
    const f = c.feed.find((x: any) => String(x.raw_text).includes("산책로 조명"));
    return f?.label && f.status === "done" ? f.label : null;
  }, 150000, 500);
  mark(`③ 산책로 민원 분류됨: ${label ?? "시간 안에 안 붙음"}`);
  await sleep(5000);
  await phoneFlow; await pause();
  // ④ 혼잡 2건 → 혼잡 카드 1위
  mark("④ 혼잡 2건 입력 (PC: 유입 피드)");
  await dbmod.insert_feedback(tunnel, CROWD[0], "demo", iso(new Date()));
  await sleep(8000);
  await dbmod.insert_feedback(tunnel, CROWD[1], "demo", iso(new Date()));
  const crowdTop = await until(async () => { const c = await get("/api/control"); const i = c.issues[0]; return i && i.label === "crowd" && i.zone_name === "유등터널" ? i : null; }, 180000, 1000);
  mark(`④ 혼잡 카드 ${crowdTop ? "1위로 올라옴" : "1위가 되지 않음(시간 초과)"}`);
  await slowScroll(Math.max(0, (await topOf(`document.querySelector(".icards")`)) - 110), 2200);
  await sleep(5000); await pause();
  // ⑤ 조치 화면 → 혼잡 요청서 펼치기
  mark("⑤ 조치 화면"); await click("#dev-toggle"); await sleep(800);
  await pc.ev(`window.scrollTo(0, 0); location.hash = "#action"`);
  await until(() => pc.ev(`!!document.querySelector(".docs li, .targets li")`), 10000); await sleep(2500);
  const findLi = `[...document.querySelectorAll(".docs li")].find((l) => l.querySelector(".name")?.textContent.includes("혼잡"))`;
  if (!(await until(() => pc.ev(`!!(${findLi})`), 40000, 500))) {
    await pc.ev(`(() => { const li = [...document.querySelectorAll(".targets li")].find((l) => l.textContent.includes("혼잡")); li?.querySelector("[data-gen]")?.click(); })()`);
    pcMarks.push(`${now().toFixed(1)}\t(자동 요청서가 아직 없어 [조치요청서 생성]을 눌렀음)`);
    await until(() => pc.ev(`!!(${findLi})`), 60000, 500);
  }
  await pause();
  mark("⑤ 혼잡 조치요청서 펼치기");
  await pc.ev(`(${findLi})?.querySelector("[data-toggle]")?.click()`); await sleep(1200);
  await slowScroll(Math.max(0, (await topOf(findLi)) - 90), 2000); await sleep(5000);
  await slowScroll((await topOf(findLi)) + 260, 3500); await sleep(2500); await pause();
  // ⑥ 상태 '조치중' 클릭이 화면 안에 보이게
  mark("⑥ 조치중 버튼이 화면에 보임");
  await slowScroll(Math.max(0, (await topOf(findLi)) - 90), 1800); await sleep(2500);
  mark("⑥ '조치중' 클릭");
  await pc.ev(`(${findLi})?.querySelector('[data-status="in_progress"]')?.click()`); await sleep(4500); await pause();
  // ⑦ 관제 복귀 → 브리핑 갱신 5초
  mark("⑦ 관제 복귀");
  await pc.ev(`window.scrollTo(0, 0); location.hash = "#control"`); await sleep(1500);
  const KO: Record<string, string> = { crowd: "혼잡", safety: "안전", parking: "주차", price: "가격", restroom: "화장실", guide: "안내" };
  const sync = await until(async () => { const c = await get("/api/control"); const t = c.issues.find((i: any) => i.grp === "main") ?? c.issues[0]; return !!(t && c.briefing && String(c.briefing.text).includes(KO[t.label] ?? "§")); }, 45000, 1000);
  mark(`⑦ 브리핑 ${sync ? "갱신됨" : "(45초 안에 맞춰지지 않음)"}`); await sleep(5000);
  mark("끝");
  const pcLen = await rec.stop(path.join(OUTDIR, "rec_pc.mp4"));
  writeFileSync(path.join(OUTDIR, "rec_pc_marks.txt"), `# 초(rec_pc.mp4 기준)\t동작\n` + pcMarks.join("\n") + `\n# rec_phone.mp4 시작 = rec_pc.mp4 ${phoneOffset.toFixed(1)}초 · 길이 ${phoneLen.toFixed(1)}초 · rec_pc 길이 ${pcLen.toFixed(1)}초\n# 실제 고유 프레임: rec_pc 초당 ${stats.pc.uniqueFps.toFixed(1)}장 · rec_phone 초당 ${stats.phone.uniqueFps.toFixed(1)}장 (출력은 ${FPS}fps 타임라인, 나머지는 반복 프레임)\n`);
  console.log(`[녹화] rec_pc ${pcLen.toFixed(1)}초 · rec_phone ${phoneLen.toFixed(1)}초`);

  // ── 캡처 5장 (3840x2160, 새 탭, 녹화가 끝난 뒤) ──────────────────────
  // 4-⑥에서 '조치중'으로 바꾼 혼잡 요청서를 '요청'으로 되돌려 혼잡 카드가 다시 1위인 같은 상태로 만든다
  try {
    const crowdDoc = (await get("/api/action")).actions.find((a: any) => a.label === "crowd" && a.status !== "superseded");
    if (crowdDoc && crowdDoc.status !== "requested") await fetch(`${base}/api/rpc/set_action_status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ p_id: crowdDoc.id, p_status: "requested" }) });
    await until(async () => { const c = await get("/api/control"); const i = c.issues[0]; return !!(i && c.briefing && String(c.briefing.text).includes(KO[i.label] ?? "§")); }, 45000, 1000);
    const cp = await openTab(`${base}/#control`, { w: W, h: H, dsf: 3 });
    try {
      await until(() => cp.ev(`document.querySelectorAll(".icard").length > 0`), 20000);
      const panel = async (on: boolean) => { await cp.ev(`(() => { if (document.body.classList.contains("dev-open") !== ${on}) document.getElementById("dev-toggle").click(); })()`); await sleep(1200); };
      const shot = async (file: string) => { await sleep(900); const r = await cp.snd("Page.captureScreenshot", { format: "png" }); if (r?.data) writeFileSync(path.join(OUTDIR, file), Buffer.from(r.data, "base64")); console.log(`[캡처] ${file}`); };
      await panel(true); await sleep(3000); await shot("cap_flow.png");
      await cp.ev(`document.querySelector('[data-tab="sev"]')?.click()`); await sleep(1500); await shot("cap_score.png");
      await panel(false); await cp.ev(`window.scrollTo(0, 0)`); await shot("cap_brief.png");
      await cp.ev(`(() => { const c = [...document.querySelectorAll(".icard")].find((e) => e.textContent.includes("유등터널") && e.textContent.includes("혼잡")) ?? document.querySelector(".icards"); window.scrollTo(0, c.getBoundingClientRect().top + window.scrollY - 40); })()`); await shot("cap_card.png");
      await cp.ev(`location.hash = "#action"`); await until(() => cp.ev(`!!(${findLi})`), 20000);
      await cp.ev(`(() => { const li = ${findLi}; li?.querySelector("[data-toggle]")?.click(); })()`); await sleep(900);
      await cp.ev(`(() => { const li = ${findLi}; window.scrollTo(0, li.getBoundingClientRect().top + window.scrollY - 24); })()`); await shot("cap_doc.png");
    } finally { await cp.close(); }
  } catch (e) { console.log("[캡처 오류] " + (e as Error).message); }

  // ── agent_log.json ────────────────────────────────────────────────
  const d = new DatabaseSync(DB, { readOnly: true });
  const rows = d.prepare("SELECT id, created_at, agent, action, latency_ms FROM agent_log ORDER BY id").all() as any[];
  d.close();
  writeFileSync(path.join(OUTDIR, "agent_log.json"), JSON.stringify(rows.map((r) => ({ id: r.id, time: r.created_at, agent: r.agent, action: r.action, tool: r.action, ms: r.latency_ms })), null, 1));
  console.log(`[agent_log] ${rows.length}행`);
  console.log(`\n저장: ${OUTDIR}`);
}

try { await main(); } catch (e) { console.error(e); process.exitCode = 1; } finally { await cleanup(); process.exit(process.exitCode ?? 0); }
