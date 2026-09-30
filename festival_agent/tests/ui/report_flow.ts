// 방문객 접수 흐름: 미리 선택 → 응급 박스 없음 → 빈 내용 막기 → 실패 시 오류(모달 없음) → 접수 → 완료 모달(포커스·Esc·닫기·한 건 더, 구역 유지). 사용: node report_flow.ts <base> [--nodialog]   (--nodialog: <dialog>/showModal 이 없는 브라우저 흉내 → 고정 div 오버레이 경로 점검)
import { openChrome, quitChrome } from "./lib.ts";

const base = process.argv[2];
const noDialog = process.argv.includes("--nodialog");
// 기계가 바쁘면 화면이 늦게 반응한다 — run_all 이 CPU 사용률로 정한 배율(UI_SLOW 1~3)만큼 기다리는 시간만 늘린다 (검사 기준은 그대로)
const SLOW = Math.max(1, Number(process.env.UI_SLOW) || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));
const { chrome, ws, send, ev } = await openChrome({ prefix: "rf-" });
let ok = true;
const check = (name, cond, detail = "") => { ok &&= !!cond; console.log(`${cond ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`); };

await send("Page.enable");
if (noDialog) await send("Page.addScriptToEvaluateOnNewDocument", { source: "try { HTMLDialogElement.prototype.showModal = undefined; } catch (e) {}" });
console.log(noDialog ? "[모드] <dialog> 없음 → 대체 오버레이" : "[모드] 기본 (<dialog>)");
await send("Page.navigate", { url: base + "/?v=qr&zone=" + encodeURIComponent("유등터널") });
// 고정 4초 대신: 구역 목록과 축제 이름을 서버에서 받아 채울 때까지 (다른 세션이 CPU 를 쓰면 4초로는 모자란다). 최대 15초.
for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector("select option:nth-child(2)") && document.querySelector(".brand strong").textContent !== "축제 민원 관제"`)) break; await sleep(250); }
await sleep(300);
check("?zone=유등터널 미리 선택", (await ev(`document.querySelector("select").selectedOptions[0].textContent`)) === "유등터널");
check("머리글 = 축제 이름", (await ev(`document.querySelector(".brand strong").textContent`)) !== "축제 민원 관제",
  await ev(`document.querySelector(".brand strong").textContent`));
check("응급 박스 없음 (제출 전 화면에 119/112 박스·전화 링크 없음)", (await ev(`document.querySelectorAll(".rp-sos, a[href^='tel:']").length`)) === 0);
check("FAQ 5문항 (접속 기록 문항 포함, 사진 문항 없음)", (await ev(`document.querySelectorAll(".rp-faq details").length`)) === 5 &&
  !(await ev(`document.querySelector(".rp-faq").textContent.includes("사진")`)));
check("이름·연락처 입력칸 없음", (await ev(`document.querySelectorAll("input").length`)) === 0);

// 구역 선택 시트 (D5-45): 버튼 → 시트 → 방향키 · Enter → 값 바뀜 · 닫히고 포커스 복귀 · Esc
const zbtn = `document.querySelector(".rp-zone-btn")`;
check("구역 버튼: aria-haspopup=listbox · aria-expanded=false", (await ev(`${zbtn}?.getAttribute("aria-haspopup")`)) === "listbox" && (await ev(`${zbtn}?.getAttribute("aria-expanded")`)) === "false");
await ev(`${zbtn}.focus(); ${zbtn}.click()`); await sleep(400);
check("시트가 열림 · listbox/option · 현재 구역 선택 표시", (await ev(`!!document.querySelector(".rp-zsheet [role=listbox]") && document.querySelectorAll(".rp-zsheet [role=option]").length > 1 && document.querySelector(".rp-zsheet [aria-selected=true] .zn")?.textContent`)) === "유등터널"
  && (await ev(`${zbtn}.getAttribute("aria-expanded")`)) === "true");
check("열리면 포커스가 선택된 행", (await ev(`document.activeElement?.getAttribute("role")`)) === "option" && (await ev(`document.activeElement?.textContent.includes("유등터널")`)));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
check("Tab → 닫기 버튼 (시트 안에서만 순환)", await ev(`document.activeElement?.classList.contains("rp-zsheet-x")`));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(500);
check("Esc → 시트 닫힘 · 구역 그대로 · 버튼으로 포커스 복귀", !(await ev(`!!document.querySelector(".rp-zsheet")`)) && (await ev(`document.querySelector("select").selectedOptions[0].textContent`)) === "유등터널"
  && (await ev(`document.activeElement === ${zbtn}`)) && (await ev(`${zbtn}.getAttribute("aria-expanded")`)) === "false");
await ev(`${zbtn}.click()`); await sleep(400);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
const moved = await ev(`document.activeElement?.querySelector(".zn")?.textContent`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(500);
check("↓ + Enter → 그 구역 선택 · 시트 닫힘 · 행 글자 바뀜", !!moved && moved !== "유등터널" && (await ev(`document.querySelector("select").selectedOptions[0].textContent`)) === moved
  && (await ev(`document.querySelector("#rzone").textContent`)) === moved && !(await ev(`!!document.querySelector(".rp-zsheet")`)), moved);
// 다음 검사를 위해 원래 구역으로
await ev(`(() => { const s = document.querySelector("select"); s.value = [...s.options].find((o) => o.textContent === "유등터널").value; s.dispatchEvent(new Event("change")); })()`);

await ev(`document.querySelector("#rf button").click()`); await sleep(300);
check("빈 내용 → 보내지 않고 안내", (await ev(`document.querySelector("#rerr").hidden`)) === false,
  await ev(`document.querySelector("#rerr").textContent`));

const fill = (v) => ev(`(() => { const t = document.querySelector("textarea"); t.value = ${JSON.stringify(v)}; t.dispatchEvent(new Event("input")); })()`);
const dlgOpen = () => ev(`!!document.querySelector(".rp-modal[open]")`);
const zoneNow = () => ev(`document.querySelector("select").selectedOptions[0].textContent`);
check("신고 예시 아이콘 5개 (관제·조치와 같은 한 벌)", (await ev(`document.querySelectorAll(".rp-ex .rp-glyph svg.ti").length`)) === 5);
for (const junk of ["...", "!!!", "  ㅋ  ", "😀😀"]) {
  await fill(junk);
  await ev(`document.querySelector("#rf button").click()`); await sleep(300);
  const shown = await ev(`document.querySelector("#rerr").hidden === false ? document.querySelector("#rerr").textContent : ""`);
  const blocked = /^ㅋ$/.test(junk.trim()) ? true : shown === "어떤 불편인지 조금 더 적어 주세요";   // 'ㅋ' 한 글자는 글자 수(2자) 규칙으로도 막힌다
  check(`글자 없는 입력 '${junk.trim()}' → 보내지 않고 같은 문구`, blocked && !(await dlgOpen()), shown);
}
await fill("유등터널 입구 조명이 꺼져서 어두워요 010-1234-5678");
check("글자 수 표시", (await ev(`document.querySelector("#rcount").textContent`)) === "34", await ev(`document.querySelector("#rcount").textContent`));

// 실패: 서버 호출이 막히면 모달 없이 폼 아래 오류, 버튼은 되살아나고 입력은 남는다
await ev(`window.__f = window.fetch; window.fetch = () => Promise.reject(new Error("offline"))`);
await ev(`document.querySelector("#rf button").click()`); await sleep(800);
check("실패 → 모달 없이 폼 아래 오류", !(await dlgOpen()) && (await ev(`document.querySelector("#rerr").hidden`)) === false, await ev(`document.querySelector("#rerr").textContent`));
// 연결 실패는 같은 버튼이 '다시 시도'가 된다 (D5-36). 그 밖의 실패(서버가 이유를 준 오류)는 '접수하기'.
check("실패 후 버튼 복구 · 입력 유지", (await ev(`document.querySelector("#rf button").textContent`)) === "다시 시도" && (await ev(`document.querySelector("#rf button").disabled`)) === false
  && (await ev(`document.querySelector("textarea").value.length`)) > 0);
await ev(`window.fetch = window.__f`);

await ev(`document.querySelector("#rf button").click()`);
await sleep(50);
const sending = await ev(`document.querySelector("#rf button")?.textContent ?? ""`);
await sleep(2000);
check("'보내는 중…' → 완료 모달", /보내는 중/.test(sending) || (await dlgOpen()), `버튼: ${sending}`);
check("모달이 열림 · 화면은 그대로 (폼이 뒤에 남아 있음)", (await dlgOpen()) && (await ev(`!!document.querySelector("#rf")`)));
check(noDialog ? "대체 경로: 고정 div 오버레이(dialog 태그 아님)" : "기본 경로: <dialog>", noDialog ? await ev(`!!document.querySelector(".rp-overlay > div.rp-modal[role=dialog][aria-modal=true]") && !document.querySelector("dialog")`) : await ev(`!!document.querySelector("dialog.rp-modal[open]")`));
check("포커스가 모달 안", await ev(`!!document.activeElement?.closest(".rp-modal")`), await ev(`document.activeElement?.textContent?.trim()`));
check("완료 문구", await ev(`document.querySelector(".rp-modal").textContent.includes("감사합니다.")`));
check("접수번호 W-n", /접수번호 W-\d+/.test(await ev(`document.querySelector(".rp-modal .receipt")?.textContent ?? ""`)), await ev(`document.querySelector(".rp-modal .receipt")?.textContent`));
check("위치·시각", (await ev(`document.querySelector(".rp-modal .rp-sum").textContent`)).includes("유등터널") && /\d\d:\d\d/.test(await ev(`document.querySelector(".rp-modal .rp-sum").textContent`)));
check("처리 단계 안내 없음", (await ev(`document.querySelectorAll(".rp-modal .rp-next").length`)) === 0);
check("모달 하단 119·112 한 줄만", (await ev(`[...document.querySelectorAll('a[href^="tel:"]')].map(a=>a.getAttribute("href")).join(",")`)) === "tel:119,tel:112"
  && (await ev(`document.querySelectorAll(".rp-modal .rp-foot").length`)) === 1);
check("버튼 [한 건 더 접수] · [닫기]", (await ev(`[...document.querySelectorAll(".rp-modal .rp-modal-actions button")].map(b=>b.textContent.trim()).join("|")`)) === "한 건 더 접수|닫기");
const tab = async (shift) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); await sleep(60); };
// 포커스가 뒤 화면(폼·예시·FAQ)으로 새지 않아야 한다. 네이티브 <dialog> 는 끝에서 브라우저 주소창으로 넘어가는데(activeElement = body) 그건 정상이다.
// 대체 경로는 우리가 Tab 을 순환시키므로 항상 모달 안이어야 한다.
const leaked = () => ev(`(() => { const a = document.activeElement; return !!a && a !== document.body && !a.closest(".rp-modal"); })()`);
const inside = () => ev(`!!document.activeElement?.closest(".rp-modal")`);
let ok1 = true; for (let i = 0; i < 6; i++) { await tab(false); ok1 &&= !(await leaked()) && (!noDialog || (await inside())); }
await tab(true); ok1 &&= !(await leaked()) && (!noDialog || (await inside()));
check("Tab · Shift+Tab 으로 포커스가 뒤 화면으로 새지 않음" + (noDialog ? " (모달 안에서 순환)" : ""), ok1);
check("모달이 화면 안에 들어옴 (가로 넘침 없음)", await ev(`(() => { const r = document.querySelector(".rp-modal").getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5; })()`));

// Esc 로 닫기 → 폼 초기화, 구역 유지
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await sleep(400);
check("Esc 로 닫힘", !(await dlgOpen()));
check("닫힌 뒤 스크롤 잠금 해제 · 뒤 화면 접근성 복구", await ev(`!document.body.classList.contains("rp-lock") && !document.querySelector("[aria-hidden=true] #rf, #rf[aria-hidden]") && !document.querySelector("[data-hid]")`));
check("닫으면 폼 초기화 · 구역 유지", (await ev(`document.querySelector("textarea").value`)) === "" && (await ev(`document.querySelector("#rcount").textContent`)) === "0" && (await zoneNow()) === "유등터널"
  && (await ev(`document.querySelector("#rf button").disabled`)) === false && (await ev(`document.querySelector("#rf button").textContent`)) === "접수하기");

// 한 건 더 접수 → 닫히고 입력칸에 포커스, 구역 유지
await fill("화장실 줄이 너무 깁니다");
await ev(`document.querySelector("#rf button").click()`); await sleep(2000);
await ev(`document.querySelector("#again").click()`); await sleep(400);
check("한 건 더 → 모달 닫힘 · 입력칸 포커스 · 구역 유지", !(await dlgOpen()) && (await ev(`document.activeElement?.tagName`)) === "TEXTAREA" && (await zoneNow()) === "유등터널");

// 닫기 버튼
await fill("난간이 흔들려요");
await ev(`document.querySelector("#rf button").click()`); await sleep(2000);
await ev(`document.querySelector("#dclose").click()`); await sleep(400);
check("[닫기] → 닫힘 · 폼 초기화", !(await dlgOpen()) && (await ev(`document.querySelector("textarea").value`)) === "");

const gotoFresh = async (url) => {
  await ev(`window.__old = 1`);
  await send("Page.navigate", { url });
  for (let i = 0; i < 60; i++) { if (await ev(`!window.__old && !!document.querySelector("select option:nth-child(2)")`)) break; await sleep(250); }
  await sleep(300);
};
await gotoFresh(base + "/?v=qr&zone=없는구역");
check("없는 ?zone= 은 무시", (await ev(`document.querySelector("select").value`)) === "");
await gotoFresh(base + "/?v=qr&zone=4");
check("?zone=4 (id) 도 허용", (await ev(`document.querySelector("select").value`)) === "4", await ev(`document.querySelector("select").selectedOptions[0].textContent`));

console.log(ok ? "\n전부 통과" : "\n실패 있음");
await quitChrome(chrome, ws); process.exit(ok ? 0 : 1);
