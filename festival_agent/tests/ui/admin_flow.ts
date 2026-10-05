// 관리자 화면(관제·조치) 기능 점검 — 헤드리스 크롬(CDP) + 실시간 연결(SSE) 직접 구독.
//   node tests/ui/admin_flow.ts <base>      예: http://127.0.0.1:5174  (복사본 DB 를 붙인 서버에서만!)
// 출력: ✓ 통과 · ✗ 실패 · ○ 건너뜀(아직 없는 기능). 실패가 있으면 종료 코드 1.
//
// 관제 화면은 두 모양이다 — 서버가 issues[] 를 주면 '조치할 일 카드'(D5-29), 안 주면 옛 '심각도 1위 카드'.
// 지금 어느 쪽인지 화면에서 알아내 그쪽을 점검한다.
//
// 운영 DB 에 돌리지 말 것: 조치 상태를 바꿨다 되돌리고, 요청서 생성을 요청하고, 민원을 지웠다 되살린다.
// (요청서 '생성' 자체는 워커가 하므로 여기서는 요청이 접수돼 대기 중으로 보이는 데까지만 본다.)
import { openChrome, quitChrome } from "./lib.ts";
import { createRequire } from "node:module";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) { console.error("사용: node tests/ui/admin_flow.ts <base>"); process.exit(2); }

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
const rpc = async (name, body) => {
  const r = await fetch(`${base}/api/rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j.data, error: j.error };
};

// ── SSE 를 Node 에서 직접 구독 (브라우저와 별개로 서버가 변화를 알리는지) ──
const sse = { events: [], ac: new AbortController() };
(async () => {
  try {
    const res = await fetch(base + "/api/events", { signal: sse.ac.signal });
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
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
const { chrome, ws, send, ev } = await openChrome({ prefix: "adm-", width: 1280, height: 900 });
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

// ══ 0.5 관리자 동작은 코드 없이 바로 실행된다 ═══════════════════════════════════
{
  const visit = await rpc("submit_feedback", { p_zone_id: 1, p_text: "코드 없이 접수되는지 점검" });
  check("접수(서버): 코드 없이 통과", visit.status === 200, `status ${visit.status}`);
  await go("control");
  const delBtn = ".feed [data-del]";
  if (!(await exists(delBtn))) skip("지우기(화면)", "화면에 [민원 지우기] 버튼이 없음");
  else {
    const id = await ev(`${q(delBtn)}.dataset.del`);
    const total0 = (await get("/api/control")).total;
    await click(delBtn);
    check("지우기(화면): 누르면 코드 창 없이 바로 사라진다", !(await exists(".adm-overlay")) && !!(await until(async () => (await visibleFid(id)) === 0, 3000)));
    check("지우기(화면): 서버에서도 지워짐 (총 건수 -1)", !!(await until(async () => (await get("/api/control")).total === total0 - 1, 4000)));
    await click("#toasts .toast-act");
    check("지우기(화면): [되돌리기]도 코드 없이 바로 — 다시 보임", !!(await until(async () => (await visibleFid(id)) > 0, 5000)) && !(await exists(".adm-overlay")));
    await until(async () => (await get("/api/control")).total === total0, 6000);
  }

  // 방문객 화면에는 관리자 요소를 아예 그리지 않는다
  await send("Page.navigate", { url: `${base}/?v=qr` }); await send("Page.reload");
  await until(() => ev(`document.getElementById("app")?.children.length > 0`), 8000); await sleep(700);
  check("방문객 화면: 관리자 버튼 없음", await ev(`!document.querySelector("[data-del], [data-gen], [data-status], input[type=password]")`));
  await send("Page.navigate", { url: `${base}/?v=qr#control` }); await send("Page.reload");
  await until(() => ev(`document.getElementById("app")?.children.length > 0`), 8000); await sleep(700);
  check("방문객 화면: 주소에 #control 을 붙여도 관제가 아니라 접수 화면", await ev(`!document.querySelector(".icard, .brief, .targets, [data-del]") && !!document.querySelector("#rf, form")`));
}

// ══ A. 관제 ═══════════════════════════════════════════════════════
await go("control");
{ // 점수는 화면에 보이지 않는다 (내부 계산·정렬에만 쓴다): 'NN점' · 점수 숫자 · 계산식 링크·패널 · 속성(aria-label·title)에도 없음. 브리핑 문장은 서버가 고칠 몫이라 제외.
  const leak = await ev(`(() => { const app = document.getElementById("app").cloneNode(true); app.querySelectorAll(".brief-text, .brief-why").forEach((e) => e.remove());
    const t = app.textContent; const attrs = [...app.querySelectorAll("[aria-label],[title]")].map((e) => (e.getAttribute("aria-label") || "") + (e.getAttribute("title") || "")).join(" ");
    return JSON.stringify({ pt: /\d+(\.\d+)?\s*점/.test(t + " " + attrs), fx: /계산식/.test(t + " " + attrs), el: !!app.querySelector(".score, .hero-score, .formula-box, [data-fx], #hero-formula, .rank .bar") }); })()`);
  const lk = JSON.parse(leak);
  check("관제: 화면 어디에도 점수·'NN점'·계산식이 없음 (속성 포함)", !lk.pt && !lk.fx && !lk.el, leak);
}
check("관제: 화면이 그려지고 '실시간' 연결 표시", (await text("#live")).startsWith("실시간"), await text("#live"));
{ // 헤더 배지 (D5-33): 데이터 · AI 해석 방식 · 합성 표시. 값은 서버(/api/control)가 준 것과 맞아야 한다.
  const ctl = await get("/api/control");
  const AI = { claude_code: "AI: Claude Code (개발용)", anthropic: "AI: Claude API", local: "AI: 규칙(개발용)" };
  check("헤더: 데이터 배지에 '로컬 DB'", /로컬 DB/.test(await text("#live")), await text("#live"));
  const ai = await until(async () => (await text("#chip-ai")) || null, 4000);
  check("헤더: AI 배지가 서버 backend_llm 과 일치", ai === (AI[ctl.backend_llm] ?? `AI: ${ctl.backend_llm}`), `${ai} ← ${ctl.backend_llm}`);
  const synVisible = await ev(`!document.getElementById("chip-syn").hidden`);
  check("헤더: 합성 배지는 서버 synthetic.on 일 때만", synVisible === !!ctl.synthetic?.on, `화면 ${synVisible} · 서버 ${JSON.stringify(ctl.synthetic)}`);
  // 접수 몰림 배지 (D5-33 ③): 서버 값에 맞춰 나오고, 값이 없으면 숨는다. 몰림을 일부러 만들면 접수 제한에 걸려 다른 점검이 깨지므로 응답만 바꿔치기한다.
  const crowdNow = await ev(`!document.getElementById("chip-crowd").hidden`);
  check("헤더: 접수 몰림 배지는 서버 crowding 이 있을 때만", crowdNow === ((ctl.crowding ?? []).length > 0), `화면 ${crowdNow} · 서버 ${JSON.stringify(ctl.crowding)}`);
  await ev(`(() => { window.__f0 = window.fetch; window.fetch = async (u, o) => { const r = await window.__f0(u, o); if (!String(u).includes("/api/control")) return r; const j = await r.json(); j.data.crowding = [{ zone_id: 4, zone: "유등터널", count: 12, window_sec: 300 }, { zone_id: 5, zone: "소망등", count: 9, window_sec: 300 }]; return new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } }); }; window.dispatchEvent(new Event("hashchange")); })()`);
  const crowdTxt = await until(async () => { const t = await text("#chip-crowd"); return (await ev(`!document.getElementById("chip-crowd").hidden`)) ? t : null; }, 5000);
  check("헤더: 접수 몰림 배지 — 구역 · 건수/분 · 외 N곳", crowdTxt === "접수 몰림 · 유등터널 12건/5분 외 1곳", crowdTxt ?? "안 보임");
  await ev(`window.fetch = window.__f0; window.dispatchEvent(new Event("hashchange"))`);
  // 브리핑 아래 한 줄 요약(D5-60): '건수 1위 A N건보다 <구역> <유형> M건이 먼저입니다' 의 M 은 그 구역 카드의 건수여야 한다 (유형 전체 건수가 아니다).
  // 응답을 바꿔치기해서 '유형 전체 5건 · 그 구역 카드 3건 · 다른 유형 7건' 인 상황을 만든다.
  {
    const lead = ctl.issues.find((i) => i.grp === "main");
    if (!lead) skip("관제: 한 줄 요약의 건수 = 그 구역 카드의 건수", "지금 조치할 카드(main)가 없음");
    else {
      await ev(`(() => { window.__f1 = window.fetch; window.fetch = async (u, o) => { const r = await window.__f1(u, o); if (!String(u).includes("/api/control")) return r; const j = await r.json(); const d = j.data;
        const lead = d.issues.find((i) => i.grp === "main"); lead.freq = 3; lead.type_freq = 5;
        const base = d.sev[0] ?? { id: 1, as_of: "2026-01-01T00:00:00", window: "60min", avg_sentiment: 0, base_score: 50, safety_w: 1, spike_w: 1, pending_w: 1, formula: "" };
        const other = Object.keys({ parking: 1, restroom: 1, price: 1, guide: 1 }).find((k) => k !== lead.label);
        d.sev = [{ ...base, label: lead.label, freq: 5, score: 90, grade: "immediate" }, { ...base, label: other, freq: 7, score: 40, grade: "mid" }];
        d.issues = d.issues.map((i) => (i === lead ? i : { ...i, grp: i.grp === "main" ? "more" : i.grp }));
        return new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } }); }; window.dispatchEvent(new Event("hashchange")); })()`);
      const flip = await until(async () => (await text(".flip")) || null, 5000);
      await ev(`window.fetch = window.__f1; window.dispatchEvent(new Event("hashchange"))`);
      check("관제: 한 줄 요약의 건수 = 그 구역 카드의 건수 (유형 전체 건수 아님)", !!flip && /3건/.test(flip.split("보다")[1] ?? "") && !/5건/.test(flip.split("보다")[1] ?? "") && /7건/.test(flip.split("보다")[0] ?? ""), flip ?? "한 줄 요약이 안 보임");
    }
  }
  check("헤더: 몰림이 풀리면 배지가 사라짐", !!(await until(async () => (await ev(`document.getElementById("chip-crowd").hidden`)) === !((ctl.crowding ?? []).length > 0) ? true : null, 5000)));
  if (ctl.synthetic?.on) check("헤더: 합성 배지에 건수", (await text("#chip-syn")).includes(`${ctl.synthetic.count}건`), await text("#chip-syn"));
}
check("관제: 브리핑 카드 (지금 조치할 일)", (await text(".brief .brief-text")).length > 5 || (await exists(".brief .muted")), (await text(".brief .brief-text")).slice(0, 30));
const order = await ev(`(() => { const p = (s) => document.querySelector(s); const a = p(".brief"), h = p(".icards"), g = p(".grid2");
  const before = (x, y) => !!x && !!y && !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
  return before(a, h) && before(h, g); })()`);
check("관제: 읽는 순서 브리핑 → 카드(1위) → 나머지", order);

{
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
  }
  if (await exists(".icard:not(.big) .ic-head")) {
    await click(".icard:not(.big) .ic-head"); await sleep(300);
    check("카드: 행을 누르면 펼침 (본문이 보임)", (await ev(`${q(".icard:not(.big)")}.classList.contains("open") && ${q(".icard:not(.big) .ic-head")}.getAttribute("aria-expanded") === "true"`)) && (await shown(".icard:not(.big) .ic-body")));
    await click(".icard:not(.big) .ic-head"); await sleep(300);
    check("카드: 행을 다시 누르면 접힘", !(await ev(`${q(".icard:not(.big)")}.classList.contains("open")`)) && !(await shown(".icard:not(.big) .ic-body")));
  } else skip("카드: 행 펼침", "1위 말고 다른 카드가 없음");
  if (await exists("details.igrp > summary")) {
    await click("details.igrp > summary"); await sleep(250);
    check("카드: 묶음(그 밖·조치 중) 펼침", await ev(`${q("details.igrp")}.open`), await text("details.igrp > summary"));
    await click("details.igrp > summary"); await sleep(250);
    check("카드: 묶음 접힘", !(await ev(`${q("details.igrp")}.open`)));
  } else skip("카드: 묶음 펼침", "묶음(그 밖·조치 중)이 없음");
  if (await exists("details.typerank > summary")) {
    await click("details.typerank > summary"); await sleep(250);
    check("카드: 유형별 순위 펼침 (카드 점수의 근거)", (await ev(`${q("details.typerank")}.open`)) && (await count(".typerank .rank li")) > 0, `${await count(".typerank .rank li")}개 유형`);
    await click("details.typerank > summary"); await sleep(250);
  }
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
  if (await exists(".icard:not(.big) .ic-head")) { await click(".icard:not(.big) .ic-head"); opened.push("card"); }
  if (await exists("details.igrp > summary")) { await click("details.igrp > summary"); opened.push("grp"); }
  if (await exists(".alert-row")) { await click(".alert-row"); opened.push("alert"); }
  if (await exists(".feed-item")) { await click(".feed-item"); opened.push("feed"); }
  await sleep(300); await markApp();
  const origin0 = await ev(`performance.timeOrigin`);      // 페이지가 통째로 다시 열렸는지 가르는 표식 (개발 서버가 파일 변경으로 새로고침하면 펼침 상태는 당연히 사라진다)
  const t0 = Date.now();
  const r = await rpc("set_action_status", { p_id: pick.id, p_status: altStatus(pick.status) });
  check("상태 변경 RPC 200", r.status === 200, `#${pick.id} ${pick.status} → ${altStatus(pick.status)}`);
  check("서버가 변화를 알림(SSE change)", !!(await until(() => sseSince(t0, "change"), 5000)));
  check("화면이 스스로 다시 그려짐 (실시간)", !!(await redrawn(6000)));
  await sleep(400);
  const kept = JSON.parse(await ev(`JSON.stringify({
    card: ${q(".icard:not(.big)")}?.classList.contains("open") ?? null,
    grp: ${q("details.igrp")}?.open ?? null,
    alert: ${q(".alerts li")}?.classList.contains("open") ?? null,
    feed: ${q(".feed li")}?.classList.contains("open") ?? null })`));
  const lost = opened.filter((k) => kept[k] === false);
  const reloaded = (await ev(`performance.timeOrigin`)) !== origin0;
  check(`다시 그려도 펼침 유지 (${opened.join("·") || "펼칠 것 없음"})`, opened.length > 0 && lost.length === 0, lost.length ? `풀린 것: ${lost.join(", ")}${reloaded ? " — 페이지가 통째로 다시 열림(새로고침)" : " — 새로고침 없이 풀림"} · ${JSON.stringify(kept)}` : JSON.stringify(kept));
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
  // 지운 민원 목록 (D5-42) — 토스트가 지나간 뒤에도 되돌릴 수 있게.
  const dl = await fetch(`${base}/api/deleted`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const dlr = await rpc("list_deleted", {});
  const items = dlr.data?.items ?? [];
  const mine = items.find((x) => x.id === fid);
  check("지운 목록(서버): GET /api/deleted 도 같은 내용", dl.status === 200 && Array.isArray(dl.body.data) && dl.body.data.some((x) => x.id === fid), `status ${dl.status}`);
  check("지운 목록(서버): 방금 지운 민원이 맨 앞에 (id · 원문 · 구역 · 지운 시각)", dlr.status === 200 && items[0]?.id === fid && !!mine?.raw_text && !!mine?.zone && !!mine?.deleted_at, `${items.length}건 · 맨 앞 #${items[0]?.id}`);
  check("지운 목록(서버): 최대 50건", items.length <= 50);
  const r2 = await rpc("restore_feedback", { p_id: fid });
  check("지운 목록(서버): 되돌리면 목록에서 빠짐", !((await rpc("list_deleted", {})).data?.items ?? []).some((x) => x.id === fid));
  const c2 = await get("/api/control");
  check("되돌리기(서버): 유입에 돌아오고 건수가 복구", r2.status === 200 && c2.feed.some((f) => f.id === fid) && c2.total === control0.total, `총 ${c2.total}`);
  const again = await rpc("delete_feedback", { p_id: 99999999 });
  check("지우기(서버): 없는 민원 번호는 오류로 거절", again.status === 400, again.error ?? `status ${again.status}`);
}

// 화면 수준 — 휴지통 버튼(aria-label '민원 지우기') → 바로 사라짐 → 토스트 '되돌리기' → 돌아옴
async function deleteFlow(area, selector, timing = false) {
  await go("control");
  if (!(await exists(selector))) return skip(`지우기·되돌리기 (화면 · ${area})`, `화면에 ${area}의 [민원 지우기] 버튼이 없음`);
  const id = await ev(`${q(selector)}.dataset.del`);            // 지울 '민원 번호' (카드 번호가 아니다)
  const before = await visibleFid(id);
  const total0 = (await get("/api/control")).total;
  await click(selector);
  check(`지우기(화면·${area}): 바로 사라짐 (그 민원이 보이는 곳 ${before}곳 → 0곳)`, !!(await until(async () => (await visibleFid(id)) === 0, 2500)) && before > 0, `#${id}`);
  check(`지우기(화면·${area}): '되돌리기' 토스트`, !!(await until(() => ev(`!!document.querySelector("#toasts .toast-act")`), 3000)), await text("#toasts .toast.has-act"));
  check(`지우기(화면·${area}): 서버에서도 빠짐 (총 건수 -1)`, !!(await until(async () => (await get("/api/control")).total === total0 - 1, 4000)), `총 ${total0} → ${(await get("/api/control")).total}`);
  if (timing) {
    // D5-38 (WCAG 2.2.1): 되돌리기 알림은 10초 이상 보이고, 마우스를 올리면 멈춘다. 옛 5초 동안만 보였다면 여기서 실패한다.
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 6500 * SLOW));
    check("되돌리기 알림이 옛 5초를 넘겨 계속 보임 (6.5초 뒤에도)", await exists("#toasts .toast-act"));
    const box = await ev(`(() => { const r = document.querySelector("#toasts .toast-act").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });            // 실제 마우스를 버튼 위로
    const wait = Math.max(0, 11800 * SLOW - (Date.now() - t0));                                       // 원래라면 10초에 사라졌을 시각을 지나도록
    await new Promise((r) => setTimeout(r, wait));
    check("마우스를 올려 두면 10초가 지나도 사라지지 않음", await exists("#toasts .toast-act"), `${Math.round((Date.now() - t0) / 100) / 10}초 경과`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });                       // 마우스를 치우면
    check("마우스를 치우면 곧 사라짐 (남은 시간 뒤)", !!(await until(() => ev(`!document.querySelector("#toasts .toast-act")`), 6000)));
    // 사라진 뒤에는 되돌릴 수 없다 → 서버에서 다시 살려 이후 흐름(총 건수 등)을 원래대로 둔다
    await rpc("restore_feedback", { p_id: Number(id) });
    await until(async () => (await get("/api/control")).total === total0, 4000);
    return;
  }
  await click("#toasts .toast-act");
  check(`되돌리기(화면·${area}): 다시 보임`, !!(await until(async () => (await visibleFid(id)) > 0, 6000)), `#${id} ${await visibleFid(id)}곳`);
  check(`되돌리기(화면·${area}): 서버도 복구 (총 건수 원래대로)`, !!(await until(async () => (await get("/api/control")).total === total0, 4000)));
  await until(() => ev(`!document.querySelector("#toasts .toast-act")`), 3000);
}
await deleteFlow("유입", ".feed [data-del]", true);        // 알림 유지 시간·마우스 정지까지 본다
await deleteFlow("유입", ".feed [data-del]");
await deleteFlow("카드의 최신 민원", ".icard .ic-q [data-del]");

// ══ G. QR 만들기 (관리자 '접수 QR', 조회 전용 — 운영자 코드 없이 열림). QR 은 접수 주소(?v=qr) 하나 ═════════════════════
{
  const req = createRequire(import.meta.url);
  const jsQR = req("../../web/node_modules/jsqr");
  const QRCode = req("../../web/node_modules/qrcode");
  const origin = new URL(base).origin;
  await ev(`try { localStorage.removeItem("festival_qr_base"); } catch (e) {}`);
  await go("report");
  await until(() => exists(".qr-card .qr-img"), 6000);
  check("QR: 사이드바 '접수 QR' 가 이 화면을 연다 (코드 입력 없이)", (await text(".side-nav a.on")) === "접수 QR" && (await exists("#qr-base")) && !(await exists(".adm-overlay")));
  check("QR: 기본 주소 = 지금 접속한 origin", (await ev(`document.getElementById("qr-base").value`)) === origin, origin);
  check("QR: 구역별 카드 없이 큰 QR 한 장", (await count(".qr-card")) === 1 && (await count(".qr-img")) === 1 && (await count("[data-zone]")) === 0);
  const url0 = `${origin}/?v=qr`;
  check("QR: 주소 글자 = 기본 주소/?v=qr (구역 파라미터 없음) · PNG 저장 · 인쇄 버튼", (await text(".qr-url")) === url0 && (await ev(`document.querySelector(".qr-save")?.getAttribute("href")?.startsWith("data:image/png;base64,")`)) && (await ev(`document.querySelector(".qr-save")?.getAttribute("download")`)) === "qr_report.png" && (await text("#qr-print")) === "인쇄", await text(".qr-url"));

  // 디코드: 화면의 QR 그림을 읽어 주소가 같은지 (폰으로 찍는 것을 대신한다)
  const decode = async () => {
    const raw = JSON.parse(await ev(`(() => { const i = document.querySelector(".qr-card .qr-img"); const w = Math.round(i.naturalWidth / 3), h = Math.round(i.naturalHeight / 3);
      const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.imageSmoothingEnabled = false; x.drawImage(i, 0, 0, w, h);
      return JSON.stringify({ w, h, d: Array.from(x.getImageData(0, 0, w, h).data) }); })()`));
    return jsQR(Uint8ClampedArray.from(raw.d), raw.w, raw.h)?.data ?? null;
  };
  check("QR: QR 을 디코드하면 주소와 같음", (await decode()) === url0, String(await decode()));

  // 공개 주소로 바꾸기 → 주소와 QR 이 바뀌고, 입력은 localStorage 에 남아 새로고침해도 유지
  const PUB = "https://festival.example.kr/";
  await ev(`(() => { const i = document.getElementById("qr-base"); i.value = ${JSON.stringify(PUB)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  check("QR: 기본 주소를 바꾸면 주소와 QR 이 다시 만들어짐", !!(await until(async () => (await text(".qr-url")) === "https://festival.example.kr/?v=qr", 4000)), await text(".qr-url"));
  check("QR: 바꾼 주소를 디코드해도 새 주소", (await decode()) === "https://festival.example.kr/?v=qr");
  await go("report"); await until(() => exists(".qr-card .qr-img"), 6000);
  check("QR: 입력한 기본 주소는 새로고침해도 기억 (localStorage)", (await ev(`document.getElementById("qr-base").value`)) === PUB && (await text(".qr-url")) === "https://festival.example.kr/?v=qr");
  await ev(`(() => { const i = document.getElementById("qr-base"); i.value = "localhost:5174"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  check("QR: localhost 주소는 폰에서 안 열린다는 경고", !!(await until(() => ev(`!document.getElementById("qr-warn").hidden`), 4000)));

  // 이 QR 이 여는 주소: 방문객 접수 화면, 관리자 메뉴 없음
  await ev(`try { localStorage.removeItem("festival_qr_base"); } catch (e) {}`);
  await send("Page.navigate", { url: url0 });
  await until(() => ev(`!!document.querySelector("#rf select")`), 8000);
  await sleep(400);
  check("QR: 주소를 열면 방문객 접수 화면 (관리자 메뉴·QR 만들기 없음)", (await exists("#rf")) && !(await exists("#side")) && !(await exists("#qr-base")));

  // 인쇄 모양: 사이드바·헤더·입력 줄·저장 버튼은 숨고 QR 카드만 남는다
  await go("report"); await until(() => exists(".qr-card .qr-img"), 6000);
  await send("Emulation.setEmulatedMedia", { media: "print" });
  const pr = JSON.parse(await ev(`JSON.stringify({ side: getComputedStyle(document.getElementById("side")).display, top: getComputedStyle(document.querySelector("header.top")).display, bar: getComputedStyle(document.querySelector(".qr-top")).display, save: getComputedStyle(document.querySelector(".qr-save")).display, pad: getComputedStyle(document.body).paddingLeft, card: getComputedStyle(document.querySelector(".qr-card")).display })`));
  await send("Emulation.setEmulatedMedia", { media: "" });
  check("QR: 인쇄할 때 사이드바·헤더·입력 줄·저장 버튼은 숨고 QR 만 남음", pr.side === "none" && pr.top === "none" && pr.bar === "none" && pr.save === "none" && pr.pad === "0px" && pr.card !== "none", JSON.stringify(pr));
}

// ══ H. AI 동작 보기 (D5-62) — 끈 상태에는 점수가 없고, 켜면(코드 없이) 로그·에이전트 흐름이 보이고, 방문객 화면에는 없다 ═════════════════
{
  const probe = await rpc("dev_feed", { p_since_log: 0, p_since_cls: 0 });
  if (probe.status === 404) skip("AI 동작 보기", "서버에 dev_feed 가 아직 없음");
  else {
    check("AI 동작 보기(서버): 운영자 코드 없이 받을 수 있다 (심사위원이 보는 화면)", probe.status === 200 && Array.isArray(probe.data?.logs) && Array.isArray(probe.data?.severity) && !!probe.data?.status, `status ${probe.status}`);

    // 화면: 끈 상태 → 켜기(코드 창 없음) → 흐름·로그 → 탭 → 끄기(폴링 멈춤)
    await ev(`sessionStorage.clear(); try { localStorage.removeItem("festival_dev_view"); } catch (e) {}`);
    await go("control");
    const scoreOutside = `(() => { const a = document.getElementById("app").cloneNode(true); a.querySelectorAll(".brief-text, .brief-why").forEach((e) => e.remove()); return /\d+(\.\d+)?\s*점/.test(a.innerText); })()`;
    check("AI 동작 보기: 기본은 꺼짐 (패널 숨김 · 스위치 꺼짐 · 관제 화면에 점수 글자 없음)", (await ev(`document.getElementById("dev-panel").hidden && document.getElementById("dev-toggle").getAttribute("aria-checked") === "false" && !${scoreOutside}`)));
    check("AI 동작 보기: 스위치가 헤더에 있고 이름이 'AI 동작 보기'", (await text("header.top #dev-toggle")).includes("AI 동작 보기"));

    await ev(`window.__devCalls = 0; window.__f2 = window.fetch; window.fetch = (u, o) => { if (String(u).includes("dev_feed")) window.__devCalls++; return window.__f2(u, o); }`);
    await click("#dev-toggle");
    check("AI 동작 보기: 켤 때 운영자 코드 창이 뜨지 않고 패널이 바로 열린다", !!(await until(() => ev(`!document.getElementById("dev-panel").hidden && document.getElementById("dev-toggle").getAttribute("aria-checked") === "true"`), 5000)) && !(await exists(".adm-overlay")));
    check("AI 동작 보기: 로그 탭 맨 위에 에이전트 흐름 ⓪ 계획 → ① 분류 → ② 감시 → ③ 조치 → ④ 통합", !!(await until(() => ev(`[...document.querySelectorAll("#dev-body .dev-flow .dev-step b")].map((b) => b.textContent.trim()).join("|") === "⓪ 계획|① 분류|② 감시|③ 조치|④ 통합"`), 4000)));
    check("AI 동작 보기: 실시간 로그 줄 — 에이전트 이름 · 한글로 한 일", !!(await until(() => ev(`[...document.querySelectorAll("#dev-log .dev-row")].some((r) => /에이전트/.test(r.querySelector(".dev-ag")?.textContent ?? "") && (r.querySelector(".dev-act")?.textContent ?? "") !== (r.querySelector(".dev-code")?.textContent ?? ""))`), 5000)) || (probe.data?.logs ?? []).length === 0, `${await count("#dev-log .dev-row")}줄`);
    check("AI 동작 보기: 켠 상태는 localStorage 에 기억", (await ev(`localStorage.getItem("festival_dev_view")`)) === "1");
    check("AI 동작 보기: 일시정지 버튼이 있다", (await text("#dev-pause")) === "일시정지");
    // 지금 돌고 있는 에이전트에 불이 들어온다: 응답에 '방금 감시 에이전트가 일한' 로그를 끼워 넣어 본다
    await ev(`(() => { window.fetch = async (u, o) => { const r = await window.__f2(u, o); if (!String(u).includes("dev_feed")) return r; const j = await r.json(); const now = j.data.now;
      j.data.logs = [...j.data.logs, { id: (j.data.max_log_id ?? 0) + 1000, created_at: now, agent: "monitor", action: "raise_alert", input_summary: "{}", output_summary: "{}", reasoning: null, latency_ms: 5, tokens_in: 0, tokens_out: 0 }];
      return new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } }); }; })()`);
    check("AI 동작 보기: 방금 일한 에이전트(감시)에 불이 들어온다 (다른 에이전트는 꺼져 있다)", !!(await until(() => ev(`document.querySelector('#dev-body .dev-step[data-agent="monitor"]')?.classList.contains("on") && !document.querySelector('#dev-body .dev-step[data-agent="dispatcher"]')?.classList.contains("on")`), 7000)));
    // 계획 에이전트(⓪): 계획 로그가 오면 흐름에 불이 들어오고, 고른 창·집중 유형·코드가 덮어쓴 것이 한글로 보인다
    await ev(`(() => { window.fetch = async (u, o) => { const r = await window.__f2(u, o); if (!String(u).includes("dev_feed")) return r; const j = await r.json(); const now = j.data.now;
      const plan = { window_min: 15, must_run: ["classifier", "monitor"], focus_labels: ["safety", "crowd"], run_dispatcher: true, run_supervisor: false, overrides: ["run_supervisor false → true (즉시 등급 있음: safety)"], reason: "시험", source: "local" };
      j.data.classifications = [{ feedback_id: 9991, raw_text: "시험용 민원", label: "crowd", status: "done", is_safety: 0, confidence: 0.9, agent_note: "유사 사례 반영: #150 (운영자 지정, 유사도 0.92)", suggested_label: null, processed_at: now }, ...j.data.classifications];
      j.data.logs = [...j.data.logs,
        { id: (j.data.max_log_id ?? 0) + 2001, created_at: now, agent: "classifier", action: "lookup_similar", input_summary: "시험용 민원", output_summary: "#12 운영자 crowd (0.83), #9 모델 safety (0.71)", reasoning: null, latency_ms: 0, tokens_in: 0, tokens_out: 0 },
        { id: (j.data.max_log_id ?? 0) + 2002, created_at: now, agent: "classifier", action: "memory_hit", input_summary: "시험용 민원", output_summary: "#9991 ← #150 crowd (0.92)", reasoning: "거의 같은 글", latency_ms: 0, tokens_in: 0, tokens_out: 0 },
        { id: (j.data.max_log_id ?? 0) + 2000, created_at: now, agent: "planner", action: "plan", input_summary: "{}", output_summary: JSON.stringify(plan), reasoning: "시험", latency_ms: 0, tokens_in: 0, tokens_out: 0 }];
      return new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } }); }; })()`);
    check("AI 동작 보기: 계획 에이전트(⓪)에 불이 들어오고 계획 로그에 창·집중 유형·코드가 덮어쓴 것이 보인다", !!(await until(() => ev(`document.querySelector('#dev-body .dev-step[data-agent="planner"]')?.classList.contains("on") && /계획 에이전트/.test(document.querySelector("#dev-log .ag-planner")?.textContent ?? "") && /이번 주기 계획을 세움/.test(document.getElementById("dev-log").innerText) && /창 15분/.test(document.querySelector("#dev-log .dev-plan")?.innerText ?? "") && /안전, 혼잡/.test(document.querySelector("#dev-log .dev-plan")?.innerText ?? "") && /코드가 덮어쓴 것/.test(document.querySelector("#dev-log .dev-over")?.innerText ?? "")`), 7000)));
    check("AI 동작 보기: 기억 로그 — 비슷한 과거 사례 조회(몇 건·유사도·운영자 지정)와 과거 사례로 바로 분류(AI 호출 생략)", !!(await until(() => ev(`(() => { const t = document.getElementById("dev-log")?.innerText ?? ""; return /비슷한 과거 사례 조회/.test(t) && /비슷한 과거 사례 2건/.test(t) && /운영자 지정 · 유사도 0\.83/.test(t) && /과거 사례로 바로 분류/.test(t) && /AI 호출을 생략/.test(t); })()`), 7000)));
    await click('[data-tab="cls"]');
    check("AI 동작 보기: 분류 탭에서 과거 사례로 정해진 건에 '과거 사례로 분류' 표시", !!(await until(() => ev(`/과거 사례로 분류/.test(document.querySelector("#dev-body .dev-row.memory")?.innerText ?? "")`), 7000)));
    await click('[data-tab="log"]');
    await ev(`window.fetch = (u, o) => { if (String(u).includes("dev_feed")) window.__devCalls++; return window.__f2(u, o); }`);
    await click('[data-tab="sev"]');
    check("AI 동작 보기: 심각도 탭에서만 점수가 보인다 (점수 숫자 · 계산식)", !!(await until(() => ev(`document.querySelectorAll("#dev-body .dev-num").length > 0 || /판정이 없습니다/.test(document.getElementById("dev-body").innerText)`), 4000)));
    check("AI 동작 보기: 패널 밖(관제 화면)에는 점수가 여전히 없다", (await ev(`!${scoreOutside}`)));
    await click('[data-tab="stat"]');
    check("AI 동작 보기: 상태 탭 — 백엔드 · 루프 표", (await until(() => ev(`/백엔드/.test(document.getElementById("dev-body").innerText)`), 3000)) !== null);
    const c1 = await ev(`window.__devCalls`);
    await sleep(3600);
    check("AI 동작 보기: 켜져 있는 동안 3초마다 가져온다", (await ev(`window.__devCalls`)) > c1, `${c1} → ${await ev(`window.__devCalls`)}`);
    await click("#dev-toggle");
    check("AI 동작 보기: 끄면 패널이 닫히고 기억도 지워진다", (await ev(`document.getElementById("dev-panel").hidden && localStorage.getItem("festival_dev_view") === null`)));
    const c2 = await ev(`window.__devCalls`);
    await sleep(4000);
    check("AI 동작 보기: 끄면 가져오기가 멈춘다", (await ev(`window.__devCalls`)) === c2, `${c2} → ${await ev(`window.__devCalls`)}`);
    await ev(`window.fetch = window.__f2`);

    // 방문객 화면에는 없다
    await send("Page.navigate", { url: `${base}/?v=qr` });
    await until(() => ev(`!!document.querySelector("#rf select")`), 8000);
    check("AI 동작 보기: 방문객 화면(?v=qr)에는 스위치도 패널도 없다", !(await exists("#dev-toggle")) && !(await exists("#dev-panel")) && (await ev(`document.documentElement.classList.contains("v")`)));
  }
}

// ══ I. 설정 (D5-90) — 보기·저장 모두 코드 없이. 축제 이름·구역 숨김이 사이드바·방문객 화면에 바로 반영 ═════════════════
{
  const probe = await fetch(`${base}/api/settings`);
  if (probe.status === 404) skip("설정", "서버에 /api/settings 가 아직 없음");
  else {
    const st0 = (await probe.json()).data;
    check("설정(서버): 읽기는 코드 없이 — 축제·구역·담당 부서(부서가 있는 유형 6개 이상 — 긍정은 부서가 없다)", probe.status === 200 && !!st0.festival?.name && Array.isArray(st0.zones) && st0.zones.length > 0 && st0.departments?.length >= 6, `구역 ${st0.zones?.length} · 부서 ${st0.departments?.length}`);

    await go("settings");
    check("설정: 사이드바 '설정' 이 선택되고 세 묶음(축제 정보·구역·담당 부서)이 보이며 코드 창은 없다", (await text(".side-nav a.on")).includes("설정") && (await count(".set-card")) === 3 && !(await exists(".adm-overlay")));
    check("설정: 입력칸에 지금 값이 들어 있다 (축제 이름)", (await ev(`document.querySelector('#set-fest [name=name]').value`)) === st0.festival.name);

    // 저장하면 코드 창 없이 축제 이름이 사이드바·헤더에 바로 반영
    const NEW = "시험축제 " + Math.floor(Math.random() * 1000);
    await ev(`(() => { const i = document.querySelector('#set-fest [name=name]'); i.value = ${JSON.stringify(NEW)}; })()`);
    await click('#set-fest button[type="submit"]');
    check("설정: 저장되고 코드 창 없이 사이드바의 축제 이름이 바로 바뀐다", !!(await until(async () => (await text("#side-name")) === NEW, 15000)), `${await text("#side-name")} / 서버 ${(await get("/api/festival"))?.name} / 기대 ${NEW}`);
    check("설정: 저장했다는 안내", !!(await until(async () => /저장했습니다/.test(await text("#set-msg")), 4000)));

    // 구역: 추가 → 방문객 구역 선택에 나타남, 숨기기 → 사라짐
    const ZN = "시험구역" + Math.floor(Math.random() * 1000);
    await ev(`(() => { document.querySelector('#set-zone-add [name=name]').value = ${JSON.stringify(ZN)}; })()`);
    await click('#set-zone-add button[type="submit"]');
    check("설정: 구역 추가 — 목록에 나타난다 (코드 창 없이)", !!(await until(() => ev(`[...document.querySelectorAll("#set-zones .set-zname")].some((i) => i.value === ${JSON.stringify(ZN)})`), 6000)) && !(await exists(".adm-overlay")));
    const zonesNow = async () => (await (await fetch(`${base}/api/zones`)).json()).data.map((z) => z.name);
    check("설정: 새 구역이 방문객 구역 선택(/api/zones)에 바로 들어간다", (await zonesNow()).includes(ZN));
    await click(`#set-zones [data-zone]:last-child [data-act="hide"]`);
    check("설정: 구역을 숨기면 방문객 구역 선택에서 빠지고 설정 목록에는 '숨김'으로 남는다", !!(await until(async () => !(await zonesNow()).includes(ZN) && /숨김/.test(await text("#set-zones [data-zone]:last-child")), 6000)));

    // 되돌리기 (시험용 복사본이지만 원래 이름으로)
    await ev(`(() => { document.querySelector('#set-fest [name=name]').value = ${JSON.stringify(st0.festival.name)}; })()`);
    await click('#set-fest button[type="submit"]');
    await until(async () => (await text("#side-name")) === st0.festival.name, 6000);

    // 담당 부서의 기본 예시 번호: 관제 카드에 '(예시 번호)' 가 붙고 전화 링크가 없다
    await go("control");
    const hasEx = await ev(`[...document.querySelectorAll(".ic-who")].some((e) => /055-000-\\d{4}/.test(e.textContent))`);
    if (hasEx) check("설정: 기본 예시 번호(055-000-NNNN)에는 '(예시 번호)'가 붙고 전화 링크가 걸리지 않는다", (await ev(`[...document.querySelectorAll(".ic-who")].filter((e) => /055-000-\\d{4}/.test(e.textContent)).every((e) => /\\(예시 번호\\)/.test(e.textContent) && !e.querySelector('a[href^="tel:"]'))`)));
    else skip("설정: 예시 번호 표시", "관제 카드에 기본 예시 번호가 없음");

    // 방문객은 설정으로 못 들어온다
    await send("Page.navigate", { url: `${base}/?v=qr#settings` });
    await until(() => ev(`!!document.querySelector("#rf select")`), 8000);
    check("설정: 방문객 화면(?v=qr)은 #settings 로 와도 접수 화면만 (설정 없음)", !(await exists("#set-fest")) && !(await exists(".side-nav")));
  }
}

// ══ J. 등급은 한 출처 (D5-82) · 에이전트 멈춤 표시 (D5-86) ═══════════════════════════════════════════
{
  const ctl = await get("/api/control"), act = await get("/api/action");
  const ord = { immediate: 0, high: 1, mid: 2, low: 3 };
  const best = new Map();
  for (const c of ctl.issues) if (!best.has(c.label) || ord[c.grade] < ord[best.get(c.label)]) best.set(c.label, c.grade);
  const same = (sev) => sev.filter((s) => best.has(s.label)).every((s) => s.grade === best.get(s.label));
  check("등급: 관제의 유형 순위·알림 등급이 관제 카드의 가장 높은 등급과 같다", same(ctl.sev), `${best.size}개 유형`);
  check("등급: 조치 화면의 조치 대상 등급도 같은 값이다 (관제 즉시 · 조치 높음처럼 갈리지 않는다)", same(act.sev));

  await send("Page.navigate", { url: `${base}/#control` });
  await until(() => exists(".kpis"), 10000);
  await sleep(500);
  const shownGrade = async (label) => ev(`(() => { const t = [...document.querySelectorAll(".targets li")].find((li) => li.querySelector("[data-gen]")?.dataset.gen === ${JSON.stringify(label)}); return t ? t.querySelector(".badge")?.textContent : null; })()`);
  await go("action");
  const KO = { immediate: "즉시", high: "높음", mid: "보통", low: "낮음" };
  const probeLabel = act.sev.map((s) => s.label).find((l) => l !== "positive" && best.has(l));
  if (probeLabel) check("등급: 조치 화면에 실제로 보이는 등급이 관제 카드 등급과 같다", !!(await until(async () => (await shownGrade(probeLabel)) === KO[best.get(probeLabel)], 5000)), `${probeLabel}: ${await shownGrade(probeLabel)} / ${KO[best.get(probeLabel)]} · 대상 ${await count(".targets li")}개 · ${await ev(`location.hash`)} · ${(await text("#app")).slice(0, 80)}`);
  else skip("등급: 화면 대조", "카드가 있는 유형이 없음");
  await go("control");

  // 멈춤: 서버가 준 루프 시각이 10분 전이면 배너·헤더 배지·'마지막 갱신'. 평소(시험 복사본은 먼 미래 시각)에는 없다.
  check("멈춤: 평소에는 배너가 없고 헤더는 '실시간' (에이전트가 오래 쉬어도 경고하지 않고 '마지막 판단'만 보인다)", (await ev(`document.getElementById("worker-banner").hidden`)) && (await text("#live")).startsWith("실시간") && !/멈춤/.test(await text("#last-seen")), `${await text("#live")} / ${await text("#last-seen")}`);
  await ev(`(() => { window.__f3 = window.fetch; window.fetch = async (u, o) => { const r = await window.__f3(u, o); if (!String(u).includes("/api/freshness")) return r; const j = await r.json(); const d = new Date(Date.parse(j.data.server_now) - 600000), p = (n) => String(n).padStart(2, "0"); j.data.worker_at = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); return new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } }); }; document.dispatchEvent(new Event("visibilitychange")); })()`);
  check("멈춤: 워커가 10분째 안 돌면 배너 — 새 민원이 분류되지 않을 수 있다 · 마지막 동작 10분 전", !!(await until(async () => !(await ev(`document.getElementById("worker-banner").hidden`)), 5000)) && /마지막 동작 10분 전/.test(await text("#worker-banner")) && /멈춘/.test(await text("#worker-banner")), await text("#worker-banner"));
  check("멈춤: 헤더 배지가 '에이전트 멈춤'으로 바뀐다", (await text("#live")).startsWith("에이전트 멈춤"), await text("#live"));
  await ev(`window.fetch = window.__f3; document.dispatchEvent(new Event("visibilitychange"))`);
  check("멈춤: 다시 돌면 배너가 사라지고 '실시간'으로 돌아온다", !!(await until(async () => (await ev(`document.getElementById("worker-banner").hidden`)) && (await text("#live")).startsWith("실시간"), 5000)), await text("#live"));
}

console.log(`\n통과 ${passed} · 실패 ${failed} · 건너뜀 ${skipped}`);
console.log(failed ? "실패 있음" : "전부 통과");
sse.ac.abort(); await quitChrome(chrome, ws);
process.exit(failed ? 1 : 0);
