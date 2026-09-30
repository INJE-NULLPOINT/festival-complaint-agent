// 조치 — 심각도에 따라 조치요청서를 만들고, 처리 상태를 바꾼다.
import { api, type Action, type DocJob } from "../data";
import { LABELS, STATUS, STATUS_LABEL, badge, esc, hhmm, isClosed, makeFresh, pop, stateBox, toast, typeChip } from "../ui";

const opened = new Set<number>(); // 미리보기를 펼친 요청서 id
// 흑백에서도 상태가 모양으로 구분되게 (D5-23): 요청 ● · 조치중 ◐ · 완료 ✓ · 대체됨 –
const STATUS_MARK: Record<string, string> = { requested: "●", in_progress: "◐", done: "✓", superseded: "–" };
let showOld = false;               // 대체된 요청서 목록 펼침
// 다시 그려도 '새로 생긴 요청서' · '방금 상태가 바뀐 요청서' 만 움직이게 (D5-26)
const docFresh = makeFresh();
const prevStatus = new Map<number, string>();
const changed = new Map<number, number>(); // id → 바뀐 시각

type Doc = {
  festival: string; department: string; created_at: string; festival_info: string;
  label_ko: string; count: number; score: number; grade: string; grade_ko: string;
  formula: string; quotes: { raw_text: string; zone: string; time: string }[];
  suggestions: string[];
};

function preview(d: Doc): string {
  return `
    <article class="paper">
      <h3>축제 민원 조치요청서</h3>
      <p class="small"><b>${esc(d.festival)}</b><br>수신: ${esc(d.department)} · 작성: 실시간 민원 관제 AI Agent · ${esc(d.created_at)}
        ${d.festival_info ? `<br><i>${esc(d.festival_info)}</i>` : ""}</p>
      <h4>1. 요청 사유</h4>
      <table>
        <tr><th>민원 유형</th><td>${esc(d.label_ko)}</td></tr>
        <tr><th>접수 건수</th><td>${d.count}건</td></tr>
        <tr><th>심각도</th><td>${d.score}점 ${badge(d.grade)}</td></tr>
        <tr><th>판정 근거</th><td class="mono">${esc(d.formula || "-")}</td></tr>
      </table>
      <h4>2. 접수된 민원</h4>
      <ul>${d.quotes.map((q) => `<li>“${esc(q.raw_text)}” <span class="muted small">— ${esc(q.zone || "구역 미상")}${q.time ? `, ${esc(q.time)}` : ""}</span></li>`).join("")}</ul>
      <h4>3. 조치 제안</h4>
      <ol>${d.suggestions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    </article>`;
}

/** 요청서 1건. 대체됨은 상태를 바꿀 수 없다 (새 요청서가 그 자리를 이어받았다). */
function docItem(a: Action): string {
  const doc: Doc | null = a.doc_json ? JSON.parse(a.doc_json) : null;
  const locked = a.status === "superseded";
  const fr = docFresh.of(a.id);
  const ch = changed.get(a.id);
  const chMs = ch === undefined ? -1 : Date.now() - ch;
  if (ch !== undefined && chMs >= 700) changed.delete(a.id);
  const chOn = ch !== undefined && chMs < 700;
  return `<li class="${opened.has(a.id) ? "open" : ""}${fr.cls}${chOn ? " changed" : ""}" style="${fr.style || (chOn ? `animation-delay:-${chMs}ms` : "")}" data-id="${a.id}">
    <div class="docrow">
      <div class="who">
        <span class="name">${typeChip(a.label)}</span>
        <span class="st st-${esc(a.status)}">${STATUS_MARK[a.status] ?? "●"} ${esc(STATUS_LABEL[a.status] ?? a.status)}</span>
        <span class="muted">${esc(a.department)} · ${a.count}건 · ${hhmm(a.created_at)}</span>
      </div>
      <div class="acts${locked ? " noseg" : ""}">
        ${locked ? "" : `<div class="seg" role="group" aria-label="처리 상태">${Object.entries(STATUS).map(([k, v]) =>
          `<button data-status="${k}" class="${a.status === k ? "on" : ""}" aria-pressed="${a.status === k}">${v}</button>`).join("")}</div>`}
        ${doc ? `<button class="btn" data-toggle aria-expanded="${opened.has(a.id)}">미리보기</button>` : ""}
        ${a.doc_url ? `<a class="btn" href="${esc(a.doc_url)}" target="_blank" rel="noopener">DOCX</a>` : ""}
      </div>
    </div>
    ${doc ? `<div class="pv">${preview(doc)}</div>` : ""}
  </li>`;
}

