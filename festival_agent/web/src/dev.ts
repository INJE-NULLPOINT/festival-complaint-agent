// 'AI 동작 보기' (D5-62) — 심사위원이 내부 AI 에이전트가 도는 모습을 보는 화면. 오른쪽 패널(모바일은 아래 시트), 관리자 화면 전용이다.
//   · 헤더의 'AI 동작 보기' 스위치로 켜고 끈다. 기본은 꺼짐. 운영자 코드는 필요 없다. 켠 상태는 localStorage 에 기억한다(try/catch).
//   · 켜져 있는 동안만 3초마다 가져온다 (since 증분). 끄면 타이머가 즉시 멈춘다. 방문객 화면(?v=qr)에서는 initDev 가 불리지 않고 패널·스위치도 없다.
//   · 로그 탭 맨 위에 에이전트의 흐름(⓪ 계획 → ① 분류 → ② 감시 → ③ 조치 → ④ 통합)을 보이고, 지금 돌고 있는 에이전트에 불이 들어온다.
//   · 점수·계산식은 이 패널(심각도 탭) 안에서만 보인다 (관제·조치 화면에는 없다). 모양은 기존 토큰을 쓰고 막대는 쓰지 않는다.
import "./dev.css";
import { AdminDenied } from "./admin";
import { api, type DevClassification, type DevFeed, type DevLog } from "./data";
import { LABELS, esc } from "./ui";

const KEY = "festival_dev_view";
const POLL_MS = 3000;
const MAX_LOGS = 300;
const LIT_MS = 8000;      // 마지막 로그가 이 시간(ms) 안이면 그 에이전트가 '지금 돌고 있다'

/** 에이전트 5개: 흐름 순서 · 이름 · 하는 일 (⓪ 계획이 주기 맨 앞에서 창·집중 유형·조치/통합 호출 여부를 정한다) */
const FLOW: { id: string; no: string; name: string; does: string }[] = [
  { id: "planner", no: "⓪", name: "계획", does: "이번에 무엇을 볼지 정함" },
  { id: "classifier", no: "①", name: "분류", does: "민원의 유형·위험 여부를 판정" },
  { id: "monitor", no: "②", name: "감시", does: "심각도 점수·급증·임계 알림" },
  { id: "dispatcher", no: "③", name: "조치", does: "조치요청서를 작성" },
  { id: "supervisor", no: "④", name: "통합", does: "우선순위와 브리핑을 정리" },
];
const AGENT_NAME: Record<string, string> = { planner: "계획 에이전트", classifier: "분류 에이전트", monitor: "감시 에이전트", dispatcher: "조치 에이전트", supervisor: "통합 에이전트", worker: "워커", replay: "재생기" };
/** 로그의 action(도구 이름) → 사람이 읽는 한 줄. 모르는 것은 action 이름 그대로 보인다. */
const ACTION_KO: Record<string, string> = {
  plan: "이번 주기 계획을 세움", plan_cycle: "이번 주기 계획을 정해 저장",
  get_pending: "분류 대기 민원을 가져옴", save_classification: "민원 1건의 유형·위험 여부를 판정해 저장", lookup_similar: "비슷한 과거 사례 조회", memory_hit: "과거 사례로 바로 분류 (AI 호출 생략)", cache_hit: "같은 문장은 AI 를 다시 부르지 않고 이전 판정을 재사용",
  get_window_stats: "최근 구간의 유형별 건수를 집계", score_label: "유형별 심각도 점수를 계산", save_snapshot: "심각도 결과를 저장", raise_alert: "알림을 발생",
  get_department: "담당 부서를 조회", collect_quotes: "근거가 될 민원 원문을 모음", lookup_festival_info: "축제 정보를 조회", generate_doc: "조치요청서를 작성", upload_failed: "조치요청서 업로드에 실패",
  read_agent_results: "다른 에이전트의 결과를 읽음", rank_actions: "조치 대상의 우선순위를 매김", rank_issues: "조치할 일 카드의 순서를 매김", write_briefing: "운영자에게 줄 브리핑을 작성", skip: "바뀐 것이 없어 문구를 다시 쓰지 않음",
  cli_call: "AI 모델을 호출", api_call: "AI 모델을 호출", cli_failed: "AI 호출에 실패", cli_bad_output: "AI 응답을 해석하지 못함", refusal: "AI 가 응답을 거부", "run(local)": "AI 호출 없이 규칙으로 처리",
  inject: "재생 데이터를 투입", finished: "재생이 끝남", error: "오류가 났음",
};
const TABS: [string, string][] = [["log", "실시간 로그"], ["cls", "분류"], ["sev", "심각도"], ["stat", "상태"]];
const GRADE: Record<string, string> = { immediate: "즉시", high: "높음", mid: "보통", low: "낮음" };

