// 관제 — 운영요원이 띄워 두는 화면. 실시간 구독으로 다시 그려진다.
// 읽는 순서를 고정한다: ① 결론(브리핑) → ② 지금 조치할 일 카드(1위 크게·나머지 행) → ③ 알림 → ④ 유형별 순위(접힘)·유입.
// 3초 안에 "지금 제일 위험한 것 1개" 가 읽혀야 한다 (할일 D5-15). 카드는 '무엇이 · 어디서 · 무엇부터 · 무엇을 할지' 를 한 장에 담는다 (D5-29).
// 서버가 issues[] 를 아직 안 주면(구버전) 예전 유형 단위 화면(심각도 1위 카드 + 유형 순위)으로 그린다.
import { storedCode } from "../admin";
import { kpiRow } from "./kpi";
import { api, zones, type DeletedItem, type Issue, type IssueAction, type Quote, type ReviewItem, type Severity } from "../data";
import {
  LABELS, STATUS_LABEL, badge, delButton, esc, flipPlay, flipSnap, hhmm, jsonList, makeFresh, pop, reduced, skeletonBoard, stateBox, toast, toastAction,
  typeChip, typeIcon, uiIcon,
} from "../ui";

const open = new Set<string>();       // 펼친 유형 행 (다시 그려도 유지)
const openAlerts = new Set<number>(); // 펼친 알림
const openFeed = new Set<number>();   // 펼친 유입 원문
const openIssue = new Set<string>();  // 펼친 카드(행) — issue_key
const grpOpen = new Set<string>();    // 펼친 묶음(그 밖 · 조치 중 · 조치 완료 · 유형별 순위)

const name = (label: string) => LABELS[label] ?? label;

// 다시 그려도 '새로 들어온 것만' 움직이게 하는 상태 (D5-26)
const feedFresh = makeFresh();
const alertFresh = makeFresh();
const issueFresh = makeFresh();
// '즉시' 가 새로 된 카드만 테두리가 두 번 숨 쉰다 (D5-44). 이미 즉시인 카드가 다시 그려질 때는 다시 뛰지 않는다.
const lastGrade = new Map<string, string>();
const pulseAt = new Map<string, number>();
const PULSE_MS = 4800;          // 2.4s × 2번 — style.css 의 ic-breath 와 맞춘다
const prevText = new Map<string, string>();         // 카드별 text_updated_at — 문구가 실제로 바뀐 카드만 강조
const textChangedAt = new Map<string, number>();
let prevTop: string | null = null;                  // 지난번 심각도 1위 — 바뀌면 카드가 살짝 바뀐다 (옛 화면)

// 지운(숨긴) 민원 (D5-30). 누르면 서버 응답을 기다리지 않고 바로 숨기고, 서버가 빼 준 뒤에 이 목록에서도 정리한다.
const hidden = new Set<number>();
let lastRoot: HTMLElement | null = null;

// 확인 필요 처리 (D5-32): 패널이 열려 있는지, 처리(유형 지정·닫기)해서 바로 숨긴 항목
let rvOpen = false;
const hiddenReview = new Set<number>();
/** 확인 필요 처리에서 고를 수 있는 유형 (긍정 포함: 진짜 칭찬이면 긍정으로) */
const REVIEW_LABELS = ["safety", "crowd", "parking", "restroom", "price", "guide", "positive"];

// 지운 민원 목록 (D5-42): 패널이 열려 있는지, 마지막으로 가져온 목록, 그 목록을 가져올 때의 서버 '지운 개수'
let dlOpen = false;
let dlItems: DeletedItem[] | null = null;
let dlCount = -1;
let deletedNow = 0;          // 이번 화면의 서버 지운 개수 (목록이 낡았는지 비교하는 기준)
let dlRefreshing = false;

/** 결과가 큰 조치에 들어가는 말 — core/config.py ESCALATION_WORDS 와 같게 유지. 서버가 조치마다 표시를 주면 그것을 먼저 쓴다. */
const ESCALATION = /중단|폐쇄|대피|통제|출동|119|112|경찰|소방|구급/;

type Card = Omit<Issue, "actions" | "evidence_quotes" | "latest_quotes"> & {
  actions: (IssueAction & { needs_judgment?: number })[]; evidence: Quote[]; latest: Quote[];
};

function toCard(i: Issue): Card {
  return {
    ...i,
    actions: jsonList<IssueAction & { needs_judgment?: number }>(i.actions),
    evidence: jsonList<Quote>(i.evidence_quotes),
    latest: jsonList<Quote>(i.latest_quotes).filter((q) => !hidden.has(q.id)),
  };
}

