// 단일 페이지. 해시로 화면을 고르고, DB 변경이 오면 지금 화면만 다시 그린다.
//   #control  관제 (기본)     #action  조치     #report  접수 (QR)
//   ?v=qr     방문객용 — 상단 탭을 숨기고 접수 화면만 보인다.
import "./style.css";
import "./conn.css";
import { api, onHeaderMeta } from "./data";
import { LABELS, esc, resetFresh, toast } from "./ui";
import { renderAction } from "./views/action";
import { renderControl } from "./views/control";
import { renderReport } from "./views/report";

const app = document.getElementById("app")!;
const live = document.getElementById("live")!;
const visitor = new URLSearchParams(location.search).get("v") === "qr";

const views: Record<string, (root: HTMLElement) => Promise<void>> = {
  control: renderControl,
  action: renderAction,
  report: renderReport,
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
  document.querySelectorAll<HTMLAnchorElement>("#tabs a").forEach((a) =>
    a.classList.toggle("on", a.dataset.route === r),
  );
  // 처음 열거나 탭을 옮길 때만 'enter'. SSE 로 다시 그릴 때는 붙이지 않아 깜빡이지 않는다.
  const entering = r !== shown;
  if (entering) { clearTimeout(enterTimer); app.classList.add("enter"); resetFresh(); }
  try {
    await views[r](app);
  } catch (e) {
    // 이미 잘 그려진 화면을 다시 그리다 실패하면(서버가 잠깐 끊김) 그 화면을 지우지 않는다 — 배너·'재연결 중'이 알려 주고, 다시 붙으면 다시 그린다 (D5-36)
    if (!entering && shown === r && app.children.length > 0 && !app.querySelector(".err")) { drawing = false; again = false; return; }
    app.innerHTML = `<section class="card"><p class="err">불러오지 못했습니다: ${esc(String(e))}</p></section>`;
  }
  shown = r;
  if (!app.querySelector(".err")) lastOk = Date.now();   // 제대로 그려졌으면 '마지막 갱신' 시각으로
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
const AI_LABEL: Record<string, string> = { claude_code: "AI: Claude Code (개발용)", anthropic: "AI: Claude API", local: "AI: 규칙 대역" };
const chipAi = document.getElementById("chip-ai")!;
const chipSyn = document.getElementById("chip-syn")!;
function setChip(el: HTMLElement, text: string | null): void {
  el.hidden = !text;
  if (text !== null && el.textContent !== text) el.textContent = text;
}
if (!visitor) {
  onHeaderMeta((m) => {
    setChip(chipAi, m.backend_llm ? (AI_LABEL[m.backend_llm] ?? `AI: ${m.backend_llm}`) : null);
    setChip(chipSyn, m.synthetic?.on ? `합성 데이터 포함 · ${m.synthetic.count}건` : null);
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