function flagOn(): boolean { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } }
function saveFlag(on: boolean): void { try { if (on) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch { /* 저장을 못 해도 동작한다 */ } }

const time = (s: string | null | undefined) => (s ? String(s).slice(11, 19) : "-");
const num = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "-" : Number(n).toFixed(d));
const lab = (l: string | null | undefined) => (l ? (LABELS[l] ?? l) : "-");
const ms = (s: string | null | undefined) => { const t = Date.parse(String(s ?? "")); return Number.isNaN(t) ? null : t; };

export function initDev(): void {
  const toggle = document.getElementById("dev-toggle");
  if (!toggle || document.body.classList.contains("visitor")) return;

  let on = false, paused = false, busy = false, timer: number | undefined;
  let sinceLog = 0, sinceCls = 0;
  let logs: DevLog[] = [];              // 오래된 것 → 최신 순 (화면은 뒤집어 그린다)
  let buffered = 0;                      // 일시정지 중에 들어온 새 줄 수
  let feed: DevFeed | null = null;
  let tab = "log";

  const panel = document.createElement("aside");
  panel.id = "dev-panel"; panel.className = "dev-panel"; panel.hidden = true; panel.setAttribute("aria-label", "AI 동작 보기");
  panel.innerHTML = `
    <header class="dev-head"><strong>AI 동작 보기</strong><span class="dev-live" id="dev-live" role="status">연결 중</span>
      <button type="button" class="dev-close" id="dev-close" aria-label="AI 동작 보기 닫기">×</button></header>
    <div class="dev-tabs" role="tablist" aria-label="AI 동작 보기 탭">${TABS.map(([k, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}">${t}</button>`).join("")}</div>
    <div class="dev-body" id="dev-body"></div>`;
  document.body.appendChild(panel);
  const body = panel.querySelector<HTMLElement>("#dev-body")!;
  const live = panel.querySelector<HTMLElement>("#dev-live")!;

  function setSwitch(v: boolean): void {
    on = v;
    toggle!.setAttribute("aria-checked", String(v));
    panel.hidden = !v;
    document.body.classList.toggle("dev-open", v);
  }

  // 지금 돌고 있는 에이전트: 마지막 로그가 feed.now 기준 LIT_MS 안인 에이전트
  function active(): { lit: Set<string>; last: Map<string, DevLog> } {
    const last = new Map<string, DevLog>();
    for (const l of logs) last.set(l.agent, l);          // 오래된 → 최신이라 뒤가 이긴다
    const now = ms(feed?.now) ?? Date.now();
    const lit = new Set<string>();
    for (const [a, l] of last) { const t = ms(l.created_at); if (t !== null && now - t <= LIT_MS) lit.add(a); }
    return { lit, last };
  }
  function flowHtml(): string {
    const { lit, last } = active();
    return `<ol class="dev-flow" aria-label="에이전트 흐름">${FLOW.map((f, i) => {
      const l = last.get(f.id), on_ = lit.has(f.id);
      return `<li data-agent="${f.id}" class="dev-step ag-${f.id}${on_ ? " on" : ""}"${on_ ? ` aria-current="true"` : ""}>
        <span class="dev-step-t"><b>${f.no} ${f.name}</b>${on_ ? `<em class="dev-run">동작 중</em>` : ""}</span>
        <span class="dev-step-d">${esc(f.does)}</span><span class="dev-step-l">${l ? `마지막 ${esc(time(l.created_at))}` : "아직 없음"}</span></li>${i < FLOW.length - 1 ? `<li class="dev-arrow" aria-hidden="true">→</li>` : ""}`;
    }).join("")}</ol>`;
  }

  // ── 그리기 ──
  /** 계획 로그(planner · plan)의 결과를 읽기 쉽게: 고른 창 · 집중 유형 · 조치/통합 호출 여부 · 코드가 덮어쓴 것. JSON 이 잘려 읽을 수 없으면 null. */
  function planHtml(l: DevLog): string | null {
    if (l.agent !== "planner" || l.action !== "plan" || !l.output_summary) return null;
    let p: { window_min?: number; focus_labels?: string[]; run_dispatcher?: boolean; run_supervisor?: boolean; overrides?: string[]; reason?: string; source?: string };
    try { p = JSON.parse(l.output_summary); } catch { return null; }
    if (p === null || typeof p !== "object") return null;
    const yn = (v: unknown) => (v ? "부름" : "안 부름");
    const focus = (p.focus_labels ?? []).map(lab).join(", ");
    const ov = p.overrides ?? [];
    return `<div class="dev-plan"><div class="dev-out">창 <b>${esc(p.window_min ?? "-")}분</b> · 집중 유형 <b>${esc(focus || "없음")}</b> · 조치 에이전트 <b>${yn(p.run_dispatcher)}</b> · 통합 에이전트 <b>${yn(p.run_supervisor)}</b></div>
      ${ov.length ? `<div class="dev-over"><b>코드가 덮어쓴 것</b><ul>${ov.map((o) => `<li>${esc(o)}</li>`).join("")}</ul></div>` : `<div class="dev-in">코드가 덮어쓴 것 없음</div>`}</div>`;
  }
  /** 분류 기억(D5-…): 비슷한 과거 사례 조회(lookup_similar)·과거 사례로 바로 분류(memory_hit) 로그의 결과를 풀어 쓴다. 못 읽으면 null(원문 그대로). */
  function memoryHtml(l: DevLog): string | null {
    if (l.agent !== "classifier" || !l.output_summary) return null;
    if (l.action === "lookup_similar") {
      const cases = [...l.output_summary.matchAll(/#(\d+) (운영자|모델) (\S+) \(([\d.]+)\)/g)];
      if (!cases.length) return null;
      return `<div class="dev-out">비슷한 과거 사례 <b>${cases.length}건</b> — ${cases.map((c) => `#${c[1]} ${esc(lab(c[3]))} (${c[2] === "운영자" ? "운영자 지정" : "모델 분류"} · 유사도 ${esc(c[4])})`).join(", ")}</div>`;
    }
    if (l.action === "memory_hit") {
      const m = /#(\d+) ← #(\d+) (\S+) \(([\d.]+)\)/.exec(l.output_summary);
      if (!m) return null;
      return `<div class="dev-out">민원 #${m[1]} ← 과거 사례 #${m[2]} (유형 <b>${esc(lab(m[3]))}</b> · 유사도 ${esc(m[4])}) — AI 호출을 생략하고 바로 분류</div>`;
    }
    return null;
  }
  function logRow(l: DevLog): string {
    const tok = l.tokens_in || l.tokens_out ? `${l.tokens_in ?? 0}→${l.tokens_out ?? 0} 토큰` : "";
    const took = l.latency_ms ? `${l.latency_ms} ms` : "";
    const what = ACTION_KO[l.action];
    return `<li class="dev-row"><div class="dev-line"><span class="dev-time">${esc(time(l.created_at))}</span>
      <span class="dev-ag ag-${esc(l.agent)}">${esc(AGENT_NAME[l.agent] ?? l.agent)}</span>
      <b class="dev-act">${esc(what ?? l.action)}</b><code class="dev-code">${esc(l.action)}</code>
      <span class="dev-meta">${esc([took, tok].filter(Boolean).join(" · "))}</span></div>
      ${l.input_summary ? `<div class="dev-in">입력 ${esc(l.input_summary)}</div>` : ""}
      ${planHtml(l) ?? memoryHtml(l) ?? (l.output_summary ? `<div class="dev-out">결과 ${esc(l.output_summary)}</div>` : "")}
      ${l.reasoning ? `<details class="dev-why"><summary>판단 이유(reasoning)</summary><pre>${esc(l.reasoning)}</pre></details>` : ""}</li>`;
  }
  function clsRow(c: DevClassification): string {
    const review = c.status === "review";
    const fromMemory = /^유사 사례 반영/.test(c.agent_note ?? "");          // 과거 사례(분류 기억)로 정해진 건
    return `<li class="dev-row${review ? " review" : ""}${fromMemory ? " memory" : ""}"><div class="dev-line"><span class="dev-time">#${c.feedback_id}</span>
      <b class="dev-act">${esc(lab(c.label))}</b><span class="dev-tag">${esc(c.status ?? "-")}</span>
      <span class="dev-tag">${c.is_safety ? "위험" : "비위험"}</span><span class="dev-meta">신뢰도 ${num(c.confidence, 2)}</span>${review ? `<span class="dev-tag strong">확인 필요</span>` : ""}${fromMemory ? `<span class="dev-tag strong">과거 사례로 분류</span>` : ""}</div>
      <div class="dev-in">${esc(c.raw_text)}</div>
      ${c.suggested_label ? `<div class="dev-out">모델 제안 ${esc(lab(c.suggested_label))}</div>` : ""}
      ${c.agent_note ? `<div class="dev-out">${esc(c.agent_note)}</div>` : ""}</li>`;
  }
  function render(): void {
    for (const b of panel.querySelectorAll<HTMLElement>("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    if (tab === "log") {
      body.innerHTML = `${flowHtml()}<div class="dev-tools"><button type="button" class="btn" id="dev-pause" aria-pressed="${paused}">${paused ? "다시 시작" : "일시정지"}</button>
        <span class="dev-meta">${logs.length}줄${paused && buffered ? ` · 멈춘 사이 새 줄 ${buffered}` : ""}</span></div>
        <ol class="dev-list" id="dev-log">${[...logs].reverse().map(logRow).join("") || `<li class="dev-empty">아직 기록이 없습니다</li>`}</ol>`;
    } else if (tab === "cls") {
      const rows = feed?.classifications ?? [];
      body.innerHTML = `<ol class="dev-list">${rows.map(clsRow).join("") || `<li class="dev-empty">최근 분류가 없습니다</li>`}</ol>`;
    } else if (tab === "sev") {
      const sev = feed?.severity ?? [], cards = feed?.cards ?? [];
      body.innerHTML = `<h3 class="dev-h">유형별 점수 <span class="dev-meta">${esc(time(sev[0]?.as_of))} 기준</span></h3>
        <ol class="dev-list">${sev.map((s) => `<li class="dev-row"><div class="dev-line"><b class="dev-act">${esc(lab(s.label))}</b><span class="dev-tag">${esc(GRADE[s.grade] ?? s.grade)}</span>
          <span class="dev-num">${num(s.score)}</span><span class="dev-meta">${s.freq}건 · 급증 ×${num(s.spike_w, 2)} · 안전 ×${num(s.safety_w, 2)} · 미조치 ×${num(s.pending_w, 2)}</span></div>
          <div class="dev-in">${esc(s.formula)}</div></li>`).join("") || `<li class="dev-empty">아직 판정이 없습니다</li>`}</ol>
        <h3 class="dev-h">카드 점수</h3>
        <ol class="dev-list">${cards.map((c) => `<li class="dev-row"><div class="dev-line"><b class="dev-act">${esc(c.zone_name ?? "구역 미상")} ${esc(lab(c.label))}</b><span class="dev-tag">${esc(GRADE[c.grade] ?? c.grade)}</span>
          <span class="dev-num">${num(c.card_score)}</span><span class="dev-meta">${c.freq}건 (유형 ${c.type_freq}건)</span></div><div class="dev-in">${esc(c.formula)}</div></li>`).join("") || `<li class="dev-empty">카드가 없습니다</li>`}</ol>`;
    } else {
      const st = feed?.status;
      body.innerHTML = st ? `<dl class="dev-dl"><dt>백엔드</dt><dd>${esc(st.backend_llm ?? "-")}</dd>
        <dt>오늘 토큰</dt><dd>입력 ${st.tokens_today.input.toLocaleString()} · 출력 ${st.tokens_today.output.toLocaleString()}</dd></dl>
        <h3 class="dev-h">루프별 마지막 실행</h3>
        <table class="dev-table"><thead><tr><th>루프</th><th>마지막</th><th>걸린 시간</th></tr></thead><tbody>${Object.entries(st.loops).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(time(v.last_at))}</td><td>${v.took_ms === null || v.took_ms === undefined ? "-" : `${v.took_ms} ms`}</td></tr>`).join("")}</tbody></table>`
        : `<p class="dev-empty">상태를 받는 중입니다</p>`;
    }
  }

  function apply(f: DevFeed): void {
    feed = f;
    sinceLog = Math.max(sinceLog, f.max_log_id ?? 0);
    sinceCls = Math.max(sinceCls, f.max_cls_id ?? 0);
    if (f.logs.length) {
      logs = [...logs, ...f.logs].slice(-MAX_LOGS);
      if (paused) buffered += f.logs.length;
    }
    live.textContent = `실시간 · ${time(f.now)}`;
    if (!(paused && tab === "log")) render();      // 일시정지 중에는 로그 화면을 그대로 둔다 (읽는 중에 밀리지 않게)
  }

  async function tick(): Promise<void> {
    if (!on || busy) return;
    busy = true;
    try { apply(await api.devFeed({ log: sinceLog, cls: sinceCls })); }
    catch (e) { live.textContent = e instanceof AdminDenied ? e.message : "연결 안 됨"; }      // 너무 잦으면 서버가 429(잠시 후 다시 보세요)를 준다
    finally { busy = false; }
  }

  async function turnOn(): Promise<void> {
    sinceLog = 0; sinceCls = 0; logs = []; buffered = 0; paused = false;
    setSwitch(true); live.textContent = "연결 중"; render();
    saveFlag(true);
    window.clearInterval(timer);
    await tick();
    timer = window.setInterval(() => void tick(), POLL_MS);
  }
  function turnOff(): void {
    window.clearInterval(timer); timer = undefined;            // 끄면 바로 멈춘다
    setSwitch(false); saveFlag(false);
  }

  toggle.addEventListener("click", () => { if (on) turnOff(); else void turnOn(); });
  panel.querySelector("#dev-close")!.addEventListener("click", turnOff);
  panel.querySelector(".dev-tabs")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (b) { tab = b.dataset.tab!; render(); }
  });
  body.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("#dev-pause")) { paused = !paused; if (!paused) buffered = 0; render(); }
  });

  if (flagOn()) void turnOn();            // 전에 켜 둔 상태면 그대로 켠다
}