export async function renderControl(root: HTMLElement): Promise<void> {
  lastRoot = root;
  // 처음 불러오거나 다른 화면에서 넘어올 때만, 조금 늦어지면 회색 뼈대를 보여 준다 (빠르면 깜빡이지 않게 150ms 뒤에)
  const skelTimer = root.querySelector(".kpis") ? undefined : window.setTimeout(() => { root.innerHTML = skeletonBoard(); }, 150);
  const [d, zs] = await Promise.all([api.control(), zones()]).then(
    (r) => { clearTimeout(skelTimer); return r; },
    (e) => { clearTimeout(skelTimer); throw e; });
  const { sev, alerts } = d;
  const zoneName = new Map(zs.map((z) => [z.id, z.name]));

  // 서버가 이미 뺀 민원은 '숨김 대기' 목록에서 정리한다 (다른 곳에서 되돌려도 다시 보이게)
  const present = new Set<number>(d.feed.map((f) => f.id));
  for (const i of d.issues ?? []) for (const q of jsonList<Quote>(i.latest_quotes)) present.add(q.id);
  for (const r of d.review_items ?? []) present.add(r.id);
  hidden.forEach((id) => { if (!present.has(id)) hidden.delete(id); });
  // 서버가 이미 처리한 확인 필요 항목은 '숨김 대기'에서 정리한다 (되돌려서 다시 확인 필요가 되면 다시 보이게)
  const reviewIds = new Set((d.review_items ?? []).map((r) => r.id));
  hiddenReview.forEach((id) => { if (!reviewIds.has(id)) hiddenReview.delete(id); });

  deletedNow = d.deleted ?? 0;
  const feed = d.feed.filter((f) => !hidden.has(f.id));
  const rvItems = (d.review_items ?? []).filter((r) => !hidden.has(r.id) && !hiddenReview.has(r.id));
  const cards = (d.issues ?? []).map(toCard);
  const hasIssues = cards.length > 0;
  const main = cards.filter((c) => c.grp === "main");
  const more = cards.filter((c) => c.grp === "more");
  const prog = cards.filter((c) => c.grp === "in_progress");
  const done = cards.filter((c) => c.grp === "done");
  const lead = main[0];

  const b = d.briefing;
  const top = sev[0];
  const rest = sev.slice(1);
  const gradeOf = new Map(sev.map((s) => [s.label, s.grade]));

  // 같은 구간의 건수 순위. 심각도(카드) 순위와 비교해 "건수가 아니라 심각도" 를 보여준다.
  const byCount = [...sev].sort((x, y) => y.freq - x.freq || y.score - x.score);
  const countRank = new Map(byCount.map((s, i) => [s.label, i + 1]));
  // 카드 화면: 1위 카드의 유형 건수와 건수 1위 유형을 비교. 옛 화면: 심각도 1위 유형과 비교.
  const mine = hasIssues ? (lead ? { label: lead.label, freq: lead.type_freq } : null) : (top ? { label: top.label, freq: top.freq } : null);
  const flipped = !!mine && !!byCount[0] && byCount[0].label !== mine.label && byCount[0].freq > mine.freq;

  feedFresh.update(feed.map((f) => f.id));
  alertFresh.update(alerts.map((a) => a.id));
  issueFresh.update(cards.map((c) => c.id));
  const heroSwap = !hasIssues && !!top && prevTop !== null && prevTop !== top.label;
  // 카드 문구(text_updated_at)가 바뀐 카드만 강조한다. 건수·마지막 시각·최신 민원이 바뀐 것은 조용히 갱신.
  const now = Date.now();
  for (const c of cards) {
    const pg = lastGrade.get(c.issue_key);
    if (c.grade === "immediate" && ((pg !== undefined && pg !== "immediate") || (pg === undefined && issueFresh.of(c.id).cls))) pulseAt.set(c.issue_key, now);
    lastGrade.set(c.issue_key, c.grade);
    const before = prevText.get(c.issue_key);
    if (before !== undefined && before !== c.text_updated_at) textChangedAt.set(c.issue_key, now);
    prevText.set(c.issue_key, c.text_updated_at);
  }
  // 다시 그리기 전 위치를 적어 두었다가, 순위·유입이 옮겨진 만큼만 미끄러지게 한다
  const snapRank = flipSnap(root, ".rank li", "label");
  const snapFeed = flipSnap(root, ".feed li[data-id]", "id");
  const snapCards = flipSnap(root, ".icard[data-key]", "key");

  const rankList = (list: Severity[], startNo: number) => list.length ? `<ol class="rank" start="${startNo}">${list.map((s, i) => {
    const cr = countRank.get(s.label) ?? 0;
    const up = cr > i + startNo;   // 건수로는 더 아래인데 심각도로 올라온 유형
    return `
          <li class="${open.has(s.label) ? "open" : ""}" data-label="${esc(s.label)}">
            <button class="row" type="button">
              <span class="no">${i + startNo}</span>
              <span class="name">${typeChip(s.label)}</span>
              ${badge(s.grade)}
              <span class="sub">
                <span class="${up ? "up" : ""}">${s.freq}건 · 건수 ${cr}위${up ? " ▲" : ""}</span>
              </span>
            </button>
          </li>`;
  }).join("")}</ol>` : stateBox({ inline: true, icon: "inbox", title: "다른 유형 없음" });

  root.innerHTML = `
    <h1 class="sr-only">관제 — 지금 조치할 일</h1>
    ${kpiRow(d)}
    <section class="card brief" aria-label="지금 조치할 일">
      <h2 class="pg-title">지금 조치할 일${b ? ` <span class="muted small">${hhmm(b.created_at)}</span>` : ""}</h2>
      ${b ? `<p class="brief-text">${leadSentence(b.text)}</p>${b.rationale ? `<p class="brief-why">근거: ${esc(b.rationale.replace(/^\s*근거\s*[:：]\s*/, ""))}</p>` : ""}`
          : `<p class="muted">브리핑 없음</p>`}
      ${hasIssues && flipped && mine && lead ? `<p class="flip">건수 1위 <b>${esc(name(byCount[0].label))} ${byCount[0].freq}건</b>보다
        <b>${esc(lead.zone_name ?? "구역 미상")} ${esc(name(mine.label))} ${mine.freq}건</b>이 먼저입니다</p>` : ""}
    </section>

    ${hasIssues ? `
    ${main.length ? `<section class="icards" aria-label="조치할 일 카드">${main.map((c, i) => issueCard(c, i + 1, i === 0, zoneName)).join("")}</section>`
      : `<section class="card">${stateBox({ icon: "check", title: "지금 바로 조치할 일 없음" })}</section>`}
    ${group("more", "그 밖", more, main.length + 1, zoneName)}
    ${group("in_progress", "조치 중", prog, 1, zoneName)}
    ${group("done", "조치 완료", done, 1, zoneName)}`
    : (top ? hero(top, countRank.get(top.label) ?? 0, flipped && byCount[0] ? byCount[0] : null, heroSwap) : `
    <section class="card">${stateBox({ icon: "inbox", title: "접수된 민원 없음" })}</section>`)}

    ${alerts.length ? `<ul class="alerts" aria-label="미확인 알림">${alerts.map((a) => { const fr = alertFresh.of(a.id); return `
      <li class="alert ${openAlerts.has(a.id) ? "open" : ""}${fr.cls}" style="${fr.style}" data-id="${a.id}">
        <button type="button" class="alert-row" aria-expanded="${openAlerts.has(a.id)}">
          ${a.kind !== "review_safety_stale" && gradeOf.has(a.label) ? badge(gradeOf.get(a.label)!) : ""}
          <b>${a.kind === "review_safety_stale" ? `<span class="flag judge">확인 필요</span>` : typeChip(a.label, true)}</b>
          <span class="alert-text">${esc(stripLabel(a.detail))}</span>
          <span class="alert-time">${hhmm(a.created_at)}</span>
        </button>
      </li>`; }).join("")}</ul>` : ""}

    <div class="grid2">
      ${hasIssues ? `
      <details class="card typerank" data-grp="rank" ${grpOpen.has("rank") ? "open" : ""}>
        <summary><span class="typerank-t">유형별 순위</span> <span class="muted small">카드 순서의 근거${top ? ` · ${hhmm(top.as_of)} 기준` : ""}</span></summary>
        ${sev.length ? rankList(sev, 1) : stateBox({ inline: true, icon: "inbox", title: "유형별 순위 없음" })}
      </details>` : `
      <section class="card">
        <h2>그다음 순위 <span class="muted small">${top ? `${hhmm(top.as_of)} 기준` : ""}</span></h2>
        ${rankList(rest, 2)}
      </section>`}

      <section class="card">
        <h2>실시간 유입 <span class="muted counts">누적 <b>${d.total}</b> · 분류 대기 <b>${d.pending}</b>${reviewCounts(d.review ?? 0, d.review_safety ?? 0, d.review_items !== undefined && (d.review ?? 0) > 0)}${deletedChip(d.deleted ?? 0)}</span></h2>
        ${d.review_items !== undefined && ((d.review ?? 0) > 0 || rvItems.length) ? rvPanel(rvItems, d.review ?? 0, zoneName) : ""}
        ${(d.deleted ?? 0) > 0 || dlOpen ? dlPanel() : ""}
        <ul class="feed">${feed.map((f) => {
          const done = f.status === "done" && f.label;
          const review = f.status === "review";   // 근거 없거나 신뢰도가 낮아 유형을 못 정한 민원 — 운영자가 봐야 한다
          const fr = feedFresh.of(f.id);
          return `<li class="${openFeed.has(f.id) ? "open" : ""}${fr.cls}" style="${fr.style}" data-id="${f.id}" data-fid="${f.id}">
            <button type="button" class="feed-item" title="${esc(f.raw_text)}">
              <span class="feed-text" id="ft-${f.id}">${esc(f.raw_text)}</span>
              <span class="meta">
                <span class="tag ${done ? "" : review ? "review" : f.status === "dismissed" ? "none" : "wait"}">${done ? typeChip(f.label!, true) : review ? "확인 필요" : f.status === "dismissed" ? "유형 없음" : "분류 중"}</span>
                ${f.receipt_no ? `<span class="rcpt" title="방문객 접수번호">W-${f.receipt_no}</span>` : ""}
                <span>${esc(f.zone_id == null ? "구역 미상" : (zoneName.get(f.zone_id) ?? "구역 미상"))}</span>
                <span>${hhmm(f.ingested_at)}</span>
              </span>
            </button>
            ${delButton(f.id, `ft-${f.id}`)}</li>`;
        }).join("") || `<li class="state-li">${stateBox({ inline: true, icon: "inbox", title: "접수된 민원 없음" })}</li>`}</ul>
      </section>
    </div>`;

  const toggle = (set: Set<string | number>, key: string | number, li: HTMLElement) => {
    set.has(key) ? set.delete(key) : set.add(key);
    li.classList.toggle("open");
    li.querySelector("[aria-expanded]")?.setAttribute("aria-expanded", String(set.has(key)));
    if (set.has(key)) pop(li);
  };
  root.querySelectorAll<HTMLElement>(".rank li").forEach((li) =>
    li.querySelector(".row")!.addEventListener("click", () => toggle(open as Set<string | number>, li.dataset.label!, li)));
  root.querySelectorAll<HTMLElement>(".alerts li").forEach((li) =>
    li.querySelector(".alert-row")!.addEventListener("click", () => toggle(openAlerts as Set<string | number>, Number(li.dataset.id), li)));
  root.querySelectorAll<HTMLElement>(".feed li[data-id]").forEach((li) =>
    li.querySelector(".feed-item")!.addEventListener("click", () => toggle(openFeed as Set<string | number>, Number(li.dataset.id), li)));

  // ── 카드 (D5-29)
  root.querySelectorAll<HTMLElement>(".icard:not(.big)").forEach((el) => {
    el.querySelector<HTMLElement>(".ic-head")?.addEventListener("click", () => {
      const k = el.dataset.key!;
      openIssue.has(k) ? openIssue.delete(k) : openIssue.add(k);
      el.classList.toggle("open");
      el.querySelector(".ic-head")!.setAttribute("aria-expanded", String(openIssue.has(k)));
      if (openIssue.has(k)) pop(el);
    });
  });
  root.querySelectorAll<HTMLDetailsElement>("details[data-grp]").forEach((det) =>
    det.addEventListener("toggle", () => { det.open ? grpOpen.add(det.dataset.grp!) : grpOpen.delete(det.dataset.grp!); }));
  root.querySelectorAll<HTMLButtonElement>("[data-gen]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api.requestDoc(btn.dataset.gen!);
      } catch (e) {
        toast((e as Error).message, "warn"); btn.disabled = false; return;
      }
      toast(`${name(btn.dataset.gen!)} 조치요청서 작성을 요청했습니다`);
    }));

  // ── 민원 지우기 (D5-30): 유입 행 · 카드의 최신 민원. 누르면 바로 숨기고 5초 동안 되돌릴 수 있다.
  root.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) =>
    btn.addEventListener("click", (e) => { e.stopPropagation(); void removeFeedback(Number(btn.dataset.del)); }));

  // ── 확인 필요 처리 패널 (D5-32)
  const rvBtn = root.querySelector<HTMLButtonElement>("[data-rv-toggle]");
  const rvBox = root.querySelector<HTMLElement>("#rvp");
  rvBtn?.addEventListener("click", () => {
    rvOpen = !rvOpen;
    if (rvBox) { rvBox.hidden = !rvOpen; if (rvOpen) pop(rvBox); }
    rvBtn.setAttribute("aria-expanded", String(rvOpen));
    rvBtn.classList.toggle("open", rvOpen);
  });
  root.querySelector<HTMLButtonElement>("[data-rv-close]")?.addEventListener("click", () => {
    rvOpen = false;
    if (rvBox) rvBox.hidden = true;
    rvBtn?.setAttribute("aria-expanded", "false");
    rvBtn?.classList.remove("open");
    rvBtn?.focus();
  });
  root.querySelectorAll<HTMLSelectElement>(".rvi-pick select").forEach((sel) =>
    sel.addEventListener("change", () => {
      const label = sel.value;
      sel.value = "";   // 다시 처음 상태로 (같은 유형을 또 고를 수 있게)
      if (label) void processReview(Number(sel.dataset.rid), "resolve", label);
    }));
  root.querySelectorAll<HTMLButtonElement>("[data-dismiss]").forEach((btn) =>
    btn.addEventListener("click", () => void processReview(Number(btn.dataset.dismiss), "dismiss")));

  // ── 지운 민원 목록 (D5-42)
  root.querySelector<HTMLButtonElement>("[data-dl-toggle]")?.addEventListener("click", () => void toggleDeleted(root));
  wireDeletedPanel(root);
  // 열려 있는 동안 서버의 지운 개수가 바뀌면(내가 또 지웠거나 다른 운영자가 처리) 목록도 새로 가져온다
  if (dlOpen && dlItems && deletedNow !== dlCount && !dlRefreshing) void refreshDeleted(root);

  // 순위·유입이 옮겨진 만큼만 미끄러진다
  flipPlay(root, ".rank li", "label", snapRank);
  flipPlay(root, ".feed li[data-id]", "id", snapFeed);
  flipPlay(root, ".icard[data-key]", "key", snapCards);
  prevTop = top ? top.label : null;
}

