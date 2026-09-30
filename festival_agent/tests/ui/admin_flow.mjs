// 관리자 화면(관제·조치) 기능 점검 — 헤드리스 크롬(CDP) + 실시간 연결(SSE) 직접 구독.
//   node tests/ui/admin_flow.mjs <base>      예: http://127.0.0.1:5174  (복사본 DB 를 붙인 서버에서만!)
// 출력: ✓ 통과 · ✗ 실패 · ○ 건너뜀(아직 없는 기능). 실패가 있으면 종료 코드 1.
//
// 관제 화면은 두 모양이다 — 서버가 issues[] 를 주면 '조치할 일 카드'(D5-29), 안 주면 옛 '심각도 1위 카드'.
// 지금 어느 쪽인지 화면에서 알아내 그쪽을 점검한다.
//
// 운영자 코드(D5-31): 서버가 관리자 동작에 코드를 요구하므로, 테스트용 코드를 환경변수 UI_ADMIN_CODE 로 받는다
// (run_all 이 무작위 값을 만들어 테스트 webapi 의 ADMIN_CODE 와 여기에 같이 넣는다).
//
// 운영 DB 에 돌리지 말 것: 조치 상태를 바꿨다 되돌리고, 요청서 생성을 요청하고, 민원을 지웠다 되살린다.
// (요청서 '생성' 자체는 워커가 하므로 여기서는 요청이 접수돼 대기 중으로 보이는 데까지만 본다.)
import { quitChrome } from "./chrome_util.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const CODE = process.env.UI_ADMIN_CODE ?? "";
if (!base) { console.error("사용: node tests/ui/admin_flow.mjs <base>"); process.exit(2); }

// ── 출력 ──────────────────────────────────────────────────────────
let failed = 0, passed = 0, skipped = 0;
const ok = (name, detail = "") => { passed++; console.log(`✓ ${name}${detail ? "  — " + detail : ""}`); };
const bad = (name, detail = "") => { failed++; console.log(`✗ ${name}${detail ? "  — " + detail : ""}`); };
const check = (name, cond, detail = "") => (cond ? ok(name, detail) : bad(name, detail));
const skip = (name, why) => { skipped++; console.log(`○ ${name}  — 건너뜀: ${why}`); };
// 기계가 바쁘면(다른 프로그램이 CPU 를 쓰면) 화면이 늦게 반응한다. run_all 이 CPU 사용률을 재서 UI_SLOW(1~3)를 넘기면
// 기다리는 시간만 그 배율로 늘린다 — 검사 기준은 그대로다.
const SLOW = Math.max(1, Number(process.env.UI_SLOW) || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));
const until = async (fn, ms = 6000, step = 150) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms * SLOW) return null; await new Promise((r) => setTimeout(r, step)); }
};

