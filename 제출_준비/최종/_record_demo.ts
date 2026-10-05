// 시연영상 자동 녹화 (사용자 지시 "시연영상 일단 만들어봐") — 제품 코드는 건드리지 않는다.
//   node 제출_준비/최종/_record_demo.ts [--llm local|claude_code] [--out <mp4 경로>] [--shots <PNG 폴더>] [--keep]
// 대본: 제출_준비/시연영상_대본.md. 내레이션은 음성 대신 화면 아래 자막, "가상 민원" 자막은 처음부터 끝까지.
// 데이터: output/demo_festival.db (demo_scenario.ts --reset --no-wait). 운영 Supabase 는 쓰지 않는다 (SUPABASE_* 빈 값), DOCS_DIR 임시.
// 녹화: 헤드리스 크롬(CSS 1280x720, 화면 1920x1080) → CDP Page.captureScreenshot 을 계속 찍어 30fps 로 채운 뒤 ffmpeg 로 mp4. 폰 화면은 같은 페이지 위에 390폭 iframe(?v=qr)으로 띄운다.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { freePort, killTree, openChrome, quitChrome } from "../../festival_agent/tests/ui/lib.ts";

const HERE = import.meta.dirname;
const APP = path.resolve(HERE, "..", "..", "festival_agent");
const { values: A } = parseArgs({ options: {
  llm: { type: "string", default: "local" }, out: { type: "string" }, shots: { type: "string" }, keep: { type: "boolean", default: false },
} });
const LLM = A.llm as string;
const OUT = path.resolve(A.out ?? path.join(HERE, "시연영상_철철철.mp4"));
const SHOTS = path.resolve(A.shots ?? path.join(HERE, "미리보기"));
const DB = path.join(APP, "output", "demo_festival.db");
// mp4(H.264) 인코더(libx264)가 든 full 빌드 ffmpeg (winget Gyan.FFmpeg). playwright 의 ffmpeg 에는 libx264 가 없다.
const FFMPEG = process.env.FFMPEG ?? path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-9.0.2-full_build", "bin", "ffmpeg.exe");
const FPS = 30, W = 1280, H = 720, SCALE = 1.5;          // 레이아웃은 1280x720 CSS 그대로, 화면은 1.5배(=1920x1080)로 그린다
const tmp = mkdtempSync(path.join(tmpdir(), "demo-rec-"));
const frames = path.join(tmp, "frames"); mkdirSync(frames);
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<any> | any, ms = 10000, step = 200) => { const t0 = Date.now(); for (;;) { let v: any = null; try { v = await fn(); } catch { /* 아직 준비 안 됨 */ } if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };

let BASEURL = "";
const kids: ChildProcess[] = [];
let chrome: ChildProcess | null = null; let ws: WebSocket | null = null;
async function cleanup() {
  if (chrome) await quitChrome(chrome, ws).catch(() => {});
  for (const k of kids) killTree(k);
  await sleep(500);
  if (!A.keep) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 파일 잠김 */ }
}

// ── 서버 준비 ────────────────────────────────────────────────────────
const baseEnv = { ...process.env, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "",
  DB_PATH: DB, LLM_BACKEND: LLM, DOCS_DIR: path.join(tmp, "docs"), PYTHONIOENCODING: "utf-8" };
function run(label: string, args: string[], env: Record<string, string | undefined>, cwd = APP): ChildProcess {
  const c = spawn(process.execPath, args, { cwd, env: env as any, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout!.on("data", (d) => process.stdout.write(`[${label}] ${d}`.replace(/\n(?=.)/g, `\n[${label}] `)));
  c.stderr!.on("data", (d) => process.stderr.write(`[${label}!] ${d}`));
  kids.push(c);
  return c;
}
const shot = async (send: any, name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r?.data) writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, "base64"));
};