/** 민원 1건을 바로 숨기고(모든 곳에서) 서버에 알린다. 실패하면 되살린다. 성공하면 5초 동안 [되돌리기]가 뜬다. */
async function removeFeedback(id: number): Promise<void> {
  const hide = () => {
    hidden.add(id);
    document.querySelectorAll<HTMLElement>(`[data-fid="${id}"]`).forEach((el) => {
      if (reduced()) { el.classList.add("gone"); return; }
      el.classList.add("leaving");
      setTimeout(() => el.classList.add("gone"), 200);
    });
  };
  // 운영자 코드를 이미 입력했으면 바로 숨긴다. 아직이면 코드 입력 창이 뜨므로, 입력을 마친 뒤에 숨긴다(창이 떠 있는 동안 항목이 사라졌다 나타나지 않게).
  const early = !!storedCode();
  if (early) hide();
  try {
    await api.deleteFeedback(id);
  } catch (e) {
    if (early) {
      hidden.delete(id);
      if (lastRoot) void renderControl(lastRoot);   // 숨겼던 것을 되살린다
    }
    toast((e as Error).message, "warn");
    return;
  }
  if (!early) hide();
  toastAction("지웠습니다", "되돌리기", async () => {
    try {
      await api.restoreFeedback(id);
    } catch (e) {
      toast((e as Error).message, "warn");
      return;
    }
    hidden.delete(id);
    feedFresh.forget(id);
    if (lastRoot) void renderControl(lastRoot);   // 서버 알림(SSE)을 기다리지 않고 바로 돌려놓는다
  });
}

