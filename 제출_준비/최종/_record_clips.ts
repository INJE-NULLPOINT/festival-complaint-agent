// 추가 기능 클립 녹화 — OS 화면 녹화(ddagrab 60fps)로 보조 모니터(DISPLAY2)에 kiosk Chrome 만 찍는다. 제품 코드는 건드리지 않는다.
//   node 제출_준비/최종/_record_clips.ts [--only settings,qr,review,delete,docx,itaewon] [--outdir <폴더>] [--llm claude_code|local]
// 클립: clip_settings · clip_qr · clip_review · clip_delete · clip_docx (시연 DB) · clip_itaewon (별도 DB, 이태원 112 녹취 재현)
// 시연 DB 준비만 실모델(--llm, 기본 claude_code) 로 하고, 클립을 찍을 때는 워커를 local 로 바꿔 둔다.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { freePort, killTree } from "../../festival_agent/tests/ui/lib.ts";

const HERE = import.meta.dirname;
const APP = path.resolve(HERE, "..", "..", "festival_agent");
const { values: A } = parseArgs({ options: { only: { type: "string" }, outdir: { type: "string" }, llm: { type: "string", default: "claude_code" } } });
const ONLY = new Set((A.only ?? "settings,qr,review,delete,docx,itaewon").split(","));
const OUTDIR = path.resolve(A.outdir ?? path.join(HERE, "_영상편집", "src", "clips"));
const DB = path.join(APP, "output", "demo_festival.db");
const FFMPEG = process.env.FFMPEG ?? path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-9.0.2-full_build", "bin", "ffmpeg.exe");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const MON = { x: 166, y: -1440, w: 2560, h: 1440 };           // DISPLAY2
const tmp = mkdtempSync(path.join(tmpdir(), "clips-"));
mkdirSync(OUTDIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<any> | any, ms = 10000, step = 200) => { const t0 = Date.now(); for (;;) { let v: any = null; try { v = await fn(); } catch { /* 아직 */ } if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const kids: ChildProcess[] = [];

function findOutputIdx(): number {
  for (let i = 0; i < 4; i++) {
    const r = spawnSync(FFMPEG, ["-hide_banner", "-f", "lavfi", "-i", `ddagrab=output_idx=${i}:framerate=10:draw_mouse=0`, "-frames:v", "1", "-vf", "hwdownload,format=bgra", "-f", "null", "-"], { encoding: "utf-8" });
    const m = /Video: [^\n]*?(\d{3,5})x(\d{3,5})/.exec(r.stderr ?? "");
    if (m && Number(m[1]) === MON.w && Number(m[2]) === MON.h) return i;
  }
  throw new Error("2560x1440 출력을 찾지 못함 (보조 모니터가 켜져 있는지 확인)");
}

type Page = { snd: (m: string, p?: Record<string, any>) => Promise<any>; ev: (e: string) => Promise<any>; port: number; close: () => Promise<void> };
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
  return { snd, ev, port, close: async () => { try { w.send(JSON.stringify({ id: 999999, method: "Browser.close" })); } catch { /* */ } await sleep(800); killTree(proc); } };
}

function startGrab(idx: number, out: string) {
  const p = spawn(FFMPEG, ["-y", "-f", "lavfi", "-i", `ddagrab=output_idx=${idx}:framerate=60:draw_mouse=0`, "-vf", "hwmap=derive_device=qsv,format=qsv,scale_qsv=w=1920:h=1080", "-c:v", "h264_qsv", "-global_quality", "18", "-g", "120", out], { stdio: ["pipe", "ignore", "pipe"] });
  let log = "", first: number | null = null;
  p.stderr!.on("data", (d) => { log += d; if (first === null && /frame=\s*\d+/.test(String(d))) first = Date.now(); });
  return {
    started: async () => { await until(() => first, 10000, 50); return first ?? Date.now(); },
    stop: async () => {
      p.stdin!.write("q"); await Promise.race([new Promise((r) => p.on("exit", r)), sleep(15000)]);
      if (p.exitCode === null) killTree(p);
      const m = [...log.matchAll(/frame=\s*(\d+) fps=\s*([\d.]+).*?time=([\d:.]+)/g)].pop();
      return m ? `${m[1]}프레임 ${m[3]}` : "?";
    },
  };
}

const allMarks: string[] = [];
type Ctx = { p: Page; mark: (s: string) => void; click: (sel: string) => Promise<any>; slowScroll: (y: number, ms?: number) => Promise<any>; topOf: (js: string) => Promise<number> };
/** 클립 1개: 창을 열고 → 녹화 시작 → 앞 1초 → fn → 뒤 1초 → 녹화 끝. */
async function clip(name: string, idx: number, url: string, fn: (c: Ctx) => Promise<void>, ready: string) {
  const p = await kiosk(url, 2);
  try {
    await until(() => p.ev(ready), 30000); await sleep(2500);
    const click = (sel: string) => p.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
    const slowScroll = (y: number, ms = 1800) => p.ev(`new Promise((res) => { const y0 = window.scrollY, y1 = ${y}, t0 = performance.now(); const step = (t) => { const k = Math.min(1, (t - t0) / ${ms}); window.scrollTo(0, y0 + (y1 - y0) * (k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)); k < 1 ? requestAnimationFrame(step) : res(true); }; requestAnimationFrame(step); })`);
    const topOf = (js: string) => p.ev(`(() => { const e = ${js}; return e ? Math.round(e.getBoundingClientRect().top + window.scrollY) : -1; })()`);
    const raw = path.join(tmp, `${name}.mp4`);
    const g = startGrab(idx, raw); const T0 = await g.started();
    const marks: string[] = []; const now = () => (Date.now() - T0) / 1000;
    const mark = (s: string) => { marks.push(`${now().toFixed(1)}\t${s}`); console.log(`[${name}] ${now().toFixed(1)}s ${s}`); };
    await sleep(1000);
    await fn({ p, mark, click, slowScroll, topOf });
    await sleep(1000);
    marks.push(`${now().toFixed(1)}\t끝`);
    const stat = await g.stop();
    renameSync(raw, path.join(OUTDIR, `${name}.mp4`));
    writeFileSync(path.join(OUTDIR, `${name}_marks.txt`), `# 초(${name}.mp4 기준)\t동작\n${marks.join("\n")}\n`);
    allMarks.push(`## ${name}.mp4  (${stat})\n${marks.join("\n")}\n`);
    console.log(`[${name}] 저장 (${stat})`);
  } finally { await p.close(); }
}

const baseEnv = (db: string, llm: string, docs: string) => ({ ...process.env, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", DB_PATH: db, LLM_BACKEND: llm, DOCS_DIR: docs, PYTHONIOENCODING: "utf-8", VITE_NO_WATCH: "1" });
const spawnWorker = (env: any) => { const c = spawn(process.execPath, ["server/worker.ts", "--agent-interval", "20"], { cwd: APP, env, stdio: "ignore" }); kids.push(c); return c; };
async function spawnWeb(env: any) {
  const ap = await freePort(), vp = await freePort();
  kids.push(spawn(process.execPath, ["server/webapi.ts", "--port", String(ap)], { cwd: APP, env, stdio: "ignore" }));
  kids.push(spawn(process.execPath, [path.join(APP, "web/node_modules/vite/bin/vite.js"), "--port", String(vp), "--strictPort", "--host", "127.0.0.1"], { cwd: path.join(APP, "web"), env: { ...env, WEBAPI_PORT: String(ap) }, stdio: "ignore" }));
  const base = `http://127.0.0.1:${vp}`;
  if (!(await until(async () => (await fetch(`${base}/api/control`)).ok, 40000, 400))) throw new Error("서버가 뜨지 않음");
  return base;
}
const stopAll = async () => { kids.splice(0).forEach(killTree); await sleep(1500); };

async function main() {
  const idx = findOutputIdx();
  console.log(`[클립] 보조 모니터 출력 ${idx} · 출력 ${OUTDIR}`);
  const docsDir = path.join(tmp, "docs");

  // ══ A. 시연 DB 클립 ═══════════════════════════════════════════════
  if (["settings", "qr", "review", "delete", "docx"].some((k) => ONLY.has(k))) {
    for (const k of ["SUPABASE_DB_URL", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) process.env[k] = "";
    process.env.DB_PATH = DB; process.env.DOCS_DIR = docsDir;
    const envReal = baseEnv(DB, A.llm as string, docsDir), envLocal = baseEnv(DB, "local", docsDir);
    const reset = spawnSync(process.execPath, ["server/scripts/demo_scenario.ts", "--reset", "--no-wait"], { cwd: APP, env: envReal as any, encoding: "utf-8" });
    if (reset.status !== 0) throw new Error("demo_scenario 실패\n" + reset.stdout + reset.stderr);
    spawnWorker(envReal);
    const base = await spawnWeb(envReal);
    const get = async (p: string) => (await (await fetch(base + p)).json()).data;
    const rpc = (name: string, body: any) => fetch(`${base}/api/rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!(await until(async () => { const c = await get("/api/control"); return c.total >= 24 && c.pending === 0 && c.issues.length > 0 && !!c.briefing; }, 360000, 1500))) throw new Error("배경 분류가 끝나지 않음");
    await sleep(10000);
    const zones = await get("/api/zones");
    const zid = (n: string) => zones.find((z: any) => z.name.includes(n)).id;
    const dbmod: any = await import(pathToFileURL(path.join(APP, "server", "core", "db.ts")).href);
    const iso = (d: Date) => { const q = (x: number) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${q(d.getMonth() + 1)}-${q(d.getDate())}T${q(d.getHours())}:${q(d.getMinutes())}:${q(d.getSeconds())}`; };
    // 혼잡 2건 → 혼잡 카드 1위 → 실모델이 만든 조치요청서(DOCX) 가 생길 때까지
    await dbmod.insert_feedback(zid("유등터널"), "유등터널 안에서 사람들이 한꺼번에 몰려서 앞으로 나갈 수가 없어요", "demo", iso(new Date()));
    await sleep(6000);
    await dbmod.insert_feedback(zid("유등터널"), "터널 입구에 사람이 계속 들어와서 안쪽이 너무 붐비고 떠밀려요", "demo", iso(new Date()));
    await until(async () => { const i = (await get("/api/control")).issues[0]; return i && i.label === "crowd"; }, 180000, 1000);
    const crowdDoc = () => get("/api/action").then((r: any) => r.actions.find((a: any) => a.label === "crowd" && a.status !== "superseded" && a.doc_url));
    if (!(await until(crowdDoc, 90000, 1000))) { await rpc("request_doc", { p_label: "crowd" }); if (!(await until(crowdDoc, 180000, 1000))) throw new Error("혼잡 요청서(DOCX)가 만들어지지 않음"); }
    await sleep(3000);
    // 이제 모델 호출 없이: 워커를 local 로 바꾸고, 확인 필요 민원 3건을 직접 넣는다 (워커 없이)
    await stopAll();
    const REVIEW: [string, string, string, number][] = [
      ["진주교", "저기 아까부터 이상한 냄새가 나는 것 같은데 뭔지는 모르겠어요", "safety", 1],
      ["남강 둔치", "계속 큰 소리가 나는데 어디서 나는지는 잘 모르겠어요", "guide", 0],
      ["유등터널", "그냥 좀 그러네요", "", 0],
    ];
    const rv = new DatabaseSync(DB);
    for (const [zone, text, sug, safe] of REVIEW) {
      const zn = zones.find((z: any) => z.name.includes(zone)) ?? zones[0];
      const id = await dbmod.insert_feedback(zn.id, text, "demo", iso(new Date()));
      if (id) rv.prepare("INSERT OR REPLACE INTO classification (feedback_id,label,sentiment,is_safety,confidence,status,processed_at,suggested_label) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, null, -0.2, safe, 0.4, "review", iso(new Date()), sug || null);
      await sleep(500);
    }
    rv.close();
    await dbmod.close_all?.();
    spawnWorker(envLocal);
    const base2 = await spawnWeb(envLocal);
    const get2 = async (p: string) => (await (await fetch(base2 + p)).json()).data;
    const rpc2 = (name: string, body: any) => fetch(`${base2}/api/rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await until(async () => { const c = await get2("/api/control"); return c.pending === 0 && c.issues.length > 0; }, 60000, 1000);
    console.log("[준비] review:", JSON.stringify((await get2("/api/control")).review ?? "(필드 없음)").slice(0, 120));
    await sleep(20000);          // 워커 첫 순환(브리핑·상태)이 끝나 연결 표시가 안정되게

    const ctl = `${base2}/#control`, pause = () => sleep(2500);
    const rdyCtl = `document.querySelectorAll(".icard").length > 0`;

    if (ONLY.has("settings")) await clip("clip_settings", idx, `${base2}/#settings`, async (c) => {
      const sec = (id: string) => c.topOf(`document.getElementById(${JSON.stringify(id)})`);
      c.mark("설정 화면 (축제 정보)"); await sleep(3000);
      c.mark("구역 목록"); await c.slowScroll(Math.max(0, (await sec("set-h-zone")) - 100), 1800); await sleep(2800);
      c.mark("담당 부서"); await c.slowScroll(Math.max(0, (await sec("set-h-dept")) - 100), 1800); await sleep(2800);
      c.mark("나머지 설정"); await c.slowScroll(await c.p.ev(`document.documentElement.scrollHeight`), 2200); await sleep(2500);
    }, `!!document.getElementById("set-fest")`);

    if (ONLY.has("qr")) await clip("clip_qr", idx, `${base2}/#report`, async (c) => {
      c.mark("접수 QR 화면 (localhost 주소 경고)"); await sleep(3500);
      c.mark("공개 주소로 바꿔 입력 → QR 이 바로 다시 만들어짐");
      const url = "https://festival.example.kr";
      await c.p.ev(`document.querySelector("#qr-base").focus()`);
      for (let i = 1; i <= url.length; i++) { await c.p.ev(`(() => { const t = document.querySelector("#qr-base"); t.value = ${JSON.stringify(url.slice(0, i))}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`); await sleep(110); }
      await sleep(2500);
      c.mark("[인쇄] · [PNG 저장] 버튼");
      await c.slowScroll(await c.p.ev(`document.documentElement.scrollHeight`), 1800); await sleep(2500);
    }, `!!document.getElementById("qr-card")`);

    if (ONLY.has("review")) await clip("clip_review", idx, ctl, async (c) => {
      await c.slowScroll(Math.max(0, (await c.topOf(`document.querySelector("[data-rv-toggle]")`)) - 160), 1200);
      c.mark("'확인 필요' 숫자가 있는 유입 제목"); await sleep(2500);
      c.mark("[확인 필요] 눌러 처리 패널 열기"); await c.click("[data-rv-toggle]"); await sleep(3500);
      c.mark("한 건 유형 지정 (모델 제안 유형)");
      await c.p.ev(`(() => { const s = document.querySelector(".rvi-pick select"); const o = [...s.options].find((x) => x.textContent.includes("모델 제안")) ?? s.options[1]; s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await sleep(3000);
      c.mark("다음 건: 유형 없음으로 닫기"); await c.click("[data-dismiss]"); await sleep(3000);
    }, rdyCtl);

    if (ONLY.has("delete")) await clip("clip_delete", idx, ctl, async (c) => {
      await c.slowScroll(Math.max(0, (await c.topOf(`document.querySelector(".feed")`)) - 110), 1200);
      c.mark("실시간 유입 (행마다 휴지통)"); await sleep(2500);
      c.mark("휴지통 눌러 민원 지우기"); await c.p.ev(`[...document.querySelectorAll(".feed li")].find((l) => !l.textContent.includes("확인 필요") && l.querySelector("[data-del]"))?.querySelector("[data-del]")?.click()`); await sleep(3200);
      c.mark("'지웠습니다 · 되돌리기' → 되돌리기"); await c.click(".toast-act"); await sleep(3000);
    }, rdyCtl);

    if (ONLY.has("docx")) {
      const doc = await crowdDoc2(get2);
      await rpc2("set_action_status", { p_id: doc.id, p_status: "in_progress" });
      await clip("clip_docx", idx, `${base2}/#action`, async (c) => {
        const li = `[...document.querySelectorAll(".docs li")].find((l) => l.querySelector(".name")?.textContent.includes("혼잡"))`;
        await c.slowScroll(Math.max(0, (await c.topOf(li)) - 90), 1000);
        c.mark("혼잡 요청서 (조치중)"); await sleep(2800);
        c.mark("처리 상태 '완료' 클릭 → ✓"); await c.p.ev(`(${li})?.querySelector('[data-status="done"]')?.click()`); await sleep(3500);
        c.mark("DOCX 내려받기 클릭"); await c.p.ev(`(${li})?.querySelector('a.btn[href]')?.click()`); await sleep(1500);
        // 새 탭이 열렸으면 원래 탭으로 돌아온다
        const tabs = await (await fetch(`http://127.0.0.1:${c.p.port}/json`)).json();
        const mine = tabs.find((t: any) => t.type === "page" && String(t.url).startsWith(base2));
        if (mine) await fetch(`http://127.0.0.1:${c.p.port}/json/activate/${mine.id}`);
        await sleep(2500);
      }, `document.querySelectorAll(".docs li").length > 0`);
    }
    await stopAll();
  }

  // ══ B. 이태원 112 녹취 재현 (별도 DB, 규칙 분류) ══════════════════════
  if (ONLY.has("itaewon")) {
    const rdb = path.join(tmp, "itaewon.db");
    const env = baseEnv(rdb, "local", path.join(tmp, "docs2"));
    process.env.DB_PATH = rdb;
    const cli = (...a: string[]) => spawnSync(process.execPath, ["server/cli.ts", ...a], { cwd: APP, env: env as any, encoding: "utf-8" });
    console.log("[이태원] 초기화:", (cli("replay", "status").stdout || "").trim().slice(0, 60));
    spawnWorker(env);
    const base = await spawnWeb(env);
    await sleep(20000);
    await clip("clip_itaewon", idx, `${base}/#control`, async (c) => {
      c.mark("재현 시작 전 관제 (빈 화면)"); await sleep(3000);
      c.mark("replay start --file itaewon_112.csv (18:34 첫 신고 투입)");
      const r = cli("replay", "start", "--file", "itaewon_112.csv", "--speed", "300");
      console.log("[이태원] replay:", (r.stdout || r.stderr).trim().slice(0, 100));
      const first = await until(async () => { const j = (await (await fetch(`${base}/api/control`)).json()).data; return j.issues.some((i: any) => i.grade === "immediate") ? j : null; }, 60000, 300);
      c.mark(first ? "관제에 '즉시' 등급 카드가 뜸" : "(60초 안에 즉시 등급이 안 뜸)");
      await sleep(7000);
      c.mark("재현 진행 (이후 신고 투입)"); await sleep(3500);
    }, `!!document.querySelector(".feed, .icards, #app")`);
    await stopAll();
  }
  writeFileSync(path.join(OUTDIR, "clips_marks.txt"), `# 클립별 동작 시각(초) — 각 클립은 앞뒤 1초 여유\n\n${allMarks.join("\n")}`);
  console.log(`\n저장: ${OUTDIR}`);
}

async function crowdDoc2(get2: (p: string) => Promise<any>) {
  return (await get2("/api/action")).actions.find((a: any) => a.label === "crowd" && a.status !== "superseded" && a.doc_url);
}

try { await main(); } catch (e) { console.error(e); process.exitCode = 1; } finally { kids.forEach(killTree); await sleep(500); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 파일 잠김 */ } process.exit(process.exitCode ?? 0); }
