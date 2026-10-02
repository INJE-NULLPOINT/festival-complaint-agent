// 접수 — 방문객이 QR 로 들어오는 화면. 이름·연락처는 받지 않는다.
// 방문객 접수 ①접수 ②완료 ③FAQ 화면
//   ?zone=유등터널  또는  ?zone=4   → 그 구역이 미리 선택된 채로 열린다 (QR 마다 다르게)
// 모양은 흑백 결제 화면 느낌 (제출_준비/stitch/reference_bw_checkout.png). 스타일은 style.css 의 .rp · body.visitor 에만.
// 접수하면 화면을 바꾸지 않고 <dialog> 모달로 완료를 띄운다 (D5-24). 응급 안내는 모달 맨 아래 한 줄만.
import { api, zones, type Zone } from "../data";
import { esc, reduced, stateBox, typeIcon } from "../ui";

const MAX = 500;

// 무엇을 알려 주면 되는지 — 분류 라벨과 같은 묶음. [유형 키(아이콘), 이름, 예시]  첫 줄(안전)을 가장 굵게
// 아이콘은 관제·조치와 같은 한 벌(ui.ts typeIcon)을 쓴다 (D5-26)
const EXAMPLES: [string, string, string][] = [
  ["safety", "안전", "어두운 구간, 미끄러운 바닥, 흔들리는 난간, 인파 밀집"],
  ["parking", "주차·교통", "주차 혼잡, 셔틀 대기"],
  ["restroom", "화장실", "대기 줄, 위생 상태"],
  ["price", "가격", "지나친 가격, 가격표 없음"],
  ["guide", "안내", "길 찾기 어려움, 표지판 부족"],
];

// 사진 첨부는 이번 제출에서 뺐다 — 사진 관련 UI·FAQ 문항을 넣지 않는다
const FAQ: [string, string][] = [
  ["이름이나 연락처를 적어야 하나요?", "아니요. 묻지 않습니다."],
  ["제 개인정보가 남나요?", "이름·연락처는 묻지 않습니다. 정해진 형식의 전화번호·이메일은 자동으로 가려집니다. 이름·주소는 적지 말아 주세요."],
  ["답변을 받을 수 있나요?", "연락처를 받지 않아 개별 답변은 드리지 못합니다. 담당자가 확인합니다."],
  ["같은 내용을 여러 번 신고해도 되나요?", "괜찮습니다. 같은 불편을 겪은 분이 많을수록 더 먼저 살펴봅니다. 다만 같은 구역에서 똑같은 글이 2분 안에 다시 들어오면 한 건으로 합쳐집니다."],
  ["접속 기록이 남나요?", "장난 신고를 막기 위해 접속 주소를 알아볼 수 없는 값으로 바꿔 쓰고, 24시간이 지나면 지웁니다. 원래 주소는 저장하지 않고, 신고 내용과도 연결하지 않습니다."],
];

const ico = (d: string) => `<svg class="rp-ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const PIN = ico(`<path class="f" d="M12 2a7 7 0 0 0-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/>`);
const LOCK = ico(`<path class="f" d="M7 10V8a5 5 0 0 1 10 0v2h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h6V8a3 3 0 0 0-6 0v2Z"/>`);
const CHEV = `<span class="rp-chev" aria-hidden="true">›</span>`;

/** 글자(문자·숫자)가 하나라도 있는지. '...' · '!!' 는 false.
 *  \p{L} 정규식은 구형 브라우저에서 문법 오류가 되므로 문자열로 만들어 시도하고, 안 되면 한글·영문·숫자로 본다. */
function hasLetter(t: string): boolean {
  try { return new RegExp("[\\p{L}\\p{N}]", "u").test(t); } catch { return /[0-9A-Za-zÀ-ɏ㄰-㆏가-힣]/.test(t); }
}

/** ?zone= 값을 구역 id 로. 이름·id 둘 다 받고, 없는 값은 무시한다. */
function presetZone(zs: Zone[]): number | null {
  const q = new URLSearchParams(location.search).get("zone")?.trim();
  if (!q) return null;
  const byId = zs.find((z) => String(z.id) === q);
  if (byId) return byId.id;
  const norm = (s: string) => s.replace(/\s+/g, "");
  return zs.find((z) => norm(z.name) === norm(q))?.id ?? null;
}

