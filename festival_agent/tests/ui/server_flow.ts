// 서버 동작 점검 묶음 — 스스로 webapi(운영 DB 복사본)·vite·(필요하면) 크롬을 빈 포트에 띄웠다가 끝나면 모두 끈다.
//   node tests/ui/server_flow.ts reconnect                      연결 끊김·복구 (D5-36): 서버를 실제로 껐다 켠다
//   node tests/ui/server_flow.ts perf [민원수=1000] [카드수=30]   대량 데이터 속도 (D5-37)
//   node tests/ui/server_flow.ts security                       입력·오류·연결 제한 (D5-40)
// (festival_agent 폴더에서.) 출력: ✓ 통과 · ✗ 실패 · ○ 건너뜀. 실패가 있으면 종료 코드 1. 다른 점검·다른 세션의 서버에는 영향이 없다.
//
// reconnect  관제: 연결되면 '실시간' → 서버를 끄면 '재연결 중' → 8초 넘게 안 붙으면 배너(서버에 연결할 수 없습니다 · 마지막 갱신 HH:MM)
//            → 켜면 새로고침 없이 '실시간' 복귀 · 그 사이 변화도 다시 그림 · 끊긴 채 다시 그려도 화면이 지워지지 않음.
//            방문객: 꺼진 채 접수하면 입력·구역이 남고 버튼이 '다시 시도', 켠 뒤 재시도하면 접수함에 정확히 1건.
// perf       민원 1,000건·카드 30장 복사본에서 /api/control 응답(SSE 30개 연결 중 포함)·관제 첫 그리기·변경→화면 반영·그동안 브라우저 작업 시간을 잰다.
// security   17KB 본문 413 · Content-Length 음수 400 · 배열/깨진 JSON/모르는 인자 400 고정 문구 · text/plain 415 · 동시 같은 글 1건 ·
//            SSE 51번째 503 · 멈춘 요청 끊김 · 500 응답에 경로·SQL 없음 (마지막에 표를 일부러 지워 서버 오류를 만든다 — 복사본이라 안전).
import { freePort, killTree, openChrome, quitChrome, reporter } from "./lib.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..", "..");
const WEB = join(APP, "web");
const VITE = join(WEB, "node_modules", "vite", "bin", "vite.js");
const SLOW = Math.max(1, Number(process.env.UI_SLOW) || 1);
const MODE = process.argv[2];
const R = reporter();
const { ok, bad, check } = R;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * SLOW));
const until = async <T>(fn: () => Promise<T>, ms = 6000, step = 200): Promise<T | null> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms * SLOW) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, step)); }
  return null;
};
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const r1 = (x) => Math.round(x * 10) / 10;