// ── API (vite 프록시 경유 = 화면과 같은 길) ─────────────────────────
const get = async (p) => (await (await fetch(base + p)).json()).data;
const headerSafe = (s) => /^[\x20-\x7e]+$/.test(s);      // HTTP 헤더에는 영문·숫자·기호만 실린다 — 한글 등이 섞인 코드는 본문 p_code 로 (화면과 같은 규칙)
const rpc = async (name, body, code = CODE) => {       // code=null → 일부러 코드 없이 보낸다
  const viaHeader = !!code && headerSafe(code);
  const payload = code && !viaHeader ? { ...body, p_code: code } : body;
  const r = await fetch(`${base}/api/rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json", ...(viaHeader ? { "X-Admin-Code": code } : {}) }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j.data, error: j.error };
};

// ── SSE 를 Node 에서 직접 구독 (브라우저와 별개로 서버가 변화를 알리는지) ──
const sse = { events: [], ac: new AbortController() };
(async () => {
  try {
    const res = await fetch(base + "/api/events", { signal: sse.ac.signal });
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = block.match(/^event: (\w+)/m);
        if (m) sse.events.push({ t: Date.now(), name: m[1] });
      }
    }
  } catch { /* 종료 */ }
})();
const sseSince = (t, name) => sse.events.some((e) => e.t >= t && e.name === name);

// ── 크롬 ──────────────────────────────────────────────────────────
const port = 10000 + Math.floor(Math.random() * 500);
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "adm-"))}`, `--remote-debugging-port=${port}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const n = ++seq; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
const go = async (hash) => {
  await send("Page.navigate", { url: `${base}/#${hash}` });
  await send("Page.reload");          // 같은 주소의 해시 이동은 다시 그리지 않을 수 있어 새로 연다
  await until(() => ev(`document.getElementById("app")?.children.length > 0`), 8000);
  await sleep(700);
};
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const qa = (sel) => `document.querySelectorAll(${JSON.stringify(sel)})`;
const exists = (sel) => ev(`!!${q(sel)}`);
const count = (sel) => ev(`${qa(sel)}.length`);
const click = (sel) => ev(`(() => { const e = ${q(sel)}; if (!e) return false; e.click(); return true; })()`);
const text = (sel) => ev(`${q(sel)}?.textContent?.trim().replace(/\\s+/g, " ") ?? ""`);
const shown = (sel) => ev(`(() => { const e = ${q(sel)}; return !!e && e.getClientRects().length > 0 && !e.hidden; })()`);
// 화면이 다시 그려졌는지 보려고 #app 의 첫 자식에 표식을 달아 둔다 (다시 그리면 사라진다)
const markApp = () => ev(`(() => { const c = document.getElementById("app").firstElementChild; if (c) c.__mark = 1; return !!c; })()`);
const redrawn = (ms = 6000) => until(() => ev(`!document.getElementById("app").firstElementChild?.__mark`), ms);
// 이 민원 번호(data-fid)가 화면에 '보이는' 곳의 수 (지우는 중 leaving · 숨김 gone 은 안 센다)
const visibleFid = (id) => ev(`[...document.querySelectorAll('[data-fid="${id}"]')].filter((e) => !e.classList.contains("gone") && !e.classList.contains("leaving") && e.getClientRects().length > 0).length`);

const crash = async (e) => {
  console.log(`✗ 점검 스크립트가 예외로 멈춤  — ${String(e?.message ?? e).slice(0, 160)}`);
  try { sse.ac.abort(); await quitChrome(chrome, ws); } catch { /* */ }
  process.exit(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

await send("Page.enable"); await send("Runtime.enable");

// ══ 0. 서버 ═══════════════════════════════════════════════════════
await until(() => sse.events.some((e) => e.name === "ready"), 6000);
check("서버 실시간 연결(SSE) — ready", sse.events.some((e) => e.name === "ready"));
const control0 = await get("/api/control");
const action0 = await get("/api/action");
check("API /api/control · /api/action 응답", control0 && action0 && Array.isArray(action0.actions), `요청서 ${action0?.actions?.length ?? "?"}건 · 유입 ${control0?.feed?.length ?? "?"}건`);

// ══ 0.5 운영자 코드 보호 (D5-31) ═══════════════════════════════════
// 서버 수준: 코드 없이·틀린 코드로는 관리자 동작이 실행되지 않고, 방문객 접수는 코드 없이 된다.
const probeAdmin = await rpc("check_admin", {}, null);
if (probeAdmin.status === 404) skip("운영자 코드 보호", "서버에 check_admin 이 없음 (D5-31 서버 미구현)");
else if (probeAdmin.status === 403) bad("운영자 코드 보호: 테스트 서버에 코드가 설정돼 있어야 함", "403 — 서버의 ADMIN_CODE 가 비어 있음 (run_all 은 무작위 코드를 넣는다)");
else if (!CODE) bad("운영자 코드 보호: 테스트용 코드(UI_ADMIN_CODE)가 없음", "run_all 로 돌리거나 환경변수로 넘길 것");
else {
  check("코드 보호(서버): 코드 없이 관리자 동작 → 401 거부", probeAdmin.status === 401, `status ${probeAdmin.status} · ${probeAdmin.error}`);
  const victim = control0.feed?.[0]?.id;
  const noCode = victim == null ? null : await rpc("delete_feedback", { p_id: victim }, null);
  const wrongCode = victim == null ? null : await rpc("delete_feedback", { p_id: victim }, "wrong-code");
  check("코드 보호(서버): 민원 지우기 — 코드 없음·틀림은 거부", victim == null || (noCode.status === 401 && wrongCode.status === 401), `${noCode?.status}/${wrongCode?.status}`);
  check("코드 보호(서버): 거부된 지우기는 실행되지 않음", victim == null || (await get("/api/control")).feed.some((f) => f.id === victim));
  const a0 = action0.actions.find((a) => a.status !== "superseded");
  if (a0) {
    const st = await rpc("set_action_status", { p_id: a0.id, p_status: "done" }, null);
    check("코드 보호(서버): 조치 상태 변경 — 코드 없음은 거부·실행 안 됨", st.status === 401 && (await get("/api/action")).actions.find((a) => a.id === a0.id)?.status === a0.status, `status ${st.status}`);
  }
  const rd = await rpc("request_doc", { p_label: "safety" }, null);
  check("코드 보호(서버): 조치요청서 생성 — 코드 없음은 거부", rd.status === 401, `status ${rd.status}`);
  const visit = await rpc("submit_feedback", { p_zone_id: 1, p_text: "코드 없이 접수되는지 점검" }, null);
  check("코드 보호(서버): 방문객 접수는 코드 없이 통과", visit.status === 200, `status ${visit.status}`);

  // 화면 수준 — 깨끗한 탭(코드 없음)에서 처음 누르면 입력 창
  await go("control");
  await ev(`sessionStorage.clear(); localStorage.clear();`);
  const delBtn = ".feed [data-del]";
  if (!(await exists(delBtn))) skip("코드 보호(화면)", "화면에 [민원 지우기] 버튼이 없음");
  else {
    const id = await ev(`${q(delBtn)}.dataset.del`);
    const total0 = (await get("/api/control")).total;
    await click(delBtn);
    const modal = await until(() => exists(".adm-overlay"), 3000);
    check("코드 보호(화면): 처음 지우기를 누르면 코드 입력 창", !!modal && (await ev(`!!${q(".adm-modal")}.getAttribute("role") && document.activeElement?.id === "adm-code"`)), "입력칸에 포커스");
    check("코드 보호(화면): 코드를 넣기 전에는 지워지지 않음 (서버에 안 보냄)", (await get("/api/control")).total === total0 && (await visibleFid(id)) > 0);
    check("코드 보호(화면): 입력 창은 가려진 입력(password)·16px 이상", await ev(`${q("#adm-code")}.type === "password" && parseFloat(getComputedStyle(${q("#adm-code")}).fontSize) >= 16`));

    await click(".adm-cancel"); await until(async () => !(await exists(".adm-overlay")), 2000);
    check("코드 보호(화면): 취소 → 창이 닫히고 민원은 그대로", !(await exists(".adm-overlay")) && !!(await until(async () => (await visibleFid(id)) > 0, 3000)));
    check("코드 보호(화면): 취소하면 안내 토스트", !!(await until(() => ev(`/취소/.test(document.getElementById("toasts").textContent)`), 2000)));

    await click(delBtn); await until(() => exists(".adm-overlay"), 3000);
    await ev(`(() => { document.getElementById("adm-code").value = "wrong-code"; })()`); await click(".adm-ok");
    check("코드 보호(화면): 틀린 코드 → 창이 남고 오류 표시", !!(await until(() => ev(`!document.querySelector(".adm-err").hidden && /맞지 않/.test(document.querySelector(".adm-err").textContent)`), 4000)) && (await exists(".adm-overlay")), await text(".adm-err"));
    check("코드 보호(화면): 틀린 코드로는 지워지지 않음", (await get("/api/control")).total === total0);

    await ev(`(() => { document.getElementById("adm-code").value = ${JSON.stringify(CODE)}; })()`); await click(".adm-ok");
    check("코드 보호(화면): 맞는 코드 → 창이 닫히고 지우기 성공", !!(await until(async () => !(await exists(".adm-overlay")) && (await visibleFid(id)) === 0, 5000)));
    check("코드 보호(화면): 서버에서도 지워짐 (총 건수 -1)", !!(await until(async () => (await get("/api/control")).total === total0 - 1, 4000)));
    const where = JSON.parse(await ev(`JSON.stringify({ session: Object.keys(sessionStorage).some((k) => sessionStorage.getItem(k) === ${JSON.stringify(CODE)}),
      local: Object.keys(localStorage).some((k) => localStorage.getItem(k) === ${JSON.stringify(CODE)} || /admin|code/i.test(k)),
      dom: document.documentElement.outerHTML.includes(${JSON.stringify(CODE)}), url: location.href.includes(${JSON.stringify(CODE)}) })`));
    check("코드 보관: sessionStorage 에만 (localStorage · 화면 · 주소에는 없음)", where.session && !where.local && !where.dom && !where.url, JSON.stringify(where));
    await click("#toasts .toast-act");
    check("코드 보호(화면): 같은 탭의 다음 관리자 동작(되돌리기)은 다시 묻지 않음", !!(await until(async () => (await visibleFid(id)) > 0, 5000)) && !(await exists(".adm-overlay")));
    await go("control");
    await click(delBtn);
    check("코드 보관: 새로고침해도 같은 탭이면 기억 (다시 묻지 않음)", !(await until(() => exists(".adm-overlay"), 1200)) && !!(await until(async () => (await visibleFid(id)) === 0, 4000)));
    await until(async () => (await get("/api/control")).total === total0 - 1, 5000);   // 화면은 즉시 숨기지만 서버 반영은 조금 늦다
    await rpc("restore_feedback", { p_id: id });                      // 원래대로
    await until(async () => (await get("/api/control")).total === total0, 5000);

    // 저장된 코드가 더 이상 안 맞을 때(코드가 바뀜) — 다시 묻는다
    await go("control");
    await ev(`sessionStorage.setItem("festival_admin_code", "old-code")`);
    const id2 = await ev(`${q(delBtn)}.dataset.del`);
    await click(delBtn);
    check("코드 보호(화면): 저장된 코드가 틀리면 다시 묻고 이유를 알림", !!(await until(() => ev(`!!document.querySelector(".adm-overlay") && /더 이상 맞지 않/.test(document.querySelector(".adm-err")?.textContent ?? "")`), 4000)), await text(".adm-err"));
    await ev(`(() => { document.getElementById("adm-code").value = ${JSON.stringify(CODE)}; })()`); await click(".adm-ok");
    check("코드 보호(화면): 다시 맞는 코드를 넣으면 이어서 실행", !!(await until(async () => (await visibleFid(id2)) === 0, 5000)));
    await until(async () => (await get("/api/control")).total === total0 - 1, 5000);
    await rpc("restore_feedback", { p_id: id2 });
    await until(async () => (await get("/api/control")).total === total0, 5000);
  }

  // 방문객 화면에는 관리자 요소를 아예 그리지 않는다
  await send("Page.navigate", { url: `${base}/?v=qr` }); await send("Page.reload");
  await until(() => ev(`document.getElementById("app")?.children.length > 0`), 8000); await sleep(700);
  check("방문객 화면: 입력 창·관리자 버튼 없음", await ev(`!document.querySelector(".adm-overlay, .adm-modal, input[type=password], [data-del], [data-gen], [data-status], #adm-code")`));
  await send("Page.navigate", { url: `${base}/?v=qr#control` }); await send("Page.reload");
  await until(() => ev(`document.getElementById("app")?.children.length > 0`), 8000); await sleep(700);
  check("방문객 화면: 주소에 #control 을 붙여도 관제가 아니라 접수 화면", await ev(`!document.querySelector(".icard, .brief, .targets, [data-del]") && !!document.querySelector("#rf, form")`));
}

// ══ A. 관제 ═══════════════════════════════════════════════════════
await go("control");
const cardMode = await exists(".icards .icard");
console.log(`· 관제 화면 모양: ${cardMode ? "조치할 일 카드 (D5-29)" : "옛 심각도 1위 카드"}`);
check("관제: 화면이 그려지고 '실시간' 연결 표시", (await text("#live")).startsWith("실시간"), await text("#live"));
check("관제: 브리핑 카드 (지금 조치할 일)", (await text(".brief .brief-text")).length > 5 || (await exists(".brief .muted")), (await text(".brief .brief-text")).slice(0, 30));
const order = await ev(`(() => { const p = (s) => document.querySelector(s); const a = p(".brief"), h = p(".icards") || p(".hero"), g = p(".grid2");
  const before = (x, y) => !!x && !!y && !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
  return before(a, h) && before(h, g); })()`);
check("관제: 읽는 순서 브리핑 → 카드(1위) → 나머지", order);

if (cardMode) {
  // ── 조치할 일 카드 (D5-29) ──
  const issues = control0.issues ?? [];
  const nCards = await count(".icard[data-key]");
  check("카드: 화면의 카드 수 = 서버 issues 수", nCards === issues.length, `화면 ${nCards} · 서버 ${issues.length}`);
  const main0 = issues.find((i) => i.grp === "main");
  if (main0) check("카드: 1위(큰) 카드가 서버가 정한 1위", (await ev(`${q(".icard.big")}?.dataset.key ?? null`)) === main0.issue_key, `${main0.issue_key}`);
  else skip("카드: 1위 카드", "서버가 '지금 조치할 일(main)' 카드를 주지 않음");
  check("카드: 카드마다 제목·위치·우선순위·해야 할 일", await ev(`[...${qa(".icard[data-key]")}].every((c) => c.querySelector(".ic-title")?.textContent.trim() && c.querySelector(".ic-zone")?.textContent.trim() && c.querySelector(".badge") && c.querySelectorAll(".ic-acts li").length >= 1)`));
  check("카드: 카드가 화면 폭을 넘치지 않음", await ev(`[...${qa(".icard[data-key]")}].every((c) => c.getBoundingClientRect().right <= window.innerWidth + 1)`));
  if (!(await exists(".icard.big"))) skip("카드: 1위 카드 펼침·계산식", "1위(main) 카드가 화면에 없음 — 테스트 DB 에 지금 조치할 카드가 하나도 없는 경우");
  if (await exists(".icard.big")) {
    check("카드: 1위 카드는 항상 펼쳐짐 (해야 할 일·담당·민원)", (await shown(".icard.big .ic-body")) && (await text(".icard.big .ic-h")).includes("해야 할 일") && (await exists(".icard.big .ic-who")) && (await count(".icard.big .ic-q")) === 2);
    if (await exists(".icard.big [data-fx]")) {
      await click(".icard.big [data-fx]"); await sleep(250);
      check("카드: 계산식 보기 → 펼침", (await shown(".icard.big .ic-fx")) && /[×=]/.test(await text(".icard.big .ic-fx")), (await text(".icard.big .ic-fx")).slice(0, 40));
      await click(".icard.big [data-fx]"); await sleep(250);
      check("카드: 계산식 접기", !(await shown(".icard.big .ic-fx")));
    }
  }
  if (await exists(".icard:not(.big) .ic-head")) {
    await click(".icard:not(.big) .ic-head"); await sleep(300);
    check("카드: 행을 누르면 펼침 (본문이 보임)", (await ev(`${q(".icard:not(.big)")}.classList.contains("open") && ${q(".icard:not(.big) .ic-head")}.getAttribute("aria-expanded") === "true"`)) && (await shown(".icard:not(.big) .ic-body")));
    await click(".icard:not(.big) .ic-head"); await sleep(300);
    check("카드: 행을 다시 누르면 접힘", !(await ev(`${q(".icard:not(.big)")}.classList.contains("open")`)) && !(await shown(".icard:not(.big) .ic-body")));
  } else skip("카드: 행 펼침", "1위 말고 다른 카드가 없음");
  if (await exists("details.igrp > summary")) {
    await click("details.igrp > summary"); await sleep(250);
    check("카드: 묶음(그 밖·조치 중·조치 완료) 펼침", await ev(`${q("details.igrp")}.open`), await text("details.igrp > summary"));
    await click("details.igrp > summary"); await sleep(250);
    check("카드: 묶음 접힘", !(await ev(`${q("details.igrp")}.open`)));
  } else skip("카드: 묶음 펼침", "묶음(그 밖·조치 중·조치 완료)이 없음");
  if (await exists("details.typerank > summary")) {
    await click("details.typerank > summary"); await sleep(250);
    check("카드: 유형별 순위 펼침 (카드 점수의 근거)", (await ev(`${q("details.typerank")}.open`)) && (await count(".typerank .rank li")) > 0, `${await count(".typerank .rank li")}개 유형`);
    if (await exists(".typerank .rank li .row")) {
      await click(".typerank .rank li .row"); await sleep(250);
      check("카드: 유형 행 → 계산식 펼침", (await ev(`${q(".typerank .rank li")}.classList.contains("open")`)) && (await shown(".typerank .rank li .formula-box")));
      await click(".typerank .rank li .row"); await sleep(250);
    }
    await click("details.typerank > summary"); await sleep(250);
  }
} else {
  // ── 옛 모양 (서버가 카드를 주지 않을 때) ──
  if (await exists(".hero")) {
    check("관제: 심각도 1위 카드에 이름·점수", /\d+(\.\d)?\s*점/.test(await text(".hero .hero-score")) && (await text(".hero .hero-name")).length > 0, `${await text(".hero .hero-name")} ${await text(".hero .hero-score")}`);
    await click("#hero-formula"); await sleep(250);
    check("관제: 계산식 보기 → 펼침", (await ev(`!${q("#hero-formula-box")}.hidden && ${q("#hero-formula")}.getAttribute("aria-expanded") === "true"`)));
    check("관제: 계산식 내용(×·=)", /[×=]/.test(await text("#hero-formula-box")), (await text("#hero-formula-box")).slice(0, 40));
    await click("#hero-formula"); await sleep(250);
    check("관제: 계산식 접기", (await ev(`${q("#hero-formula-box")}.hidden`)));
  } else skip("관제: 심각도 1위·계산식", "판정된 유형이 없음");
  if (await exists(".rank li .row")) {
    await click(".rank li .row"); await sleep(250);
    check("관제: 순위 행 펼침 → 계산식", await ev(`${q(".rank li")}.classList.contains("open") && getComputedStyle(${q(".rank li .formula-box")}).display !== "none"`));
    await click(".rank li .row"); await sleep(250);
    check("관제: 순위 행 접힘", !(await ev(`${q(".rank li")}.classList.contains("open")`)));
  } else skip("관제: 순위 행 펼침", "그다음 순위가 없음");
}

if (await exists(".alert-row")) {
  await click(".alert-row"); await sleep(250);
  check("관제: 알림 행 펼침", await ev(`${q(".alerts li")}.classList.contains("open") && ${q(".alert-row")}.getAttribute("aria-expanded") === "true"`));
  await click(".alert-row"); await sleep(250);
  check("관제: 알림 행 접힘", !(await ev(`${q(".alerts li")}.classList.contains("open")`)));
} else skip("관제: 알림 펼침", "미확인 알림이 없음");

if (await exists(".feed-item")) {
  await click(".feed-item"); await sleep(250);
  check("관제: 유입 원문 펼침(전체 보임)", await ev(`${q(".feed li")}.classList.contains("open") && getComputedStyle(${q(".feed-text")}).whiteSpace === "normal"`));
  await click(".feed-item"); await sleep(250);
  check("관제: 유입 원문 접힘(한 줄)", !(await ev(`${q(".feed li")}.classList.contains("open")`)));
} else skip("관제: 유입 원문 펼침", "유입이 없음");

// ══ B. 실시간 갱신 + 펼침 유지 (조치 상태를 바꿔 서버가 변화를 알리게 한다) ═══
const acts = action0.actions.filter((a) => a.status !== "superseded");
const pick = acts.find((a) => a.status !== "done") ?? acts[0];
const altStatus = (s) => (s === "in_progress" ? "requested" : "in_progress");
if (pick) {
  // 펼칠 수 있는 것들을 전부 펼쳐 두고
  const opened = [];
  if (cardMode) {
    if (await exists(".icard.big [data-fx]")) { await click(".icard.big [data-fx]"); opened.push("fx"); }
    if (await exists(".icard:not(.big) .ic-head")) { await click(".icard:not(.big) .ic-head"); opened.push("card"); }
    if (await exists("details.igrp > summary")) { await click("details.igrp > summary"); opened.push("grp"); }
  } else {
    if (await exists("#hero-formula")) { await click("#hero-formula"); opened.push("fx"); }
    if (await exists(".rank li .row")) { await click(".rank li .row"); opened.push("rank"); }
  }
  if (await exists(".alert-row")) { await click(".alert-row"); opened.push("alert"); }
  if (await exists(".feed-item")) { await click(".feed-item"); opened.push("feed"); }
  await sleep(300); await markApp();
  const t0 = Date.now();
  const r = await rpc("set_action_status", { p_id: pick.id, p_status: altStatus(pick.status) });
  check("상태 변경 RPC 200", r.status === 200, `#${pick.id} ${pick.status} → ${altStatus(pick.status)}`);
  check("서버가 변화를 알림(SSE change)", !!(await until(() => sseSince(t0, "change"), 5000)));
  check("화면이 스스로 다시 그려짐 (실시간)", !!(await redrawn(6000)));
  await sleep(400);
  const kept = JSON.parse(await ev(`JSON.stringify({
    fx: ${cardMode ? `!${q(".icard.big .ic-fx")}?.hidden` : `!${q("#hero-formula-box")}?.hidden`},
    card: ${q(".icard:not(.big)")}?.classList.contains("open") ?? null,
    grp: ${q("details.igrp")}?.open ?? null,
    rank: ${q(".rank li")}?.classList.contains("open") ?? null,
    alert: ${q(".alerts li")}?.classList.contains("open") ?? null,
    feed: ${q(".feed li")}?.classList.contains("open") ?? null })`));
  const lost = opened.filter((k) => kept[k] === false);
  check(`다시 그려도 펼침 유지 (${opened.join("·") || "펼칠 것 없음"})`, opened.length > 0 && lost.length === 0, lost.length ? `풀린 것: ${lost.join(", ")}` : JSON.stringify(kept));
  await rpc("set_action_status", { p_id: pick.id, p_status: pick.status });      // 되돌림
} else skip("실시간 갱신·펼침 유지", "조치요청서가 하나도 없음");

// ══ C. 조치 ═══════════════════════════════════════════════════════
await go("action");
const nTargets = await count(".targets li");
check("조치: 조치 대상 목록", nTargets > 0, `${nTargets}개`);
check("조치: 대상마다 [생성] 버튼", nTargets === await count(".targets li [data-gen]"));

const gen = await ev(`(() => { const b = [...document.querySelectorAll("[data-gen]")].find((x) => !x.disabled); return b ? b.dataset.gen : null; })()`);
if (gen) {
  const before = (await get("/api/action")).jobs.map((j) => j.id);
  await click(`[data-gen="${gen}"]`);
  const toastOk = await until(() => ev(`[...document.querySelectorAll("#toasts .toast")].some((t) => t.textContent.includes("작성을 요청했습니다"))`), 4000);
  check("요청서 생성 요청 → 안내 토스트", !!toastOk);
  const job = await until(async () => (await get("/api/action")).jobs.find((j) => j.label === gen && !before.includes(j.id)) ?? (await get("/api/action")).jobs.find((j) => j.label === gen && ["queued", "running"].includes(j.status)), 4000);
  check("요청서 생성 요청 → 서버에 작업이 쌓임", !!job, job ? `#${job.id} ${job.status} (워커는 이 테스트에 없음)` : "");
  const waitingUi = await until(() => ev(`[...document.querySelectorAll(".targets li")].some((li) => li.querySelector("[data-gen='${gen}']")?.disabled && /대기 중|작성 중/.test(li.textContent))`), 5000);
  check("요청서 생성 요청 → 화면에 '대기 중' · 버튼 잠김", !!waitingUi);
} else skip("요청서 생성 요청", "누를 수 있는 [생성] 버튼이 없음 (모두 작성 중)");

await go("action");
if (await exists(".docs:not(.old) li [data-toggle]")) {
  const id = await ev(`${q(".docs:not(.old) li [data-toggle]")}.closest("li").dataset.id`);
  await click(`.docs:not(.old) li[data-id="${id}"] [data-toggle]`); await sleep(300);
  check("조치: 미리보기 펼침(조치요청서 본문)", await ev(`getComputedStyle(${q(`.docs li[data-id="${id}"] .paper`)}).display !== "none" && ${q(`.docs li[data-id="${id}"] .paper h3`)}.textContent.includes("조치요청서")`), `#${id}`);
  const paper = await text(`.docs li[data-id="${id}"] .paper`);
  check("조치: 미리보기에 요청 사유·조치 제안", /요청 사유/.test(paper) && /조치 제안/.test(paper));
  await click(`.docs:not(.old) li[data-id="${id}"] [data-toggle]`); await sleep(300);
  check("조치: 미리보기 접힘", !(await ev(`${q(`.docs li[data-id="${id}"]`)}.classList.contains("open")`)));
} else skip("조치: 미리보기", "미리보기가 있는 요청서가 없음");

const hrefs = await ev(`[...document.querySelectorAll(".docs a.btn[href]")].slice(0, 3).map((a) => a.getAttribute("href"))`);
if (hrefs?.length) {
  const res = [];
  for (const h of hrefs) { const r = await fetch(base + h); const b = new Uint8Array(await r.arrayBuffer()); res.push({ h, s: r.status, pk: b[0] === 0x50 && b[1] === 0x4b, n: b.length, ct: r.headers.get("content-type") ?? "" }); }
  const badOnes = res.filter((x) => !(x.s === 200 && x.pk && /wordprocessingml/.test(x.ct)));
  check("조치: DOCX 링크가 실제 파일(200 · PK 압축 · docx 형식)", badOnes.length === 0,
    badOnes.length ? `깨진 링크: ${badOnes.map((x) => `${decodeURIComponent(x.h).slice(-40)} → ${x.s}`).join(", ")}` : res.map((x) => `${x.s}/${x.n}B`).join(" "));
} else skip("조치: DOCX 내려받기", "DOCX 링크가 있는 요청서가 없음");

// 상태 변경 — 화면의 세그먼트 버튼을 눌러서
const live = (await get("/api/action")).actions.find((a) => a.status !== "superseded" && a.status !== "done") ?? (await get("/api/action")).actions.find((a) => a.status !== "superseded");
if (live) {
  const to = altStatus(live.status);
  const t0 = Date.now();
  await click(`.docs:not(.old) li[data-id="${live.id}"] [data-status="${to}"]`);
  const changedApi = await until(async () => (await get("/api/action")).actions.find((a) => a.id === live.id)?.status === to, 4000);
  check("조치: 상태 버튼 → 서버 반영", !!changedApi, `#${live.id} ${live.status} → ${to}`);
  check("조치: 상태 변경 → 서버가 변화를 알림(SSE)", !!(await until(() => sseSince(t0, "change"), 5000)));
  const uiOn = await until(() => ev(`${q(`.docs li[data-id="${live.id}"] [data-status="${to}"]`)}?.classList.contains("on")`), 6000);
  check("조치: 화면의 선택 칸·상태 표시가 바뀜", !!uiOn && (await text(`.docs li[data-id="${live.id}"] .st`)).length > 0, await text(`.docs li[data-id="${live.id}"] .st`));
  await click(`.docs:not(.old) li[data-id="${live.id}"] [data-status="${live.status}"]`);
  const back = await until(async () => (await get("/api/action")).actions.find((a) => a.id === live.id)?.status === live.status, 4000);
  check("조치: 원래 상태로 되돌리기", !!back, `→ ${live.status}`);
} else skip("조치: 상태 변경", "바꿀 수 있는 요청서가 없음");

if (await exists("#toggle-old")) {
  await click("#toggle-old"); await until(() => exists(".docs.old li"), 4000);
  check("조치: 대체된 요청서 펼침 (상태 버튼 없음)", (await exists(".docs.old li")) && !(await exists(".docs.old li [data-status]")));
  await click("#toggle-old"); await until(async () => !(await exists(".docs.old")), 4000);
  check("조치: 대체된 요청서 접힘", !(await exists(".docs.old")));
} else skip("조치: 대체된 요청서", "대체된 요청서가 없음");

// ══ D. 민원 지우기·되돌리기 (D5-30) ═══════════════════════════════
// 서버(API) 수준 — 화면 버튼 유무와 상관없이
await go("control");
const fid = (await get("/api/control")).feed?.[0]?.id;
const probe = fid == null ? null : await rpc("delete_feedback", { p_id: fid });
if (fid == null) skip("지우기·되돌리기 (서버)", "유입 민원이 없음");
else if (probe.status === 404) skip("지우기·되돌리기 (서버)", "서버에 delete_feedback 이 없음");
else {
  const t0 = Date.now();
  const c1 = await get("/api/control");
  check("지우기(서버): 유입에서 빠지고 총 건수가 줄어듦", probe.status === 200 && !c1.feed.some((f) => f.id === fid) && c1.total === control0.total - 1, `#${fid} 총 ${control0.total} → ${c1.total}`);
  check("지우기(서버): 변화를 SSE 로 알림", !!(await until(() => sseSince(t0, "change"), 5000)));
  const r2 = await rpc("restore_feedback", { p_id: fid });
  const c2 = await get("/api/control");
  check("되돌리기(서버): 유입에 돌아오고 건수가 복구", r2.status === 200 && c2.feed.some((f) => f.id === fid) && c2.total === control0.total, `총 ${c2.total}`);
  const again = await rpc("delete_feedback", { p_id: 99999999 });
  check("지우기(서버): 없는 민원 번호는 오류로 거절", again.status === 400, again.error ?? `status ${again.status}`);
}

// 화면 수준 — 휴지통 버튼(aria-label '민원 지우기') → 바로 사라짐 → 토스트 '되돌리기' → 돌아옴
async function deleteFlow(area, selector) {
  await go("control");
  if (!(await exists(selector))) return skip(`지우기·되돌리기 (화면 · ${area})`, `화면에 ${area}의 [민원 지우기] 버튼이 없음`);
  const id = await ev(`${q(selector)}.dataset.del`);            // 지울 '민원 번호' (카드 번호가 아니다)
  const before = await visibleFid(id);
  const total0 = (await get("/api/control")).total;
  await click(selector);
  check(`지우기(화면·${area}): 바로 사라짐 (그 민원이 보이는 곳 ${before}곳 → 0곳)`, !!(await until(async () => (await visibleFid(id)) === 0, 2500)) && before > 0, `#${id}`);
  check(`지우기(화면·${area}): '되돌리기' 토스트`, !!(await until(() => ev(`!!document.querySelector("#toasts .toast-act")`), 3000)), await text("#toasts .toast.has-act"));
  check(`지우기(화면·${area}): 서버에서도 빠짐 (총 건수 -1)`, !!(await until(async () => (await get("/api/control")).total === total0 - 1, 4000)), `총 ${total0} → ${(await get("/api/control")).total}`);
  await click("#toasts .toast-act");
  check(`되돌리기(화면·${area}): 다시 보임`, !!(await until(async () => (await visibleFid(id)) > 0, 6000)), `#${id} ${await visibleFid(id)}곳`);
  check(`되돌리기(화면·${area}): 서버도 복구 (총 건수 원래대로)`, !!(await until(async () => (await get("/api/control")).total === total0, 4000)));
  await until(() => ev(`!document.querySelector("#toasts .toast-act")`), 3000);
}
await deleteFlow("유입", ".feed [data-del]");
await deleteFlow("카드의 최신 민원", ".icard .ic-q [data-del]");

// ══ F. 틀린 코드를 자꾸 넣으면 잠김 (D5-31) — 잠기면 이 테스트 서버의 관리자 동작이 10분간 전부 거부되므로 맨 마지막에 ═══
if (probeAdmin.status === 401 && CODE) {
  await go("control");
  await ev(`sessionStorage.clear()`);
  const fails = [];
  for (let i = 0; i < 6; i++) fails.push((await rpc("check_admin", {}, `wrong${i}`)).status);
  check("잠김(서버): 틀린 코드를 5번 넘게 → 429", fails.includes(429), fails.join(","));
  const okWhileLocked = await rpc("check_admin", {}, CODE);
  check("잠김(서버): 잠긴 동안은 맞는 코드도 거부", okWhileLocked.status === 429, `status ${okWhileLocked.status}`);
  check("잠김(서버): 방문객 접수는 잠겨도 통과", (await rpc("submit_feedback", { p_zone_id: 1, p_text: "잠금 중에도 접수되는지 점검" }, null)).status === 200);
  if (await exists(".feed [data-del]")) {
    await click(".feed [data-del]"); await until(() => exists(".adm-overlay"), 3000);
    await ev(`(() => { document.getElementById("adm-code").value = ${JSON.stringify(CODE)}; })()`); await click(".adm-ok");
    check("잠김(화면): '잠시 후 다시 시도' 안내 · 입력 막힘", !!(await until(() => ev(`/잠시 후/.test(document.querySelector(".adm-err")?.textContent ?? "") && document.getElementById("adm-code").disabled`), 4000)), await text(".adm-err"));
    await click(".adm-ok");        // 잠김 안내 창은 [닫기] 로 닫힌다
    check("잠김(화면): 닫으면 창이 사라지고 안내 토스트", !!(await until(async () => !(await exists(".adm-overlay")) && (await ev(`/시도가 너무 많/.test(document.getElementById("toasts").textContent)`)), 3000)));
  } else skip("잠김(화면)", "화면에 [민원 지우기] 버튼이 없음");
}

console.log(`\n통과 ${passed} · 실패 ${failed} · 건너뜀 ${skipped}`);
console.log(failed ? "실패 있음" : "전부 통과");
sse.ac.abort(); await quitChrome(chrome, ws);
process.exit(failed ? 1 : 0);