export async function renderReport(root: HTMLElement): Promise<void> {
  const zs = await zones();
  // 구역 목록이 비어 있으면(서버 설정 전이거나 불러오기 실패) 접수 양식을 보여 줘도 보낼 수 없다 — 이유를 알리고 다시 열어 보게 한다 (D5-39)
  if (!zs.length) {
    root.innerHTML = `
    <section class="card narrow rp">
      <h1>불편 신고</h1>
      ${stateBox({ kind: "error", icon: "alert", title: "지금은 접수할 수 없습니다", hint: "접수할 구역 정보를 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요. 급한 일은 119(응급·화재) 또는 112(사건·사고)로 연락하세요." })}
    </section>`;
    return;
  }
  const preset = presetZone(zs);
  const zoneName = (id: number) => zs.find((z) => z.id === id)?.name ?? "";

  root.innerHTML = `
    <section class="card narrow rp">
      <h1>불편 신고</h1>
      <p class="rp-lead">이름이나 연락처는 적지 않아도 됩니다.</p>
      <p class="rp-lead">생명이 위급하면 119·112에 먼저 연락해 주세요.</p>

      <form id="rf" class="form rp-form" novalidate>
        <!-- 구역: 행 모양. 투명한 select 가 행 전체를 덮어 누르면 폰 기본 선택창이 열린다 -->
        <label class="rp-row rp-zone ${preset ? "on" : ""}">
          ${PIN}
          <span class="rp-row-text">
            <b id="rzone">${esc(preset ? zoneName(preset) : "구역 선택")}</b>
            <span>위치</span>
          </span>
          ${CHEV}
          <select name="zone" required aria-label="위치">
            <option value="">구역 선택</option>
            ${zs.map((z) => `<option value="${z.id}" ${z.id === preset ? "selected" : ""}>${esc(z.name)}</option>`).join("")}
          </select>
        </label>

        <label class="rp-field">
          <span class="rp-sec">무엇이 불편했나요? <span class="rp-count"><b id="rcount">0</b>/${MAX}</span></span>
          <textarea name="text" rows="5" maxlength="${MAX}" required
            placeholder="예) 유등터널 입구에 사람이 너무 몰려서 밀려요"></textarea>
        </label>
        <span class="sr-only" id="rlive" role="status" aria-live="polite"></span>
        <p class="rp-hint">${LOCK}<span>정해진 형식의 전화번호·이메일은 자동으로 가려집니다. 이름·주소는 적지 말아 주세요.</span></p>

        <div class="rp-bar">
          <p class="err" id="rerr" role="alert" hidden></p>
          <button class="btn primary big" type="submit">접수하기</button>
        </div>
      </form>

      <section class="rp-ex" aria-label="이런 것을 알려 주세요">
        <h2 class="rp-sec">이런 것을 알려 주세요</h2>
        <ul>${EXAMPLES.map(([g, k, v], i) => `
          <li class="rp-row ${i === 0 ? "safe" : ""}">
            <span class="rp-glyph" aria-hidden="true">${typeIcon(g)}</span>
            <span class="rp-row-text"><b>${esc(k)}${i === 0 ? ` <em>가장 먼저 살펴봄</em>` : ""}</b><span>${esc(v)}</span></span>
          </li>`).join("")}</ul>
      </section>

      <section class="rp-faq" aria-label="자주 묻는 질문">
        <h2 class="rp-sec">자주 묻는 질문</h2>
        ${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}
      </section>

      <p class="rp-foot">알려 주셔서 감사합니다. 여러분의 한 줄이 다음 방문객의 안전을 만듭니다.</p>
    </section>`;

  const form = root.querySelector<HTMLFormElement>("#rf")!;
  const err = root.querySelector<HTMLElement>("#rerr")!;
  const select = form.querySelector<HTMLSelectElement>("select")!;
  const text = form.querySelector<HTMLTextAreaElement>("textarea")!;
  const count = root.querySelector<HTMLElement>("#rcount")!;
  // 글자 수는 눈으로만 갱신한다(매 글자마다 스크린리더가 읽으면 방해). 450자부터 몇 번만 알린다 (D5-38)
  const live = root.querySelector<HTMLElement>("#rlive")!;
  text.addEventListener("input", () => {
    const n = text.value.length;
    count.textContent = String(n);
    if (n < 450) live.textContent = "";
    else if (n === 450 || n === 480 || n === 495) live.textContent = `${MAX}자 중 ${n}자 입력했습니다. ${MAX - n}자 남았습니다`;
    else if (n >= MAX) live.textContent = `${MAX}자를 모두 썼습니다`;
  });
  // 키보드 포커스일 때만 행에 테두리를 보인다 (:has 를 쓰지 않으려고 직접 처리. :focus-visible 이 없는 브라우저는 건너뛴다)
  const zoneRow = select.closest(".rp-zone")!;
  select.addEventListener("focus", () => {
    let kb = false;
    try { kb = select.matches(":focus-visible"); } catch { /* 구형 브라우저 */ }
    zoneRow.classList.toggle("kf", kb);
  });
  select.addEventListener("blur", () => zoneRow.classList.remove("kf"));
  // 행에 보이는 구역 이름은 select 를 따라간다
  select.addEventListener("change", () => {
    const n = zoneName(Number(select.value));
    root.querySelector("#rzone")!.textContent = n || "구역 선택";
    select.closest(".rp-zone")!.classList.toggle("on", !!n);
  });
  // 구역은 아래에서 올라오는 시트로 고른다. 만들지 못하면 기본 select 를 그대로 쓴다 (D5-45)
  let zoneFocus: HTMLElement = select;
  try { zoneFocus = enhanceZone(root.querySelector<HTMLElement>(".rp")!, zoneRow as HTMLElement, select, zs); } catch { /* 기본 select */ }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const zoneId = Number(fd.get("zone"));
    const body = String(fd.get("text") ?? "");
    // 서버(RPC)도 같은 규칙으로 막는다. 여기서는 보내기 전에 먼저 알려 줄 뿐이다.
    // '...' · '!!' 처럼 글자(문자·숫자)가 하나도 없는 입력도 막는다 — 서버와 같은 문구.
    const hasText = hasLetter(body);
    const problem = !zoneId ? "구역을 선택해 주세요" : !hasText || body.trim().length < 2 ? "어떤 불편인지 조금 더 적어 주세요" : "";
    if (problem) {
      err.textContent = problem;
      err.hidden = false;
      (!zoneId ? zoneFocus : text).focus();
      return;
    }
    const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    btn.disabled = true;
    btn.textContent = "보내는 중…";
    err.hidden = true;

    let no: number;
    try {
      no = await api.submitFeedback(zoneId, body);
    } catch (e) {
      // 연결이 안 된 경우: 적은 내용·고른 구역은 그대로 두고, 같은 버튼이 '다시 시도'가 된다 (D5-36)
      const net = isNetworkError(e);
      err.textContent = net ? "접수하지 못했습니다. 인터넷 연결을 확인해 주세요. 적은 내용은 그대로 남아 있으니 잠시 뒤 '다시 시도'를 눌러 주세요." : (e as Error).message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = net ? "다시 시도" : "접수하기";
      return;
    }
    const now = new Date().toTimeString().slice(0, 5);
    openDone(root, { no, zone: zoneName(zoneId), now }, () => {
      // 닫으면 폼을 비운다. ?zone= 구역은 주소에 남아 있어 그대로 미리 선택된다 (없으면 '구역 선택')
      text.value = "";
      count.textContent = "0";
      select.value = preset ? String(preset) : "";
      select.dispatchEvent(new Event("change"));
      btn.disabled = false;
      btn.textContent = "접수하기";
    });
  });
}