// ── 공통 준비·정리 ────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "ui-suite-srv-"));
const kids = [];
let chrome, ws, send, ev;                      // 크롬이 필요한 묶음에서만 채워진다
async function cleanup() {
  try { if (chrome) await quitChrome(chrome, ws); } catch { /* */ }
  for (const k of kids) killTree(k);
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 6; i++) { try { rmSync(tmp, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
}
async function die(msg) { bad(msg); await cleanup(); process.exit(1); }
process.on("uncaughtException", async (e) => { bad("점검 중 예외", String(e?.stack ?? e).split("\n").slice(0, 3).join(" / ")); await cleanup(); process.exit(1); });

/** 운영 DB 복사본 만들기 (big=[민원수, 카드수] 면 대량 데이터 모드) */
function makeDb(name: string, big?: [number, number]): string | null {
  const p = join(tmp, name);
  const r = spawnSync(process.execPath, [join(HERE, "make_mobile_db.ts"), p, ...(big ? ["--big", String(big[0]), String(big[1])] : [])], { cwd: APP, encoding: "utf-8", env: { ...process.env, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "" } });
  return r.status === 0 ? p : null;
}
/** webapi 를 빈 포트에 띄운다. port 를 주면 그 포트에(다시 켜기용). 반환: { port, base, proc } 또는 null */
async function startApi(db: string, env: Record<string, string> = {}, port?: number): Promise<{ port: number; base: string; proc: ChildProcess } | null> {
  port ??= await freePort();
  const proc = spawn(process.execPath, ["server/webapi.ts", "--port", String(port)], { cwd: APP, stdio: "ignore",
    env: { ...process.env, DB_PATH: db, LLM_BACKEND: "local", SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", ...env } });
  kids.push(proc);
  const base = `http://127.0.0.1:${port}`;
  const up = await until(async () => (await fetch(`${base}/api/zones`)).ok, 25000, 300);
  return up ? { port, base, proc } : null;
}
/** vite 개발 서버를 그 webapi 에 붙여 띄운다. 반환: base 주소 또는 null */
async function startVite(apiPort) {
  const port = await freePort();
  kids.push(spawn(process.execPath, [VITE, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB, env: { ...process.env, WEBAPI_PORT: String(apiPort), VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", VITE_NO_WATCH: "1" }, stdio: "ignore" }));
  const base = `http://127.0.0.1:${port}`;
  return (await until(async () => (await fetch(`${base}/api/control`)).ok, 30000, 300)) ? base : null;
}
const inboxCount = (db) => { const h = new DatabaseSync(db, { readOnly: true }); try { return Number(h.prepare("SELECT COUNT(*) c FROM feedback_inbox").get().c); } finally { h.close(); } };
const newCode = (p) => p + Math.random().toString(36).slice(2);

// ══ reconnect ═════════════════════════════════════════════════════
async function reconnect() {
  const DB = makeDb("recon.db");
  if (!DB) return die("준비: DB 복사본 만들기");
  const adminCode = newCode("recon-");
  let a = await startApi(DB, { ADMIN_CODE: adminCode });
  if (!a) return die("준비: webapi 가 안 뜸");
  const apiPort = a.port;
  const startApiAgain = async () => { a = await startApi(DB, { ADMIN_CODE: adminCode }, apiPort); return !!a; };   // 같은 포트에 다시
  const stopApi = () => { killTree(a?.proc); };
  const total = async () => (await (await fetch(`http://127.0.0.1:${apiPort}/api/control`)).json()).data.total;
  const inbox = () => inboxCount(DB);
  const base = await startVite(apiPort);
  if (!base) return die("준비: vite 가 안 뜸");
  ({ chrome, ws, send, ev } = await openChrome({ prefix: "ui-suite-recon-", width: 1280, height: 900 }));
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

  let up = await startApiAgain();
  check("관제: 서버를 다시 켜면 (webapi 기동)", up);
  check("관제: 저절로 '실시간'으로 돌아옴 (새로고침 없이)", !!(await until(async () => (await text("#live")).startsWith("실시간"), 40000)), await text("#live"));
  check("관제: 배너가 사라짐", !!(await until(async () => !(await visible("#conn-banner")), 8000)));
  // 서버가 없던 사이의 변화를 복구하는지: 다시 붙은 뒤 민원 1건을 지워(관리자 코드는 이 스크립트가 만든 테스트 서버 것) 누적이 바뀌는지 본다.
  const t0 = await total();
  const victim = (await (await fetch(`http://127.0.0.1:${apiPort}/api/control`)).json()).data.feed[0]?.id;
  const del = await fetch(`http://127.0.0.1:${apiPort}/api/rpc/delete_feedback`, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Code": adminCode }, body: JSON.stringify({ p_id: victim }) });
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

  up = await startApiAgain();
  const t1 = up ? inbox() : -1;
  await ev(`document.querySelector("#rf button").click()`);
  check("방문객: 서버를 켜고 '다시 시도' → 접수 완료 창", !!(await until(() => ev(`!!document.querySelector(".rp-modal")`), 10000)));
  check("방문객: 접수함에 정확히 1건 늘어남 (실패한 시도는 저장되지 않았고, 재시도는 한 번만)", up && inbox() === t1 + 1, `${t1} → ${inbox()}`);

}

// ══ perf ═════════════════════════════════════════════════════════
async function perf() {
  const N = Number(process.argv[3] ?? 1000), M = Number(process.argv[4] ?? 30);
  // 예산(ms) — 기계가 바쁘면(UI_SLOW) 같은 배율로 늘린다. 체감 기준: 0.2초 안이면 즉시, 1초 안이면 끊김 없음.
  const BUDGET = { controlMedian: 150, controlMax: 600, firstDraw: 2500, redrawWork: 400, feedToScreen: 4000 };
  const DB = makeDb("big.db", [N, M]);
  if (!DB) return die("준비: 큰 DB 복사본 만들기");
  const CODE = newCode("perf-");
  const a = await startApi(DB, { ADMIN_CODE: CODE });
  if (!a) return die("준비: webapi 가 안 뜸");
  const PA = a.base;
  const base = await startVite(a.port);
  if (!base) return die("준비: vite 가 안 뜸");
  const c0 = (await (await fetch(`${PA}/api/control`)).json()).data;
  check(`준비: 민원 ${N}건 이상 · 카드 ${M}장 규모`, c0.total >= N && (c0.issues?.length ?? 0) >= M, `total ${c0.total} · 카드 ${c0.issues?.length}`);

  // ① /api/control 응답 시간 (서버 직접, 순차 30회 — 첫 회는 워밍업이라 뺀다)
  const ms = [];
  let bytes = 0;
  for (let i = 0; i < 31; i++) {
    const t = performance.now();
    const r = await fetch(`${PA}/api/control`); const txt = await r.text();
    if (i > 0) ms.push(performance.now() - t);
    bytes = txt.length;
  }
  const cm = median(ms), cx = Math.max(...ms);
  ok(`측정 /api/control: 중앙값 ${r1(cm)}ms · 최대 ${r1(cx)}ms · 응답 ${Math.round(bytes / 1024)}KB`);
  check("/api/control 중앙값", cm <= BUDGET.controlMedian * SLOW, `${r1(cm)}ms (예산 ${BUDGET.controlMedian * SLOW})`);
  check("/api/control 최대", cx <= BUDGET.controlMax * SLOW, `${r1(cx)}ms (예산 ${BUDGET.controlMax * SLOW})`);
  // 관제 화면을 여러 대가 켜 둔 상황: SSE 30개를 붙인 채로 다시 잰다 (연결마다 1초에 한 번 DB 를 훑으면 응답이 느려진다 — webapi 는 그 조회를 공유한다)
  const acs = [];
  for (let i = 0; i < 30; i++) { const ac = new AbortController(); acs.push(ac); fetch(`${PA}/api/events`, { signal: ac.signal }).then(async (r) => { for await (const _ of r.body as unknown as AsyncIterable<Uint8Array>) { /* 받기만 */ } }).catch(() => {}); }
  await sleep(2500);
  const ms30 = [];
  for (let i = 0; i < 21; i++) { const t = performance.now(); await (await fetch(`${PA}/api/control`)).text(); if (i > 0) ms30.push(performance.now() - t); }
  const cm30 = median(ms30);
  ok(`측정 /api/control (SSE 30개 연결 중): 중앙값 ${r1(cm30)}ms · 최대 ${r1(Math.max(...ms30))}ms`);
  check("SSE 30개 연결 중 /api/control 중앙값", cm30 <= BUDGET.controlMedian * 2 * SLOW, `${r1(cm30)}ms (예산 ${BUDGET.controlMedian * 2 * SLOW})`);
  for (const ac of acs) ac.abort();
  // 나머지 읽기도 같이 (조치 화면)
  const ta = performance.now(); await (await fetch(`${PA}/api/action`)).text();
  ok(`측정 /api/action: ${r1(performance.now() - ta)}ms`);

  ({ chrome, ws, send, ev } = await openChrome({ prefix: "ui-suite-perf-", width: 1280, height: 900 }));
  await send("Performance.enable");
  const metrics = async () => Object.fromEntries(((await send("Performance.getMetrics"))?.metrics ?? []).map((m) => [m.name, m.value]));
  const busyOf = (a, b) => ((b.ScriptDuration - a.ScriptDuration) + (b.LayoutDuration - a.LayoutDuration) + (b.RecalcStyleDuration - a.RecalcStyleDuration)) * 1000;
  // ② 관제 첫 그리기: 주소를 연 뒤 카드가 화면에 나올 때까지
  await send("Page.navigate", { url: "about:blank" });
  await sleep(300);
  const m0 = await metrics();
  const t0 = performance.now();
  await send("Page.navigate", { url: `${base}/#control` });
  const drawn = await until(() => ev(`document.querySelectorAll("#app .icard, #app details[data-grp], #app .hero-main").length > 0 && document.getElementById("app").innerText.length > 500`), 20000, 50);
  const firstDraw = performance.now() - t0;
  const nodes = await ev(`document.getElementById("app").getElementsByTagName("*").length`);
  ok(`측정 관제 첫 그리기: ${Math.round(firstDraw)}ms · 화면 요소 ${nodes}개`);
  check("관제 첫 그리기에 카드가 나옴", !!drawn);
  check("관제 첫 그리기 시간", firstDraw <= BUDGET.firstDraw * SLOW, `${Math.round(firstDraw)}ms (예산 ${BUDGET.firstDraw * SLOW})`);
  await sleep(800);

  // ③ SSE 로 한 번 다시 그리기: 민원 1건을 지워 변화를 일으키고, 화면에 반영될 때까지(서버 감지 1초 + 0.5초 모음 포함) + 그동안 브라우저가 일한 시간
  const total0 = (await (await fetch(`${PA}/api/control`)).json()).data;
  const victim = total0.feed[0].id;
  const mA = await metrics();
  const tc = performance.now();
  const del = await fetch(`${PA}/api/rpc/delete_feedback`, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Code": CODE }, body: JSON.stringify({ p_id: victim }) });
  const reflected = await until(() => ev(`document.getElementById("app").innerText.includes("누적 ${total0.total - 1}")`), 15000, 50);
  const feedToScreen = performance.now() - tc;
  await sleep(600);
  const mB = await metrics();
  const work = busyOf(mA, mB);
  ok(`측정 변경→화면 반영: ${Math.round(feedToScreen)}ms · 그동안 브라우저 작업(스크립트+레이아웃+스타일) ${Math.round(work)}ms`);
  check("변경이 화면에 반영됨", del.ok && !!reflected);
  check("변경→화면 반영 시간", feedToScreen <= BUDGET.feedToScreen * SLOW, `${Math.round(feedToScreen)}ms (예산 ${BUDGET.feedToScreen * SLOW})`);
  check("다시 그리기 때 브라우저 작업 시간", work <= BUDGET.redrawWork * SLOW, `${Math.round(work)}ms (예산 ${BUDGET.redrawWork * SLOW})`);
  void m0;

}

// ══ security ═════════════════════════════════════════════════════
async function security() {
  const DB = makeDb("sec.db");
  if (!DB) return die("준비: DB 복사본");
  const A = await startApi(DB, { ADMIN_CODE: newCode("sec-") });
  const B = await startApi(DB, { ADMIN_CODE: newCode("sec-"), WEBAPI_REQUEST_TIMEOUT: "2" });
  if (!A || !B) return die("준비: webapi 가 안 뜸");
  const JSON_H: Record<string, string> = { "Content-Type": "application/json" };
  // post 는 {status, body}, raw 는 {buf, closed, ms} 를 돌려준다 — 한 변수에 번갈아 담으므로 한 모양으로 묶는다
  interface Reply { status?: number; body?: any; buf?: string; closed?: boolean; ms?: number }
  const post = async (name: string, body: string, headers: Record<string, string> = JSON_H, base: string = A.base): Promise<Reply> => {
    const r = await fetch(`${base}/api/rpc/${name}`, { method: "POST", headers, body });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const inbox = () => inboxCount(DB);
  // 원시 소켓: 헤더를 마음대로 보낸다 (fetch 는 Content-Length 를 제멋대로 못 쓴다)
  const raw = (port: number, text: string, waitMs = 3000): Promise<Reply> => new Promise((res) => {
    const s = net.connect({ port, host: "127.0.0.1" }); let buf = ""; const t0 = Date.now(); let closed = false;
    s.on("connect", () => s.write(text));
    s.on("data", (d) => { buf += d.toString("utf8"); });
    s.on("close", () => { closed = true; res({ buf, closed, ms: Date.now() - t0 }); });
    s.on("error", () => { res({ buf, closed: true, ms: Date.now() - t0 }); });
    setTimeout(() => { if (!closed) { s.destroy(); res({ buf, closed: false, ms: Date.now() - t0 }); } }, waitMs * SLOW);
  });

  // ① 본문 크기
  const before0 = inbox();
  let r: Reply = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "x".repeat(17 * 1024) }));
  check("17KB 본문 → 413", r.status === 413, `status ${r.status} ${JSON.stringify(r.body)}`);
  r = await raw(A.port, `POST /api/rpc/submit_feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: -1\r\n\r\n`);
  check("Content-Length −1 → 400 을 바로 돌려주고 끝냄 (멈추지 않음)", /^HTTP\/1\.\d 400/.test(r.buf) && r.closed && r.ms < 2500 * SLOW, `${r.buf.split("\r\n")[0]} · ${r.ms}ms`);
  r = await raw(A.port, `POST /api/rpc/submit_feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: abc\r\n\r\n`);
  check("Content-Length 가 숫자가 아니면 400", /^HTTP\/1\.\d 400/.test(r.buf), r.buf.split("\r\n")[0]);
  r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "본문 크기 점검용 정상 접수: 16KB 이하는 통과" }));
  check("정상 크기 접수는 통과", r.status === 200, `status ${r.status}`);

  // 같은 글을 동시에 여러 번 (두 번 누르기·재시도): 접수함에 한 건만, 모두 같은 접수번호 (D5-33 · intake.accept 의 락)
  const nDup0 = inbox();
  const dupBody = JSON.stringify({ p_zone_id: 1, p_text: "동시 접수 점검: 같은 글을 여덟 번 동시에 보내도 한 건이어야 함" });
  const dups = await Promise.all(Array.from({ length: 8 }, () => post("submit_feedback", dupBody)));
  const nos = new Set(dups.map((x) => x.body.data));
  check("같은 글 동시 8번 → 접수함에 1건, 접수번호 하나", dups.every((x) => x.status === 200) && inbox() === nDup0 + 1 && nos.size === 1, `+${inbox() - nDup0}건 · 번호 ${[...nos].join(",")} · 상태 ${[...new Set(dups.map((x) => x.status))].join(",")}`);

  // ② 오류 문구 — 내부 정보 없음
  const LEAK = /keyword|argument|submit_feedback\(|Traceback|sqlite|\.py|Error\b|[A-Za-z]:\\|no such|OperationalError|SELECT |DB_PATH/i;
  const cases = [["배열 JSON", "[1,2,3]"], ["문자열 JSON", '"abc"'], ["깨진 JSON", "{not json"], ["모르는 인자", JSON.stringify({ p_zone_id: 1, p_text: "안녕하세요 점검", p_bogus: 1 })]];
  for (const [label, body] of cases) {
    r = await post("submit_feedback", body);
    check(`${label} → 400 고정 문구 (함수·인자·경로 이름 없음)`, r.status === 400 && !LEAK.test(r.body.error ?? ""), `${r.status} ${r.body.error}`);
  }
  r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "." }));
  check("입력 검사 문구(사용자용)는 그대로 전달", r.status === 400 && /적어 주세요|조금 더/.test(r.body.error ?? ""), `${r.status} ${r.body.error}`);

  // ③ Content-Type
  const n1 = inbox();
  r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "교차 출처 단순 요청 점검: 저장되면 안 됨" }), { "Content-Type": "text/plain" });
  check("text/plain POST → 415", r.status === 415, `status ${r.status}`);
  r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "본문 형식 없음 점검: 저장되면 안 됨" }), {});
  check("Content-Type 없는 POST 도 거절", r.status === 415 || r.status === 400, `status ${r.status}`);
  check("거절된 요청은 저장되지 않음", inbox() === n1, `접수함 ${n1} → ${inbox()}`);
  r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "application/json; charset=utf-8 도 통과해야 하는 접수" }), { "Content-Type": "application/json; charset=utf-8" });
  check("application/json; charset=utf-8 는 통과", r.status === 200, `status ${r.status}`);

  // ④ SSE 연결 상한 (서버 기본 50)
  const acs = [];
  let okCount = 0;
  for (let i = 0; i < 50; i++) { const ac = new AbortController(); acs.push(ac); const x = await fetch(`${A.base}/api/events`, { signal: ac.signal }).catch(() => null); if (x?.status === 200) okCount++; }
  check("SSE 50개까지 연결됨", okCount === 50, `${okCount}개`);
  const extra = await fetch(`${A.base}/api/events`).catch(() => null);
  check("SSE 51번째 → 503", extra?.status === 503, `status ${extra?.status}`);
  await extra?.body?.cancel().catch(() => {});
  acs[0].abort();
  const again = await until(async () => { const ac = new AbortController(); const x = await fetch(`${A.base}/api/events`, { signal: ac.signal }); const s = x.status; ac.abort(); return s === 200 ? true : null; }, 8000, 500);
  check("하나를 끊으면 다시 붙을 수 있음", !!again);
  for (const ac of acs) ac.abort();

  // ⑤ 요청 제한 시간 (이 서버는 WEBAPI_REQUEST_TIMEOUT=2): 본문을 덜 보내고 멈추면 끊긴다
  r = await raw(B.port, `POST /api/rpc/submit_feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"p_zone`, 8000);
  check("느리게 보내다 멈춘 요청은 제한 시간 뒤 끊김 (2초 설정)", r.closed && r.ms < 6000 * SLOW, `${r.ms}ms · 닫힘 ${r.closed}`);
  const alive = await fetch(`${B.base}/api/zones`).then((x) => x.ok).catch(() => false);
  check("끊긴 뒤에도 서버는 정상 응답", alive);

  // ⑥ 서버 오류(500) 응답에 내부 정보 없음 — 복사본에서 severity 표를 지워 일부러 오류를 만든다
  { const h = new DatabaseSync(DB); h.exec("DROP TABLE severity"); h.close(); }
  const g = await fetch(`${A.base}/api/control`);
  const gb = await g.json().catch(() => ({}));
  check("서버 오류 → 500 고정 문구", g.status === 500 && gb.error === "서버 오류", `${g.status} ${JSON.stringify(gb)}`);
  check("500 응답에 경로·SQL·표 이름이 없음", !LEAK.test(String(gb.error)) && !/severity|festival\.db|ui-suite/i.test(JSON.stringify(gb)), JSON.stringify(gb));

}

const MODES = { reconnect, perf, security };
if (!MODES[MODE]) { console.error("사용: node tests/ui/server_flow.ts reconnect|perf|security"); process.exit(2); }
await MODES[MODE]();
R.summary();
await cleanup();
process.exit(R.failed ? 1 : 0);
