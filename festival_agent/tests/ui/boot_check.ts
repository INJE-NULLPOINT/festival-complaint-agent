// JS 실패 안내(index.html #boot-msg) 점검 — 정상이면 숨김, 번들 JS 를 막으면 표시. 사용: node boot_check.ts <base>
// 구형 브라우저를 흉내 낼 수는 없어서 "스크립트가 못 돌아 #app 이 빈 채로 남는 상황" 을 요청 차단으로 만든다.
import { openChrome, quitChrome } from "./lib.ts";

const base = process.argv[2];
const SLOW = Math.max(1, Number(process.env.UI_SLOW) || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));
let blockJs = false; const blocked = [];
const { chrome, ws, send, ev } = await openChrome({
  prefix: "boot-",
  onMessage: (m) => {
  if (m.method === "Fetch.requestPaused") {
    const u = m.params.request.url;
    const fail = blockJs && /\.(js|ts)(\?|$)/.test(u.split("#")[0]) && !/\/@vite\/client/.test(u);
    if (fail) { blocked.push(u.replace(/^.*\//, "")); send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Failed" }); }
    else send("Fetch.continueRequest", { requestId: m.params.requestId });
  }
  },
});
let ok = true;
const check = (name, cond, detail = "") => { ok &&= !!cond; console.log(`${cond ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`); };
const STATE = `(() => { const m = document.getElementById("boot-msg"), a = document.getElementById("app"); return m && a ? JSON.stringify({ msgHidden: m.hidden, appKids: a.children.length }) : null; })()`;
// 문서가 떠서 #boot-msg 가 생길 때까지(최대 약 15초 × 배율) 기다렸다가 상태를 읽는다. 끝내 못 읽으면 null.
const stateNow = async () => { for (let i = 0; i < 60; i++) { const v = await ev(STATE).catch(() => null); if (v) return JSON.parse(v); await sleep(250); } return null; };

await send("Page.enable"); await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

// ① 정상
await send("Page.navigate", { url: base + "/?v=qr" }); await sleep(4000);
let s = await stateNow();
check("정상: 화면이 그려짐", s && s.appKids > 0, `#app 자식 ${s?.appKids}`);
check("정상: 안내가 숨겨져 있음 (nomodule 스크립트가 실행되지 않음)", s?.msgHidden === true);
await sleep(9000);
check("정상: 9초 뒤에도 안내 없음 (화면이 그려졌으면 타이머가 멈춤)", (await stateNow())?.msgHidden === true);

// ② 번들 JS 차단 → 뼈대만 남는 상황
blockJs = true;
await ev(`window.__old = 1`);
await send("Page.navigate", { url: base + "/?v=qr" });
// 새 문서가 떠서 #boot-msg 가 생길 때까지 (옛 문서를 읽지 않게 표식 __old 가 사라질 때까지)
for (let i = 0; i < 60; i++) { if (await ev(`!window.__old && !!document.getElementById("boot-msg")`).catch(() => false)) break; await sleep(250); }
const t0 = Date.now();
s = await stateNow();
check("차단: 화면이 비어 있음 (뼈대만)", s && s.appKids === 0, `막은 파일 ${blocked.join(", ") || "없음"}`);
// 안내가 뜨기까지 걸린 시간: 파일을 못 받은 오류는 1.5초 뒤(빠른 길), 그것도 놓치면 8초 타이머. 6초(×배율) 안이면 빠른 길이 동작한 것이다.
let shownAt = null;
for (let i = 0; i < 100 && shownAt === null; i++) { const st = await stateNow(); if (st && st.msgHidden === false) shownAt = Date.now() - t0; else await sleep(250); }
check("차단: 스크립트 오류 직후 빠르게 안내가 뜸 (8초 타이머보다 먼저)", shownAt !== null && shownAt < 6000 * SLOW, shownAt === null ? "끝내 안 뜸" : `${(shownAt / 1000).toFixed(1)}초 (기준 ${6 * SLOW}초)`);
check("차단: 안내가 보임", shownAt !== null);
const box = JSON.parse(await ev(`(() => { const r = document.getElementById("boot-msg").getBoundingClientRect(); const c = getComputedStyle(document.getElementById("boot-msg")); return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), font: c.fontSize, text: document.getElementById("boot-msg").textContent.trim().replace(/\s+/g, " ") }); })()`));
check("차단: 안내 글자 16px 이상·문구", parseFloat(box.font) >= 16 && /브라우저를 최신으로 업데이트하거나 Chrome/.test(box.text), `${box.font} · ${box.text}`);

console.log(ok ? "\n전부 통과" : "\n실패 있음");
await quitChrome(chrome, ws); process.exit(ok ? 0 : 1);