/** 구역 고르기 시트 (D5-45). 기본 select 는 그대로 두고(폼 값 · 검증 · 구형 브라우저 대비) 화면에서만 가리고,
 *  그 위에 투명 버튼을 얹어 누르면 아래에서 시트가 올라오게 한다. 만드는 중 오류가 나면 되돌려 기본 select 로 쓴다.
 *  버튼 aria-haspopup=listbox · aria-expanded, 목록 role=listbox/option. 방향키 · Home/End · Enter/Space · Esc · Tab 순환, 닫으면 버튼으로 포커스 복귀. */
function enhanceZone(host: HTMLElement, row: HTMLElement, select: HTMLSelectElement, zs: Zone[]): HTMLElement {
  // <button> 이 아니라 role=button 인 div — 폼 안의 첫 <button> 은 늘 '접수하기' 여야 해서 (다른 코드 · 검사가 그렇게 찾는다)
  const btn = document.createElement("div");
  btn.className = "rp-zone-btn";
  btn.setAttribute("role", "button");
  btn.tabIndex = 0;
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const sync = () => {
    const z = zs.filter((x) => String(x.id) === select.value)[0];
    btn.setAttribute("aria-label", `위치: ${z ? z.name : "구역 선택"}`);
  };
  sync();
  select.addEventListener("change", sync);
  try {
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    row.appendChild(btn);
    row.classList.add("enh");
    btn.addEventListener("click", () => openZoneSheet(host, btn, select, zs));
    btn.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar" || e.key === "ArrowDown" || e.key === "Down") { e.preventDefault(); openZoneSheet(host, btn, select, zs); }
    });
  } catch (e) {
    select.removeEventListener("change", sync);
    select.removeAttribute("tabindex");
    select.removeAttribute("aria-hidden");
    row.classList.remove("enh");
    if (btn.parentNode) btn.parentNode.removeChild(btn);
    throw e;
  }
  return btn;
}