/** 확인 필요 항목 하나를 처리한다: 유형 지정(resolve) 또는 유형 없음으로 닫기(dismiss). 처리되면 목록에서 빠지고 5초 동안 [되돌리기](reopen).
 *  운영자 코드를 이미 입력했으면 바로 숨기고, 아직이면 코드 입력 창이 뜬 뒤(입력을 마치면) 숨긴다 — 지우기와 같다. */
async function processReview(id: number, kind: "resolve" | "dismiss", label?: string): Promise<void> {
  const hide = () => {
    hiddenReview.add(id);
    document.querySelectorAll<HTMLElement>(`.rvi[data-rid="${id}"]`).forEach((el) => {
      if (reduced()) { el.classList.add("gone"); return; }
      el.classList.add("leaving");
      setTimeout(() => el.classList.add("gone"), 200);
    });
  };
  const early = !!storedCode();
  if (early) hide();
  try {
    if (kind === "resolve") await api.resolveReview(id, label!);
    else await api.dismissReview(id);
  } catch (e) {
    if (early) {
      hiddenReview.delete(id);
      if (lastRoot) void renderControl(lastRoot);   // 숨겼던 것을 되살린다
    }
    toast((e as Error).message, "warn");
    return;
  }
  if (!early) hide();
  toastAction(kind === "resolve" ? `유형 지정 (${name(label!)})` : "유형 없음으로 닫았습니다", "되돌리기", async () => {
    try {
      await api.reopenReview(id);
    } catch (e) {
      toast((e as Error).message, "warn");
      return;
    }
    hiddenReview.delete(id);
    if (lastRoot) void renderControl(lastRoot);   // 다시 확인 필요 목록으로 돌아온다
  });
}

