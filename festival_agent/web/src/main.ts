// 단일 페이지. 해시로 화면을 고르고, DB 변경이 오면 지금 화면만 다시 그린다.
//   #control  관제 (기본)     #action  조치     #report  접수 (QR)
//   ?v=qr     방문객용 — 상단 탭을 숨기고 접수 화면만 보인다.
import "./style.css";
import "./conn.css";
import "./layout.css";
import { api, onHeaderMeta } from "./data";
import { LABELS, resetFresh, stateBox, toast } from "./ui";
import { renderAction } from "./views/action";
import { renderControl } from "./views/control";
import { renderQr } from "./views/qr";
import { renderReport } from "./views/report";

const app = document.getElementById("app")!;
const live = document.getElementById("live")!;
const visitor = new URLSearchParams(location.search).get("v") === "qr";

const TITLES: Record<string, string> = { control: "관제", action: "조치", report: "접수 QR" };
const views: Record<string, (root: HTMLElement) => Promise<void>> = {
  control: renderControl,
  action: renderAction,
  // 관리자의 '접수 QR' 는 QR 만들기 화면, 방문객(?v=qr)은 접수 화면이다 (둘 다 경로 이름은 report)
  report: visitor ? renderReport : renderQr,
};

function route(): string {
  if (visitor) return "report";
  const r = location.hash.slice(1);
  return r in views ? r : "control";
}