function openZoneSheet(host: HTMLElement, btn: HTMLElement, select: HTMLSelectElement, zs: Zone[]): void {
  if (host.querySelector(".rp-zsheet")) return;
  const overlay = document.createElement("div");
  overlay.className = "rp-overlay";
  const box = document.createElement("div");
  box.className = "rp-modal rp-zsheet";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "rzt");
  box.setAttribute("open", "");   // .rp-modal[open] 의 올라오는 모션을 그대로 쓴다
  const cur = select.value;
  box.innerHTML = `
    <div class="rp-zsheet-head">
      <h2 id="rzt" class="rp-zsheet-title">구역 선택</h2>
      <button type="button" class="rp-zsheet-x" aria-label="닫기">✕</button>
    </div>
    <ul class="rp-zlist" role="listbox" aria-labelledby="rzt">${zs.map((z) => `
      <li class="rp-zopt" role="option" data-id="${z.id}" tabindex="-1" aria-selected="${String(z.id) === cur}">
        <span class="zi">${PIN}</span><span class="zn">${esc(z.name)}</span><span class="zc" aria-hidden="true">✓</span>
      </li>`).join("")}</ul>`;
  overlay.appendChild(box);

  const opts: HTMLElement[] = Array.prototype.slice.call(box.querySelectorAll(".rp-zopt"));
  const x = box.querySelector<HTMLElement>(".rp-zsheet-x")!;
  let active: HTMLElement = opts.filter((o) => o.getAttribute("aria-selected") === "true")[0] || opts[0];
  let closing = false;

  const close = () => {
    if (closing) return;
    closing = true;
    box.classList.add("closing");
    overlay.classList.add("closing");
    setTimeout(() => {
      host.querySelectorAll("[data-zhid]").forEach((el) => { el.removeAttribute("aria-hidden"); el.removeAttribute("data-zhid"); });
      document.body.classList.remove("rp-lock");
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      btn.setAttribute("aria-expanded", "false");
      btn.focus();
    }, reduced() ? 0 : 180);
  };
  const choose = (o: HTMLElement) => {
    select.value = String(o.getAttribute("data-id"));
    select.dispatchEvent(new Event("change"));
    close();
  };
  const move = (i: number) => { active = opts[Math.max(0, Math.min(opts.length - 1, i))]; active.focus(); };

  box.addEventListener("keydown", (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const inList = t.classList.contains("rp-zopt");
    const i = opts.indexOf(t);
    if (e.key === "Escape" || e.key === "Esc") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { e.preventDefault(); if (inList) x.focus(); else active.focus(); }   // 시트 안에서만 돈다: 닫기 ↔ 목록
    else if (!inList) return;
    else if (e.key === "ArrowDown" || e.key === "Down") { e.preventDefault(); move(i + 1); }
    else if (e.key === "ArrowUp" || e.key === "Up") { e.preventDefault(); move(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(opts.length - 1); }
    else if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); choose(t); }
  });
  box.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const o = t.closest ? (t.closest(".rp-zopt") as HTMLElement | null) : null;
    if (o) choose(o);
  });
  x.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  // 뒤 화면은 스크린리더에서 숨기고 스크롤을 잠근다
  Array.prototype.forEach.call(host.children, (el: Element) => { el.setAttribute("aria-hidden", "true"); el.setAttribute("data-zhid", ""); });
  document.body.classList.add("rp-lock");
  host.appendChild(overlay);
  btn.setAttribute("aria-expanded", "true");
  active.focus();
}

/** 서버에 닿지 못한 실패인지 — data-local 은 name="NetworkError", Supabase 는 fetch 실패 문구 */
function isNetworkError(e: unknown): boolean {
  const x = e as { name?: string; message?: string };
  return x?.name === "NetworkError" || /failed to fetch|networkerror|load failed|network request failed/i.test(x?.message ?? "");
}

/** 접수 완료 모달. <dialog>.showModal 이 있으면 그걸 쓴다 — 뒤 화면을 막고(inert) 포커스를 안으로 옮기며 Esc 로 닫는다.
 *  없는 브라우저(구형 갤럭시 등)는 같은 내용을 고정 div 오버레이로 띄우고 포커스 이동 · Tab 순환 · Esc · 바깥 클릭을 직접 처리한다 (D5-27).
 *  닫히면 onClose 로 폼을 초기화한다. [한 건 더 접수]는 닫은 뒤 입력칸으로 포커스를 준다. */