/** 확인 필요 처리 패널: 안전 의심이 먼저(서버가 그 순서로 준다). 행마다 원문 · 구역 · 시각 · 모델 제안 + 버튼 3개. */
function rvPanel(items: ReviewItem[], total: number, zoneName: Map<number, string>): string {
  const rest = total - items.length - hiddenReview.size;
  return `
        <section class="rvp" id="rvp" aria-label="확인 필요 처리" ${rvOpen ? "" : "hidden"}>
          <div class="rvp-head">
            <p class="rvp-t"><b>확인 필요 ${items.length}건</b> <span class="muted small">안전 의심이 먼저 · 유형을 정하거나, 유형 없음으로 닫거나, 지워 주세요</span></p>
            <button type="button" class="linkbtn" data-rv-close>접기</button>
          </div>
          ${items.length ? `<ul class="rvlist">${items.map((it) => {
            const zone = it.zone ?? (it.zone_id != null ? zoneName.get(it.zone_id) : null) ?? "구역 미상";
            return `
            <li class="rvi${it.is_safety ? " safe" : ""}" data-rid="${it.id}" data-fid="${it.id}">
              <div class="rvi-meta">
                ${it.is_safety ? `<span class="flag judge">안전 의심</span>` : ""}
                <span class="ty">${uiIcon("pin")}<span>${esc(zone)}</span></span>
                <span>${hhmm(it.ingested_at)}</span>
              </div>
              <p class="rvi-text">${esc(it.raw_text)}</p>
              <p class="rvi-sug muted">${it.suggested_label ? `모델 제안 ${typeChip(it.suggested_label, true)}` : "모델 제안 없음"}${it.confidence != null ? ` · 신뢰도 ${Math.round(it.confidence * 100)}%` : ""}</p>
              <div class="rvi-acts">
                <label class="btn rvi-pick">유형 지정 ▾
                  <select data-rid="${it.id}" aria-label="유형 지정 (민원 ${it.id})">
                    <option value="">유형 고르기</option>
                    ${REVIEW_LABELS.map((l) => `<option value="${l}">${esc(name(l))}${l === it.suggested_label ? " · 모델 제안" : ""}</option>`).join("")}
                  </select>
                </label>
                <button type="button" class="btn" data-dismiss="${it.id}">유형 없음으로 닫기</button>
                <button type="button" class="btn" data-del="${it.id}" aria-label="민원 지우기">지우기</button>
              </div>
            </li>`;
          }).join("")}</ul>` : `<div class="rvp-empty">${stateBox({ inline: true, icon: "check", title: "확인 필요 민원 없음" })}</div>`}
          ${rest > 0 ? `<p class="muted small rvp-more">그 밖 ${rest}건은 위 항목을 처리하면 이어서 나옵니다.</p>` : ""}
        </section>`;
}

/** 유입 제목 옆 '지운 민원 N' — 누르면 지운 민원 목록이 열린다 (D5-42). 목록이 열려 있으면 0건이 되어도 버튼을 남겨 닫을 수 있게 한다. */
function deletedChip(n: number): string {
  if (n <= 0 && !dlOpen) return "";
  return ` · <button type="button" class="dl-btn${dlOpen ? " open" : ""}" data-dl-toggle aria-expanded="${dlOpen}" aria-controls="dlp">지운 민원 <b>${n}</b></button>`;
}