/** 영상 탭과 별개의 새 탭에서 자막 없이 PNG 원본을 만든다 (1280 폭). panel: AI 동작 보기 패널 열림 여부. full: 스크롤 밖까지 한 장. */
let DPORT = 0;
async function tabShot(hash: string, file: string, o: { panel: boolean; full?: boolean; prep?: string; settle?: number }, base = BASEURL) {
  const t = await (await fetch(`http://127.0.0.1:${DPORT}/json/new?${base}/${hash}`, { method: "PUT" })).json();
  const w = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => w.addEventListener("open", r));
  let id = 0; const pend = new Map<number, (v: any) => void>();
  w.addEventListener("message", (e) => { const m = JSON.parse(e.data as string); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result ?? m.error); pend.delete(m.id); } });
  const snd = (method: string, params: Record<string, any> = {}) => new Promise<any>((res) => { const n = ++id; pend.set(n, res); w.send(JSON.stringify({ id: n, method, params })); });
  const ev2 = async (expr: string) => (await snd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  try {
    await snd("Page.enable");
    await snd("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await snd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await until(() => ev2(`document.querySelectorAll(".icard, .docs li, .targets li").length > 0`), 20000);
    await ev2(`(() => { if (document.body.classList.contains("dev-open") !== ${o.panel}) document.getElementById("dev-toggle").click(); })()`);
    if (o.prep) await ev2(o.prep);
    await sleep(o.settle ?? 2500);
    if (o.full) {
      const m = await snd("Page.getLayoutMetrics");
      const h = Math.ceil((m.cssContentSize ?? m.contentSize).height);
      await snd("Emulation.setDeviceMetricsOverride", { width: W, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(700);
    }
    const r = await snd("Page.captureScreenshot", { format: "png" });
    if (r?.data) writeFileSync(path.join(path.dirname(OUT), file), Buffer.from(r.data, "base64"));
  } finally { try { w.close(); } catch { /* */ } await fetch(`http://127.0.0.1:${DPORT}/json/close/${t.id}`).catch(() => {}); }
}

async function main() {
  for (const k of ["SUPABASE_DB_URL", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) process.env[k] = "";
  process.env.DB_PATH = DB; process.env.DOCS_DIR = path.join(tmp, "docs");     // 아래 db.ts 를 불러올 때 시연 DB 로 고정
  console.log(`[녹화] 백엔드 ${LLM} · 출력 ${OUT}`);
  if (LLM === "claude_code" && process.env.ANTHROPIC_API_KEY) console.log("(참고: ANTHROPIC_API_KEY 가 환경에 있지만 claude_code 경로는 CLI 를 쓴다)");
  // 1) 시연 DB 새로 (배경 24건, 예약은 넣지 않음 — 혼잡 2건은 대본 시각에 이 스크립트가 직접 넣는다)
  const reset = spawnSync(process.execPath, ["server/scripts/demo_scenario.ts", "--reset", "--no-wait"], { cwd: APP, env: baseEnv as any, encoding: "utf-8" });
  if (reset.status !== 0) throw new Error("demo_scenario 실패\n" + reset.stdout + reset.stderr);
  console.log(reset.stdout.split("\n").filter((l) => /넣었습니다|캐시/.test(l)).join("\n"));

  // 2) 워커 · webapi · vite
  const apiPort = await freePort(), vitePort = await freePort();
  run("worker", ["server/worker.ts", "--agent-interval", "20"], baseEnv);
  run("webapi", ["server/webapi.ts", "--port", String(apiPort)], baseEnv);
  const viteBin = path.join(APP, "web", "node_modules", "vite", "bin", "vite.js");
  run("vite", [viteBin, "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"], { ...baseEnv, WEBAPI_PORT: String(apiPort), VITE_NO_WATCH: "1" }, path.join(APP, "web"));
  const base = `http://127.0.0.1:${vitePort}`;
  BASEURL = base;
  const get = async (p: string) => (await (await fetch(base + p)).json()).data;
  if (!(await until(async () => (await fetch(`${base}/api/control`)).ok, 40000, 400))) throw new Error("서버가 뜨지 않음");
  // 배경 24건 분류가 끝나고 카드가 생길 때까지 (끝나기 전에는 녹화를 시작하지 않는다)
  const ready = await until(async () => { const c = await get("/api/control"); return c.total >= 24 && c.pending === 0 && c.issues.length > 0 && !!c.briefing && c; }, 360000, 1500);
  if (!ready) throw new Error("배경 분류가 끝나지 않음");
  console.log(`[녹화] 배경 준비 완료: 접수 ${ready.total} · 카드 ${ready.issues.length}장 · 대기 ${ready.pending}`);
  await sleep(Number(process.env.DEMO_SETTLE_MS ?? 15000));          // 에이전트 한 바퀴(계획·감시·조치)가 돌 시간

  // 3) 크롬
  const o = await openChrome({ prefix: "demo-", width: W, height: H });
  chrome = o.chrome; ws = o.ws;
  DPORT = Number(o.chrome.spawnargs.find((a) => a.startsWith("--remote-debugging-port="))!.split("=")[1]); const { send, ev } = o;
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

  // 자막 · 폰 틀 (페이지 위에 덧씌움 — 제품 화면에는 손대지 않는다)
  const OVERLAY = `(() => {
    if (document.getElementById("demo-cap")) return;
    const st = document.createElement("style");
    st.textContent = \`
      #demo-cap { position: fixed; left: 0; right: 0; bottom: 0; z-index: 99999; background: rgba(0,0,0,.82); color: #fff; padding: 10px 40px 14px; font-family: "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; text-align: center; pointer-events: none; }
      #demo-cap .always { font-size: 15px; color: #ffd24d; font-weight: 700; margin-bottom: 4px; }
      #demo-cap .line { font-size: 25px; line-height: 1.4; font-weight: 600; min-height: 36px; }
      #demo-cap .line small { display: block; font-size: 17px; font-weight: 400; opacity: .85; margin-top: 2px; }
      #demo-phone { position: fixed; top: 24px; right: 36px; z-index: 99998; width: 372px; height: 600px; border: 10px solid #111; border-radius: 34px; background: #fff; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.45); display: none; }
      #demo-phone iframe { width: 390px; height: 640px; border: 0; transform-origin: 0 0; transform: scale(.9538); }
      #demo-phone-tag { position: fixed; top: 4px; right: 36px; z-index: 99999; font: 700 14px "Malgun Gothic", sans-serif; background: #111; color: #fff; padding: 2px 12px; border-radius: 10px; display: none; }
    \`;
    document.head.appendChild(st);
    const cap = document.createElement("div"); cap.id = "demo-cap";
    cap.innerHTML = '<div class="always">※ 배경 민원 24건과 유등터널 혼잡 2건은 시연용으로 만든 가상 민원입니다.</div><div class="line"></div>';
    document.body.appendChild(cap);
    const ph = document.createElement("div"); ph.id = "demo-phone"; ph.innerHTML = '<iframe id="demo-frame" title="휴대폰 접수 화면"></iframe>';
    document.body.appendChild(ph);
    const tag = document.createElement("div"); tag.id = "demo-phone-tag"; tag.textContent = "방문객 휴대폰 (QR 접수 화면)";
    document.body.appendChild(tag);
    window.__cap = (t, sub) => { cap.querySelector(".line").innerHTML = t + (sub ? "<small>" + sub + "</small>" : ""); };
    window.__phone = (on) => { ph.style.display = on ? "block" : "none"; tag.style.display = on ? "block" : "none"; if (on && !document.getElementById("demo-frame").src) document.getElementById("demo-frame").src = "/?v=qr"; };
  })()`;
  const cap = (t: string, sub = "") => ev(`window.__cap(${JSON.stringify(t)}, ${JSON.stringify(sub)})`);
  await send("Page.navigate", { url: `${base}/#control` });
  await until(() => ev(`document.querySelectorAll(".icard").length > 0`), 20000);
  await ev(OVERLAY);
  await ev(`(() => { try { localStorage.removeItem("festival_dev_view"); } catch (e) {} })()`);
  await cap("");

  // 프레임 수집: Page.captureScreenshot 을 계속 불러(1920x1080 JPEG) 가장 최근 것을 쓴다.
  // (Page.startScreencast 는 화면이 바쁘면 Chrome 이 프레임 크기를 줄여 보내서 — 흐려지거나, 걸러 내면 화면이 멈춘 것처럼 찍혔다.)
  let latest: Buffer | null = null, n = 0, recording = false, grabbing = true;
  const grabLoop = (async () => {
    while (grabbing) {
      const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
      if (r?.data) latest = Buffer.from(r.data, "base64");
    }
  })();
  await until(() => latest, 5000);
  const dbmod: any = await import(pathToFileURL(path.join(APP, "server", "core", "db.ts")).href);
  const iso = (d: Date) => { const p = (x: number) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const tunnel = (await dbmod.zones()).find((z: any) => z.name === "유등터널").id;
  const CROWD = ["유등터널 안에서 사람들이 한꺼번에 몰려서 앞으로 나갈 수가 없어요", "터널 입구에 사람이 계속 들어와서 안쪽이 너무 붐비고 떠밀려요"];
  const t0 = Date.now();
  // 타이머가 밀려도 영상 길이가 실제 시간과 같도록, 지난 시간만큼의 프레임 수를 채운다
  const sampler = setInterval(() => { if (!recording || !latest) return; while (n < Math.floor(((Date.now() - t0) / 1000) * FPS)) writeFileSync(path.join(frames, `f${String(n++).padStart(6, "0")}.jpg`), latest); }, 40);
  recording = true;
  // 혼잡 2건은 실모델 분류·요청서 작성 시간을 벌려고 0:45·0:55 에 미리 넣는다
  [45, 55].forEach((at, k) => setTimeout(() => { void dbmod.insert_feedback(tunnel, CROWD[k], "demo", iso(new Date())); }, at * 1000));
  const now = () => (Date.now() - t0) / 1000;
  const marks: string[] = [];

  async function scene(name: string, from: number, to: number, fn: () => Promise<void>) {
    while (now() < from) await sleep(100);
    const s = now();
    try { await fn(); } catch (e) { console.log(`[장면 오류] ${name}: ${(e as Error).message}`); }
    const over = now() - to;
    while (now() < to) await sleep(100);
    marks.push(`${fmt(s)}–${fmt(now())} ${name}${over > 0 ? ` (예정보다 ${over.toFixed(1)}초 늦음)` : ""}`);
    console.log("[장면] " + marks[marks.length - 1]);
  }
  const fmt = (x: number) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
  const click = (sel: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const scrollTo = (sel: string, block = "center") => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.scrollIntoView({ behavior: "smooth", block: ${JSON.stringify(block)} }); return !!e; })()`);

  // ── 1. 문제 ────────────────────────────────────────────────────────
  await scene("1. 문제", 0, 15, async () => {
    await cap("축제에는 주차·가격 같은 불편 민원이 많이 들어오고, 안전 민원은 적게 들어옵니다.", "건수 순으로 보면 안전 민원이 뒤로 밀립니다.");
    await shot(send, "영상_01_관제.png");
  });
  // ── 2. Agent 설명 ──────────────────────────────────────────────────
  await scene("2. Agent 설명", 15, 35, async () => {
    await cap("이 에이전트는 방문객 민원을 분류하고, 건수가 아니라 심각도로 순위를 매깁니다.", "운영자가 먼저 할 일과 담당 부서 요청서를 만듭니다.");
    await scrollTo(".icards", "start");
    await sleep(6000);
    await ev(`window.scrollBy({ top: 260, behavior: "smooth" })`);
    await sleep(5000);
    await ev(`window.scrollTo({ top: 0, behavior: "smooth" })`);
  });
  // ── 3. 구조 ────────────────────────────────────────────────────────
  await scene("3. 구조 (AI 동작 보기)", 35, 55, async () => {
    await cap("에이전트는 다섯 개입니다. 분류, 계획, 감시, 조치, 통합.", "심각도 점수는 AI가 정하지 않고, 감시 에이전트가 계산 함수를 도구로 불러서 받습니다. 비슷한 과거 민원은 기억으로 참고합니다.");
    await click("#dev-toggle");
    await sleep(7000);
    await click('[data-tab="sev"]');
    await sleep(5000);
    await click('[data-tab="log"]');
    await shot(send, "영상_02_AI동작보기.png");
  });
  // ── 4-① 입력 (휴대폰) ───────────────────────────────────────────────
  const PHONE_TEXT = "진주교 아래 산책로 조명이 꺼져서 깜깜하고 계단에서 넘어질 뻔했어요";
  const inFrame = (js: string) => ev(`(() => { const d = document.getElementById("demo-frame").contentDocument; return (${js})(d); })()`);
  let phoneId = 0;
  await scene("4-① 입력 (휴대폰)", 55, 70, async () => {
    await cap("방문객은 이름이나 연락처 없이 민원만 남깁니다.", `입력 문장도 시연용으로 지어낸 것입니다 — “${PHONE_TEXT}”`);
    await ev(`window.__phone(true)`);
    await until(() => inFrame(`(d) => !!d.querySelector("#rf textarea")`), 10000);
    await sleep(800);
    await inFrame(`(d) => { const s = d.querySelector('#rf select[name=zone]'); const o = [...s.options].find((x) => x.textContent.includes("진주교")); s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); }`);
    await sleep(600);
    await inFrame(`(d) => d.querySelector("#rf textarea").focus()`);
    for (let i = 1; i <= PHONE_TEXT.length; i++) {
      await inFrame(`(d) => { const t = d.querySelector("#rf textarea"); t.value = ${JSON.stringify("")} + ${JSON.stringify(PHONE_TEXT.slice(0, i))}; t.dispatchEvent(new Event("input", { bubbles: true })); }`);
      await sleep(80);
    }
    await sleep(500);
    await shot(send, "영상_03_폰입력.png");
    phoneId = (await get("/api/control")).total;
    await inFrame(`(d) => d.querySelector('#rf button[type=submit]').click()`);
    await until(() => inFrame(`(d) => !!d.querySelector(".rp-modal[open], .rp-overlay")`), 6000);
  });
  // ── 4-② 판단 ───────────────────────────────────────────────────────
  await scene("4-② 판단 (분류)", 70, 95, async () => {
    await sleep(1800);
    await inFrame(`(d) => d.querySelector("#dclose")?.click()`);
    await sleep(500);
    await ev(`window.__phone(false)`);
    await cap("분류 에이전트가 유형과 안전 여부를 정했습니다.", "오른쪽에 에이전트가 부른 도구가 기록됩니다.");
    await scrollTo(".feed", "start");
    // 방금 민원에 유형이 붙을 때까지 (있으면 그 문구로 자막을 바꾼다)
    const lab = await until(async () => {
      const c = await get("/api/control");
      const f = c.feed.find((x: any) => String(x.raw_text).includes("산책로 조명"));
      return f?.label && f.status === "done" ? f.label : null;
    }, 22000, 500);
    marks.push(`  (산책로 민원 분류: ${lab ?? "시간 안에 안 붙음"})`);
    if (lab) await cap(`분류 에이전트가 유형과 안전 여부를 정했습니다 — 방금 민원은 「${await ev(`(() => { const t = [...document.querySelectorAll(".feed li")].find((li) => li.textContent.includes("산책로 조명")); return t?.querySelector(".tag")?.textContent?.trim() ?? ""; })()`)}」입니다.`, "오른쪽에 에이전트가 부른 도구가 기록됩니다.");
    await shot(send, "영상_04_분류.png");
  });
  // ── 4-③ 유등터널 혼잡 ────────────────────────────────────────────────
  // 혼잡 2건은 실모델 분류·요청서 작성 시간을 벌려고 3~4-① 동안(0:45·0:55) 미리 들어오게 하고, 이 장면에서는 카드가 올라온 것을 보여 준다.
  const crowdCard = async () => (await get("/api/control")).issues.find((i: any) => i.label === "crowd" && i.zone_name === "유등터널") ?? null;
  // 보고서·발표용 캡처 원본은 영상이 끝난 뒤(녹화를 멈춘 뒤) 새 탭에서 자막 없이 만든다 — 녹화 중에 탭을 더 열면 영상 탭 렌더링이 멈춰 자막이 늦게 바뀐다.
  const KO0: Record<string, string> = { crowd: "혼잡", safety: "안전", parking: "주차", price: "가격", restroom: "화장실", guide: "안내" };
  await scene("4-③ 유등터널 혼잡", 95, 120, async () => {
    await cap("유등터널에서 몰림 민원이 두 건 들어왔습니다.", "건수가 더 많은 주차보다 앞으로 올라옵니다. 떠밀림 같은 위험 신호가 있는 혼잡은 안전으로 계산되기 때문입니다.");
    const card = await until(crowdCard, 14000, 500);
    marks.push(`  (혼잡 카드: ${card ? `${card.grade} · ${card.rank_no}위` : "시간 안에 안 생김"})`);
    await ev(`(() => { const c = [...document.querySelectorAll(".icard")].find((e) => e.textContent.includes("유등터널") && e.textContent.includes("혼잡")); const t = c ?? document.querySelector(".icards"); if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 90, behavior: "smooth" }); })()`);
    await sleep(3000);
    await shot(send, "영상_05_혼잡.png");
  });
  // ── 4-④ Tool → 결과 ────────────────────────────────────────────────
  await scene("4-④ 조치요청서", 120, 145, async () => {
    await cap("조치 에이전트가 담당 부서를 찾아 조치요청서를 미리 만들어 두었습니다.", "근거가 된 민원 문장과 판정 이유가 들어 있습니다.");
    await ev(`location.hash = "#action"`);
    await until(() => ev(`!!document.querySelector(".docs li, .targets li")`), 8000);
    const has = await until(() => ev(`[...document.querySelectorAll(".docs li")].some((li) => li.querySelector(".name")?.textContent.includes("혼잡"))`), 6000);
    if (!has) {                                    // 자동 요청서가 아직이면 수동 생성 장면 (대본: 수동 생성이 필요하면)
      await ev(`(() => { const li = [...document.querySelectorAll(".targets li")].find((l) => l.textContent.includes("혼잡")); li?.querySelector("[data-gen]")?.click(); })()`);
      marks.push("  (혼잡 요청서: 자동분이 아직 없어 [조치요청서 생성]을 눌렀음)");
      await until(() => ev(`[...document.querySelectorAll(".docs li")].some((li) => li.querySelector(".name")?.textContent.includes("혼잡"))`), 20000, 500);
    } else marks.push("  (혼잡 요청서: 에이전트가 자동으로 만든 것)");
    await ev(`(() => { const li = [...document.querySelectorAll(".docs li")].find((l) => l.querySelector(".name")?.textContent.includes("혼잡")); li?.querySelector("[data-toggle]")?.click(); li?.scrollIntoView({ behavior: "smooth", block: "start" }); })()`);
    await sleep(2500);
    await shot(send, "영상_06_조치요청서.png");
  });
  // ── 4-⑤ Feedback ───────────────────────────────────────────────────
  await scene("4-⑤ 조치 상태 변경", 145, 155, async () => {
    await cap("운영자가 조치 상태를 바꾸면 다음 판정에 반영됩니다.", "30분 동안 조치가 없으면 점수가 올라갑니다.");
    await ev(`(() => { const li = [...document.querySelectorAll(".docs li")].find((l) => l.querySelector(".name")?.textContent.includes("혼잡")); li?.querySelector('[data-status="in_progress"]')?.click(); })()`);
    await sleep(2000);
  });
  // ── 5. 성과 ────────────────────────────────────────────────────────
  await scene("5. 성과", 155, 168, async () => {
    await click("#dev-toggle");
    await ev(`location.hash = "#control"; window.scrollTo(0, 0)`);
    await cap("개발용 합성 데이터에서 건수 1위는 주차였지만 심각도 1위는 안전이었습니다.", "대표 시험 5건을 통과했고, 합성 32건 분류 정확도는 96.9%였습니다.");
    await sleep(1500);
    await shot(send, "영상_07_성과.png");
  });
  // ── 6. 발전·BM ─────────────────────────────────────────────────────
  await scene("6. 발전·BM", 168, 178, async () => {
    await cap("구역과 부서는 설정 데이터라 다른 축제로 옮길 때 코드를 고치지 않습니다.", "실제 축제 민원으로 다시 검증한 뒤 시군 축제 단위로 제공하려 합니다.");
  });

  recording = false; clearInterval(sampler);
  grabbing = false; await grabLoop;
  // ── 캡처 3장 (영상 밖): 4-⑤에서 '조치중'으로 바꾼 혼잡 요청서를 '요청'으로 되돌려 혼잡 카드가 다시 1위로 보이게 한 뒤, 브리핑이 맨 위 카드와 맞을 때까지 기다린다
  try {
    const crowdDoc = (await get("/api/action")).actions.find((a: any) => a.label === "crowd" && a.status !== "superseded");
    if (crowdDoc && crowdDoc.status !== "requested") {
      await fetch(`${base}/api/rpc/set_action_status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ p_id: crowdDoc.id, p_status: "requested" }) });
    }
    const sync = await until(async () => { const c = await get("/api/control"); const top = c.issues[0]; return !!(top && top.label === "crowd" && c.briefing && String(c.briefing.text).includes(KO0[top.label])); }, 45000, 1000);
    marks.push(`  (캡처 시점 브리핑이 맨 위 카드와 맞음: ${sync ? "예" : "시간 안에 안 맞음"})`);
    await tabShot("#control", "캡처_관제.png", { full: true, panel: false });
    await tabShot("#control", "캡처_AI동작.png", { panel: true, settle: 4000 });
    await tabShot("#action", "캡처_조치.png", { panel: false, settle: 1500, prep: `(async () => { const f = () => [...document.querySelectorAll(".docs li")].find((l) => l.querySelector(".name")?.textContent.includes("혼잡")); for (let i = 0; i < 40 && !f(); i++) await new Promise((r) => setTimeout(r, 250)); const li = f(); li?.querySelector("[data-toggle]")?.click(); await new Promise((r) => setTimeout(r, 600)); if (li) window.scrollTo({ top: li.getBoundingClientRect().top + window.scrollY - 80 }); })()` });
  } catch (e) { console.log("[캡처 오류] " + (e as Error).message); }

  const total = n / FPS;
  console.log(`[녹화] 끝 — 길이 ${total.toFixed(1)}초 · 프레임 ${n}`);
  // 4) ffmpeg
  mkdirSync(path.dirname(OUT), { recursive: true });
  const ff = spawnSync(FFMPEG, ["-y", "-framerate", String(FPS), "-i", path.join(frames, "f%06d.jpg"),
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", OUT], { encoding: "utf-8" });
  if (ff.status !== 0) throw new Error("ffmpeg 실패\n" + ff.stderr.slice(-800));
  console.log("\n" + marks.join("\n"));
  console.log(`\n저장: ${OUT}`);
}

try { await main(); } catch (e) { console.error(e); process.exitCode = 1; } finally { await cleanup(); process.exit(process.exitCode ?? 0); }