export async function renderAction(root: HTMLElement): Promise<void> {
  const { sev, actions, jobs } = await api.action();
  const lastJob = new Map<string, DocJob>();
  for (const j of jobs) if (!lastJob.has(j.label)) lastJob.set(j.label, j);
  const openLabels = new Set(actions.filter((a) => !isClosed(a.status)).map((a) => a.label));
  const current = actions.filter((a) => a.status !== "superseded");
  const old = actions.filter((a) => a.status === "superseded");
  const targets = sev.filter((s) => s.label !== "positive");

  docFresh.update(actions.map((a) => a.id));
  // 상태가 바뀐 요청서 표시: 처음 그릴 때는 비교할 게 없으니 건너뛴다. 바뀐 시각을 적어 두어, 곧바로 다시 그려져도 애니메이션이 처음부터 다시 돌지 않게 한다
  const firstDraw = prevStatus.size === 0;
  if (!firstDraw) for (const a of actions) if (prevStatus.has(a.id) && prevStatus.get(a.id) !== a.status) {
    changed.set(a.id, Date.now());
  }
  actions.forEach((a) => prevStatus.set(a.id, a.status));

  root.innerHTML = `
    <h1 class="sr-only">조치 — 조치요청서 만들기와 처리 현황</h1>
    <section class="card">
      <h2 class="pg-title">조치 대상 <span class="muted small">심각도 순</span></h2>
      ${targets.length ? `<ul class="targets">${targets.map((s) => {
        const j = lastJob.get(s.label);
        const busy = j && (j.status === "queued" || j.status === "running");
        const state = busy ? `<span class="muted">${j!.status === "queued" ? "대기 중" : "작성 중"}…</span>`
          : j?.status === "failed" ? `<span class="err small" title="${esc(j.error)}">작성에 실패했습니다 · 다시 생성해 주세요</span>`
          : openLabels.has(s.label) ? `<span class="muted">요청서 있음(처리 전)</span>` : "";
        const hot = s.grade === "immediate" || s.grade === "high";
        const sent = openLabels.has(s.label);   // 미완료 요청서가 이미 있다 → 중복 생성 주의
        return `<li>
          <div class="t-main">
            <span class="name">${typeChip(s.label)}</span>
            ${badge(s.grade)} <span class="muted">${s.score.toFixed(1)}점 · ${s.freq}건</span>
            ${state ? `<div class="t-state">${state}</div>` : ""}
          </div>
          <button class="btn ${hot && !sent ? "primary" : ""}" data-gen="${esc(s.label)}" ${busy ? "disabled" : ""}>
            ${sent ? "다시 생성" : "조치요청서 생성"}</button>
        </li>`;
      }).join("")}</ul>` : stateBox({ icon: "inbox", title: "조치할 대상이 없습니다", hint: "판정된 민원이 생기면 심각도 순으로 나타납니다." })}
    </section>

    <section class="card">
      <h2>조치요청서 · 처리 현황</h2>
      ${current.length ? `<ul class="docs">${current.map(docItem).join("")}</ul>`
        : stateBox({ icon: "inbox", title: "아직 만든 조치요청서가 없습니다", hint: "위 조치 대상에서 [조치요청서 생성]을 누르면 여기에 나타납니다." })}
      ${old.length ? `
        <button type="button" class="linkbtn" id="toggle-old" aria-expanded="${showOld}">
          ${showOld ? "대체된 요청서 접기" : `대체된 요청서 ${old.length}건 보기`}</button>
        ${showOld ? `<ul class="docs old">${old.map(docItem).join("")}</ul>` : ""}` : ""}
    </section>`;

  root.querySelectorAll<HTMLButtonElement>("[data-gen]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api.requestDoc(btn.dataset.gen!);
      } catch (e) {
        toast((e as Error).message, "warn"); btn.disabled = false; return;
      }
      toast(`${LABELS[btn.dataset.gen!]} 조치요청서 작성을 요청했습니다`);
    }),
  );

  root.querySelector("#toggle-old")?.addEventListener("click", () => {
    showOld = !showOld;
    renderAction(root);
  });

  root.querySelectorAll<HTMLElement>(".docs li").forEach((li) => {
    const id = Number(li.dataset.id);
    li.querySelector("[data-toggle]")?.addEventListener("click", () => {
      opened.has(id) ? opened.delete(id) : opened.add(id);
      li.classList.toggle("open");
      if (opened.has(id)) pop(li);
    });
    li.querySelectorAll<HTMLButtonElement>("[data-status]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api.setActionStatus(id, b.dataset.status!);
        } catch (e) {
          toast((e as Error).message, "warn");
        }
      }),
    );
  });
}