/** 지운 시각 표시: 오늘이면 시:분, 아니면 월-일 시:분 */
function whenText(iso: string): string {
  const t = String(iso ?? "").replace("T", " ");
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return t.startsWith(today) ? t.slice(11, 16) : `${t.slice(5, 10)} ${t.slice(11, 16)}`;
}

/** 지운 민원 패널: 최근 지운 것부터, 행마다 원문(마스킹됨) · 구역 · 지운 시각 · 원래 유형 + [되돌리기]. 운영자 코드가 필요한 목록이라 열 때 코드 창이 뜰 수 있다. */
function dlPanel(): string {
  const items = dlItems;
  return `
        <section class="rvp dlp" id="dlp" aria-label="지운 민원" ${dlOpen ? "" : "hidden"}>
          <div class="rvp-head">
            <p class="rvp-t"><b>지운 민원${items ? ` ${items.length}건` : ""}</b> <span class="muted small">최근 지운 것부터 · 되돌리면 유입과 집계에 다시 들어갑니다</span></p>
            <button type="button" class="linkbtn" data-dl-close>접기</button>
          </div>
          ${items === null ? `<p class="muted rvp-empty" role="status">불러오는 중…</p>`
            : items.length ? `<ul class="rvlist">${items.map((it) => `
            <li class="rvi dli" data-did="${it.id}">
              <div class="rvi-meta">
                <span class="ty">${uiIcon("pin")}<span>${esc(it.zone || "구역 미상")}</span></span>
                <span>지운 시각 ${esc(whenText(it.deleted_at))}</span>
                ${it.label ? typeChip(it.label, true) : it.status === "review" ? `<span class="tag review">확인 필요</span>` : it.status === "dismissed" ? `<span class="tag none">유형 없음</span>` : ""}
              </div>
              <p class="rvi-text" id="dt-${it.id}">${esc(it.raw_text)}</p>
              <div class="rvi-acts"><button type="button" class="btn" data-restore="${it.id}" aria-describedby="dt-${it.id}">되돌리기</button></div>
            </li>`).join("")}</ul>`
            : `<div class="rvp-empty">${stateBox({ inline: true, icon: "check", title: "지운 민원 없음" })}</div>`}
        </section>`;
}

/** 패널의 열림 상태만 화면에 맞춘다 (다시 그리지 않는다). */
function syncDeleted(root: HTMLElement): void {
  const box = root.querySelector<HTMLElement>("#dlp");
  const btn = root.querySelector<HTMLElement>("[data-dl-toggle]");
  if (box) box.hidden = !dlOpen;
  btn?.setAttribute("aria-expanded", String(dlOpen));
  btn?.classList.toggle("open", dlOpen);
}

/** 패널 안의 버튼(접기 · 되돌리기) 연결. 패널만 다시 그린 뒤에도 부른다. */
function wireDeletedPanel(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>("[data-dl-close]")?.addEventListener("click", () => {
    dlOpen = false;
    syncDeleted(root);
    root.querySelector<HTMLElement>("[data-dl-toggle]")?.focus();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-restore]").forEach((b) =>
    b.addEventListener("click", () => void restoreOne(root, Number(b.dataset.restore))));
}

/** 패널만 다시 그린다 (유입·카드는 그대로). */
function paintDeleted(root: HTMLElement): void {
  const box = root.querySelector<HTMLElement>("#dlp");
  if (!box) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = dlPanel();
  box.replaceWith(tmp.firstElementChild!);
  wireDeletedPanel(root);
}

async function toggleDeleted(root: HTMLElement): Promise<void> {
  if (dlOpen) { dlOpen = false; syncDeleted(root); return; }
  // 열기: 목록을 가져온다. 운영자 코드가 없으면 코드 창이 뜨고, 취소하거나 실패하면 열지 않는다.
  try {
    dlItems = await api.listDeleted();
  } catch (e) {
    toast((e as Error).message, "warn");
    return;
  }
  dlCount = deletedNow;
  dlOpen = true;
  paintDeleted(root);
  syncDeleted(root);
  const box = root.querySelector<HTMLElement>("#dlp");
  if (box) pop(box);
}

async function refreshDeleted(root: HTMLElement): Promise<void> {
  if (!storedCode()) return;            // 코드를 아직 안 넣었으면 묻지 않는다 (열 때 이미 입력했을 것)
  dlRefreshing = true;
  try {
    dlItems = await api.listDeleted();
    dlCount = deletedNow;
    paintDeleted(root);
    syncDeleted(root);
  } catch { /* 다음 갱신 때 다시 시도 */ } finally { dlRefreshing = false; }
}

/** 지운 민원 하나를 되돌린다 — 유입·집계·카드에 다시 들어간다. */
async function restoreOne(root: HTMLElement, id: number): Promise<void> {
  try {
    await api.restoreFeedback(id);
  } catch (e) {
    toast((e as Error).message, "warn");
    return;
  }
  hidden.delete(id);
  feedFresh.forget(id);
  dlItems = (dlItems ?? []).filter((i) => i.id !== id);
  paintDeleted(root);
  syncDeleted(root);
  toast("민원을 되돌렸습니다");
  if (lastRoot) void renderControl(lastRoot);
}