let drawing = false;
let again = false;
let shown: string | null = null;   // 지금 화면에 그려져 있는 화면 — 바뀔 때만 카드 등장 모션을 준다 (D5-26)
let enterTimer: number | undefined;
async function draw(): Promise<void> {
  if (drawing) { again = true; return; }
  drawing = true;
  const r = route();
  document.querySelectorAll<HTMLAnchorElement>("#tabs a").forEach((a) => {
    const on = a.dataset.route === r;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const title = document.getElementById("page-title");
  if (title) title.textContent = TITLES[r] ?? "";
  // 처음 열거나 탭을 옮길 때만 'enter'. SSE 로 다시 그릴 때는 붙이지 않아 깜빡이지 않는다.
  const entering = r !== shown;
  if (entering) { clearTimeout(enterTimer); app.classList.add("enter"); resetFresh(); }
  try {
    await views[r](app);
  } catch (e) {
    // 이미 잘 그려진 화면을 다시 그리다 실패하면(서버가 잠깐 끊김) 그 화면을 지우지 않는다 — 배너·'재연결 중'이 알려 주고, 다시 붙으면 다시 그린다 (D5-36)
    if (!entering && shown === r && app.children.length > 0 && !app.querySelector(".state.error")) { drawing = false; again = false; return; }
    console.error(e);      // 개발자용 문구는 화면에 내지 않고 콘솔에만 (esc 로 가리던 String(e) 는 더 이상 화면에 나가지 않는다)
    app.innerHTML = `<section class="card">${stateBox({ kind: "error", icon: "alert", title: "화면을 불러오지 못했습니다", hint: "서버에 연결할 수 없거나 응답이 늦습니다. 잠시 뒤 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요." })}</section>`;
  }
  shown = r;
  if (!app.querySelector(".state.error")) lastOk = Date.now();   // 제대로 그려졌으면 '마지막 갱신' 시각으로
  // 그려진 뒤 잠깐 있다가 끈다 — 이후 SSE 로 다시 그릴 때는 카드가 다시 나타나지 않는다
  if (entering) enterTimer = window.setTimeout(() => app.classList.remove("enter"), 500);
  drawing = false;
  if (again) { again = false; draw(); }
}

// 변경이 몰려 와도 0.5초에 한 번만 다시 그린다. 접수 화면은 입력 중이라 건드리지 않는다.
let timer: number | undefined;
function refresh(): void {
  if (route() === "report") return;
  clearTimeout(timer);
  timer = window.setTimeout(draw, 500);
}

const backendName = api.name === "local" ? "로컬 DB" : "Supabase";
live.textContent = `연결 중 · ${backendName}`; // 연결 전에도 어느 백엔드인지 보이게

// 헤더 배지 2개 + 합성 표시: ① 데이터(#live: 로컬 DB / Supabase) ② AI 해석 방식 ③ 합성 데이터 포함.
// ②는 서버가 backend_llm 을 줄 때만 보인다 — 모르는 값을 짐작해서 적지 않는다.
const AI_LABEL: Record<string, string> = { claude_code: "AI: Claude Code (개발용)", anthropic: "AI: Claude API", local: "AI: 규칙(개발용)" };
const chipAi = document.getElementById("chip-ai")!;
const chipSyn = document.getElementById("chip-syn")!;
const chipCrowd = document.getElementById("chip-crowd")!;
function setChip(el: HTMLElement, text: string | null): void {
  el.hidden = !text;
  if (text !== null && el.textContent !== text) el.textContent = text;
}
if (!visitor) {
  onHeaderMeta((m) => {
    setChip(chipAi, m.backend_llm ? (AI_LABEL[m.backend_llm] ?? `AI: ${m.backend_llm}`) : null);
    setChip(chipSyn, m.synthetic?.on ? `합성 데이터 포함 · ${m.synthetic.count}건` : null);
    // 접수 몰림(D5-33 ③): 차단이 아니라 알림. 가장 많이 몰린 구역 하나 + 나머지는 '외 N곳'
    const c = m.crowding ?? [];
    setChip(chipCrowd, c.length ? `접수 몰림 · ${c[0].zone} ${c[0].count}건/${Math.max(1, Math.round(c[0].window_sec / 60))}분${c.length > 1 ? ` 외 ${c.length - 1}곳` : ""}` : null);
  });
}

// 연결 끊김 (D5-36): 끊기면 #live 가 '재연결 중'으로 바뀐다 (아래 onStatus). 8초 넘게 안 붙으면 배너로 알리고, 붙으면 사라진다.
// 방문객 화면에는 배너를 두지 않는다 — 접수 실패는 접수 화면이 입력을 남긴 채 '다시 시도'로 알려 준다.
const DOWN_BANNER_MS = 8000;
let lastOk = Date.now();                      // 마지막으로 서버와 이어졌던(또는 화면을 그린) 시각
let downTimer: number | undefined;
const banner = document.createElement("div");
banner.id = "conn-banner";
banner.setAttribute("role", "status");
banner.hidden = true;
if (!visitor) document.querySelector("header.top")?.after(banner);
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
function connection(ok: boolean): void {
  if (ok) {
    lastOk = Date.now();
    clearTimeout(downTimer); downTimer = undefined;
    banner.hidden = true;
  } else if (downTimer === undefined && banner.hidden) {
    downTimer = window.setTimeout(() => {
      downTimer = undefined;
      banner.innerHTML = `서버에 연결할 수 없습니다 · 마지막 갱신 ${hhmm(lastOk)} <span>자동으로 다시 연결하는 중입니다</span>`;
      banner.hidden = false;
    }, DOWN_BANNER_MS);
  }
}

function subscribe(): void {
  api.subscribe({
    onChange: refresh,
    onAlert: (a) => {
      if (!visitor) toast(`⚠ ${LABELS[a.label] ?? a.label} — ${a.detail}`, "warn");
      refresh();
    },
    onDocDone: (j) => toast(`${LABELS[j.label] ?? j.label} 조치요청서가 만들어졌습니다`),
    onStatus: (ok) => {
      live.textContent = `${ok ? "실시간" : "재연결 중"} · ${backendName}`;
      live.classList.toggle("ok", ok);
      connection(ok);
    },
  });
}

// 관리자 화면 뼈대: 사이드바 · 햄버거(좁은 화면) · 본문 제목 줄. 방문객 화면에는 아예 만들지 않는다 (DOM 에서 지운다).
if (visitor) {
  for (const id of ["side", "side-scrim", "menu-btn", "page-head"]) document.getElementById(id)?.remove();
} else {
  const menuBtn = document.getElementById("menu-btn")!;
  const scrim = document.getElementById("side-scrim")!;
  const setMenu = (open: boolean) => {
    document.body.classList.toggle("side-open", open);
    scrim.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
  };
  menuBtn.addEventListener("click", () => setMenu(!document.body.classList.contains("side-open")));
  scrim.addEventListener("click", () => setMenu(false));
  document.getElementById("tabs")!.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("a")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("side-open")) { setMenu(false); menuBtn.focus(); } });
  // 사이드바에 축제 이름 (못 받으면 기본 이름 유지)
  api.festival().then((name) => { if (name) document.getElementById("side-name")!.textContent = name; }).catch(() => {});
}
if (visitor) {
  document.body.classList.add("visitor");
  // 방문객에게는 "축제 민원 관제" 대신 축제 이름을 보인다 (실패하면 기본 제목 유지)
  api.festival().then((name) => {
    if (!name) return;
    document.querySelector(".brand strong")!.textContent = name;
    document.title = `${name} · 불편 접수`;
  }).catch(() => {});
}
window.addEventListener("hashchange", draw);
subscribe();
draw();