function openDone(root: HTMLElement, d: { no: number; zone: string; now: string }, onClose: () => void): void {
  const native = typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";
  const box = document.createElement(native ? "dialog" : "div");
  box.className = "rp-modal";
  box.setAttribute("aria-labelledby", "rmt");
  if (!native) {
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("open", "");   // .rp-modal[open] 스타일 · 모션을 그대로 쓴다
    box.tabIndex = -1;
  }
  box.innerHTML = `
    <header class="rp-modal-head">
      <div class="check" aria-hidden="true">✓</div>
      <h2 id="rmt" class="rp-modal-title">접수되었습니다</h2>
      <p class="rp-lead">감사합니다.</p>
    </header>
    <dl class="rp-sum">
      <div><dt class="receipt">접수번호 <b>W-${esc(d.no)}</b></dt></div>
      <div><dt>위치 · 시각</dt><dd>${esc(d.zone)} · ${esc(d.now)}</dd></div>
    </dl>
    <div class="rp-modal-actions">
      <button type="button" class="btn primary big" id="again">한 건 더 접수</button>
      <button type="button" class="btn big" id="dclose">닫기</button>
    </div>
    <p class="rp-foot">사고·화재·응급상황은 <a href="tel:119">119</a>, 사건·사고는 <a href="tel:112">112</a></p>`;

  // 대체 경로에서는 어두운 배경도 우리가 그린다 (native 는 ::backdrop)
  const overlay = native ? null : document.createElement("div");
  if (overlay) { overlay.className = "rp-overlay"; overlay.appendChild(box); }
  const host = root.querySelector<HTMLElement>(".rp")!;
  const before = document.activeElement as HTMLElement | null;
  let again = false;
  let closing = false;
  let done = false;

  // 뒤 화면 정리: 폼이 다시 활성화되고 초기화된다. 대체 경로는 키 처리 · 접근성 숨김도 되돌린다.
  const finish = () => {
    if (done) return;
    done = true;
    document.removeEventListener("keydown", onKey);
    host.querySelectorAll("[data-hid]").forEach((el) => { el.removeAttribute("aria-hidden"); el.removeAttribute("data-hid"); });
    document.body.classList.remove("rp-lock");
    (overlay ?? box).remove();
    onClose();
    const back = again ? host.querySelector<HTMLElement>("textarea") : before;
    if (back && typeof back.focus === "function") back.focus();
  };
  // 닫을 때도 짧게 움직인다 (D5-26): closing 클래스로 나가는 모션을 주고 끝나면 실제로 닫는다. 움직임 줄이기 설정이면 바로 닫는다.
  const requestClose = () => {
    if (closing) return;
    closing = true;
    box.classList.add("closing");
    overlay?.classList.add("closing");
    setTimeout(() => { if (native) (box as HTMLDialogElement).close(); else finish(); }, reduced() ? 0 : 180);
  };
  // 대체 경로의 키 처리: Esc 로 닫고, Tab 은 모달 안에서만 돈다
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" || e.key === "Esc") { e.preventDefault(); requestClose(); return; }
    if (e.key !== "Tab") return;
    const f = box.querySelectorAll<HTMLElement>("button, a[href]");
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], act = document.activeElement;
    if (e.shiftKey && (act === first || !box.contains(act))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (act === last || !box.contains(act))) { e.preventDefault(); first.focus(); }
  }

  if (native) {
    box.addEventListener("cancel", (e) => { e.preventDefault(); requestClose(); }); // Esc
    box.addEventListener("close", finish);
  } else {
    document.addEventListener("keydown", onKey);
    // 뒤 화면은 스크린리더에서 숨긴다 (native 는 inert 가 대신함)
    Array.prototype.forEach.call(host.children, (el: Element) => { el.setAttribute("aria-hidden", "true"); el.setAttribute("data-hid", ""); });
  }
  // 바깥(어두운 배경)을 눌러도 닫힌다
  (overlay ?? box).addEventListener("click", (e) => { if (e.target === (overlay ?? box)) requestClose(); });
  box.querySelector("#dclose")!.addEventListener("click", requestClose);
  box.querySelector("#again")!.addEventListener("click", () => { again = true; requestClose(); });

  document.body.classList.add("rp-lock");
  host.appendChild(overlay ?? box);
  if (native) (box as HTMLDialogElement).showModal();
  box.querySelector<HTMLElement>("#again")!.focus();
}