/** 접이식 묶음(그 밖 · 조치 중 · 조치 완료). 비어 있으면 그리지 않는다. */
function group(key: string, title: string, list: Card[], startNo: number, zoneName: Map<number, string>): string {
  if (!list.length) return "";
  return `
    <details class="card igrp" data-grp="${key}" ${grpOpen.has(key) ? "open" : ""}>
      <summary><span class="igrp-t">${title}</span> <b class="igrp-n">${list.length}</b><span class="muted small">건</span></summary>
      <div class="icards rows">${list.map((c, i) => issueCard(c, startNo + i, false, zoneName)).join("")}</div>
    </details>`;
}

/** 조치할 일 카드 한 장. big 이면 1위(항상 펼침·크게), 아니면 행(누르면 펼침). */
function issueCard(c: Card, no: number, big: boolean, zoneName: Map<number, string>): string {
  const fr = issueFresh.of(c.id);
  const opened = big || openIssue.has(c.issue_key);
  const ch = textChangedAt.get(c.issue_key);
  const chMs = ch === undefined ? -1 : Date.now() - ch;
  const chOn = ch !== undefined && chMs >= 0 && chMs < 900;
  if (ch !== undefined && !chOn) textChangedAt.delete(c.issue_key);
  const pa = pulseAt.get(c.issue_key);
  const paMs = pa === undefined ? -1 : Date.now() - pa;
  const pOn = c.grade === "immediate" && pa !== undefined && paMs >= 0 && paMs < PULSE_MS;
  if (pa !== undefined && !pOn) pulseAt.delete(c.issue_key);
  const zone = c.zone_name ?? (c.zone_id != null ? zoneName.get(c.zone_id) : null) ?? "구역 미상";
  const st = c.action_status;
  const stText = st ? (STATUS_LABEL[st] ?? st) : "요청서 없음";
  // 결과가 큰 조치(대피·중단·통제 등)는 일반 조치와 섞지 않고 별도 칸에 둔다. 서버가 조치마다 표시를 주면 그것을, 아니면 카드 표시 + 말로 가린다.
  const isRisky = (a: { text: string; needs_judgment?: number }) => !!a.needs_judgment || (!!c.needs_judgment && ESCALATION.test(a.text));
  const normal = c.actions.filter((a) => !isRisky(a));
  const risky = c.actions.filter(isRisky);
  const flags = [
    c.needs_judgment ? `<span class="flag judge" title="대피·중단·통제처럼 결과가 큰 조치가 들어 있어 사람이 판단해야 합니다">운영자 판단 필요</span>` : "",
    c.recurred ? `<span class="flag">완료 후 재발</span>` : "",
    c.new_since_request ? `<span class="flag" title="조치요청서를 만든 뒤 새 구역에서도 같은 문제가 들어왔습니다">요청서 이후 새 구역</span>` : "",
    c.same_zone_others ? `<span class="flag soft">같은 구역 다른 문제 ${c.same_zone_others}</span>` : "",
  ].join("");
  const actLi = (a: IssueAction) => `
          <li><span class="ic-act">${esc(a.text)}</span>${a.quote_id != null ? `<span class="ic-ref" title="이 조치의 근거가 된 민원">근거 #${a.quote_id}</span>` : ""}</li>`;
  // 인용은 원문 그대로 보여 주되(글자를 바꾸지 않는다) 줄바꿈 없이 한 줄로 잘라 보인다. 전체는 title 로.
  const cardId = c.id;
  const quoteLi = (q: Quote, del: boolean) => `<li${del ? ` data-fid="${q.id}"` : ""}><span class="qt"${del ? ` id="cq-${cardId}-${q.id}"` : ""} title="${esc(q.text)}">“${esc(q.text)}”</span><span class="muted small qm">${del ? "" : `#${q.id} · `}${hhmm(q.posted_at)}</span>${del ? delButton(q.id, `cq-${cardId}-${q.id}`) : ""}</li>`;
  const meta = `
        <span class="ic-meta">
          <span class="ty ic-zone">${uiIcon("pin")}<span>${esc(zone)}</span></span>
          ${typeChip(c.label)}
          ${badge(c.grade)}
          <span class="ic-stat">${c.freq}건 · 마지막 ${hhmm(c.last_at)}</span>
          ${flags}
        </span>`;
  const body = `
      <div class="ic-body">
        <h3 class="ic-h">해야 할 일</h3>
        <ol class="ic-acts">${normal.map(actLi).join("") || `<li class="muted">${risky.length ? "일반 조치는 없고, 아래 판단이 필요한 조치만 있습니다." : "해야 할 일을 정리하는 중입니다. 잠시 후 표시됩니다."}</li>`}</ol>
        ${risky.length ? `
        <div class="ic-risk" role="group" aria-label="운영자 판단 필요">
          <p class="ic-risk-t"><span aria-hidden="true">⚠</span> 운영자 판단 필요 — 실행 전 현장 확인</p>
          <ol class="ic-acts">${risky.map(actLi).join("")}</ol>
        </div>` : ""}
        <p class="ic-who">담당 <b>${esc(c.department ?? "-")}</b>${c.contact ? ` · <a href="tel:${esc(c.contact.replace(/[^0-9+]/g, ""))}">${esc(c.contact)}</a>` : ""}</p>
        <div class="ic-quotes">
          <section class="ic-q" aria-label="판단 근거">
            <h4 class="ic-h2">판단 근거</h4>
            <ul>${c.evidence.map((q) => quoteLi(q, false)).join("") || `<li class="muted">아직 없음</li>`}</ul>
          </section>
          <section class="ic-q" aria-label="최신 민원">
            <h4 class="ic-h2">최신 민원 <span class="muted small">실시간</span></h4>
            <ul>${c.latest.map((q) => quoteLi(q, true)).join("") || `<li class="muted">아직 없음</li>`}</ul>
          </section>
        </div>
        <div class="ic-actions">
          <button class="btn ${!st && (c.grade === "immediate" || c.grade === "high") ? "primary" : ""}" data-gen="${esc(c.label)}">${esc(name(c.label))} 전체 요청서 ${st && st !== "done" ? "다시 생성" : "생성"}</button>
          <span class="st st-${esc(st ?? "none")}">${esc(stText)}</span>
          <a class="linkbtn" href="#action">조치 화면에서 상태 바꾸기</a>
        </div>
        ${c.text_source === "llm" ? `<p class="ic-src muted small">AI 정리${c.text_updated_at ? ` · ${hhmm(c.text_updated_at)}` : ""}</p>` : ""}
      </div>`;
  const cls = `icard g-${esc(c.grade)}${big ? " big" : ""}${opened && !big ? " open" : ""}${fr.cls}${chOn ? " retext" : ""}${pOn ? " pulse" : ""}`;
  const style = (fr.style || (chOn ? `animation-delay:-${chMs}ms` : "")) + (pOn ? `;--pd:-${paMs}ms` : "");
  return big ? `
    <article class="${cls}" data-key="${esc(c.issue_key)}" style="${style}">
      <div class="ic-head">
        <span class="ic-no" aria-hidden="true">${no}</span>
        <span class="ic-main">
          <span class="ic-kicker">지금 가장 먼저 · ${hhmm(c.updated_at)} 기준</span>
          <h3 class="ic-title">${esc(c.title)}</h3>
          ${meta}
        </span>
      </div>${body}
    </article>` : `
    <article class="${cls}" data-key="${esc(c.issue_key)}" style="${style}">
      <button type="button" class="ic-head" aria-expanded="${opened}">
        <span class="ic-no" aria-hidden="true">${no}</span>
        <span class="ic-main">
          <span class="ic-title">${esc(c.title)}</span>
          ${meta}
        </span>
      </button>${body}
    </article>`;
}

/** (구버전 서버용) 심각도 1위 — 화면에서 가장 크게. */
function hero(s: Severity, countRank: number, countTop: Severity | null, swap: boolean): string {
  return `
    <section class="card hero g-${esc(s.grade)}${swap ? " swap" : ""}" aria-label="심각도 1위">
      <p class="hero-kicker">심각도 1위 · ${hhmm(s.as_of)} 기준</p>
      <div class="hero-main">
        <span class="hero-name">${typeChip(s.label)}</span>
        ${badge(s.grade)}
      </div>
      <p class="hero-sub">${s.freq}건 · 건수로는 ${countRank}위</p>
      ${countTop ? `<p class="flip">건수 1위 <b>${esc(name(countTop.label))} ${countTop.freq}건</b>보다
        <b>${esc(name(s.label))} ${s.freq}건</b>이 먼저입니다</p>` : ""}
    </section>`;
}

/** 유입 제목 옆 '확인 필요 N' (안전 의심이 있으면 'N · 안전 의심 M'). 0 이면 조용하게, 있으면 눈에 띄게 (D5-26 ④). */
function reviewCounts(n: number, safety: number, canOpen = false): string {
  const on = n > 0 ? " on" : "";
  const sus = safety > 0
    ? `<span class="rv-sep" aria-hidden="true">·</span><span class="rv-safe" role="img" aria-label="안전 의심 ${safety}건">${typeIcon("safety")}<span>안전 의심 <b>${safety}</b></span></span>` : "";
  const inner = `<span>확인 필요 <b>${n}</b></span>${sus}`;
  // 처리할 수 있는 서버면 버튼 (누르면 처리 패널이 열린다). 아니면 예전처럼 표시만.
  return canOpen
    ? ` · <button type="button" class="rv${on}${rvOpen ? " open" : ""}" data-rv-toggle aria-expanded="${rvOpen}" aria-controls="rvp" title="눌러서 확인 필요 민원 처리">${inner}</button>`
    : ` · <span class="rv${on}">${inner}</span>`;
}

/** 브리핑 첫 문장(결론)만 굵게. 문장을 자르지 않고 표시만 나눈다 — 원문은 그대로 다 보인다. */
function leadSentence(text: string): string {
  const m = String(text ?? "").match(/^(.+?[.!?。])(\s+)([\s\S]+)$/);
  return m ? `<b>${esc(m[1])}</b>${esc(m[3])}` : esc(text);
}

/** 알림 문구 앞의 "[안내/동선]" 같은 유형 표기는 제목과 겹치므로 뺀다. */
function stripLabel(detail: string): string {
  return String(detail ?? "").replace(/^\s*\[[^\]]{1,12}\]\s*/, "");
}
