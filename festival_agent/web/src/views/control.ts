// 관제 — 운영요원이 띄워 두는 화면. 실시간 구독으로 다시 그려진다.
// 읽는 순서를 고정한다: ① 결론(브리핑) → ② 지금 조치할 일 카드(1위 크게·나머지 행) → ③ 알림 → ④ 유형별 순위(접힘)·유입.
// 3초 안에 "지금 제일 위험한 것 1개" 가 읽혀야 한다 (할일 D5-15). 카드는 '무엇이 · 어디서 · 무엇부터 · 무엇을 할지' 를 한 장에 담는다 (D5-29).
// 서버가 issues[] 를 아직 안 주면(구버전) 예전 유형 단위 화면(심각도 1위 카드 + 유형 순위)으로 그린다.
import { storedCode } from "../admin";
import { api, zones, type Issue, type IssueAction, type Quote, type Severity } from "../data";
import {
  LABELS, STATUS_LABEL, badge, delButton, esc, flipPlay, flipSnap, hhmm, jsonList, makeFresh, pop, reduced, toast, toastAction,
  typeChip, typeIcon, uiIcon,
} from "../ui";

const open = new Set<string>();       // 계산식을 펼친 라벨 (다시 그려도 유지)
const openAlerts = new Set<number>(); // 펼친 알림
const openFeed = new Set<number>();   // 펼친 유입 원문
const openIssue = new Set<string>();  // 펼친 카드(행) — issue_key
const openFx = new Set<string>();     // 계산식을 펼친 카드
const grpOpen = new Set<string>();    // 펼친 묶음(그 밖 · 조치 중 · 조치 완료 · 유형별 순위)

const name = (label: string) => LABELS[label] ?? label;

// 다시 그려도 '새로 들어온 것만' 움직이게 하는 상태 (D5-26)
const feedFresh = makeFresh();
const alertFresh = makeFresh();
const issueFresh = makeFresh();
const prevBar = new Map<string, number>();          // 유형별 막대 폭 — 바뀐 만큼만 채워지게
const prevText = new Map<string, string>();         // 카드별 text_updated_at — 문구가 실제로 바뀐 카드만 강조
const textChangedAt = new Map<string, number>();
let prevTop: string | null = null;                  // 지난번 심각도 1위 — 바뀌면 카드가 살짝 바뀐다 (옛 화면)

// 지운(숨긴) 민원 (D5-30). 누르면 서버 응답을 기다리지 않고 바로 숨기고, 서버가 빼 준 뒤에 이 목록에서도 정리한다.
const hidden = new Set<number>();
let lastRoot: HTMLElement | null = null;

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
  const [d, zs] = await Promise.all([api.control(), zones()]);
  const { sev, alerts } = d;
  const zoneName = new Map(zs.map((z) => [z.id, z.name]));

  // 서버가 이미 뺀 민원은 '숨김 대기' 목록에서 정리한다 (다른 곳에서 되돌려도 다시 보이게)
  const present = new Set<number>(d.feed.map((f) => f.id));
  for (const i of d.issues ?? []) for (const q of jsonList<Quote>(i.latest_quotes)) present.add(q.id);
  hidden.forEach((id) => { if (!present.has(id)) hidden.delete(id); });

  const feed = d.feed.filter((f) => !hidden.has(f.id));
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
    const w = Math.min(100, s.score);
    return `
          <li class="${open.has(s.label) ? "open" : ""}" data-label="${esc(s.label)}">
            <button class="row" type="button" aria-expanded="${open.has(s.label)}">
              <span class="no">${i + startNo}</span>
              <span class="name">${typeChip(s.label)}</span>
              <span class="score">${s.score.toFixed(1)}</span>
              ${badge(s.grade)}
              <span class="sub">
                <span class="${up ? "up" : ""}">${s.freq}건 · 건수 ${cr}위${up ? " ▲" : ""}</span>
                <span class="bar" aria-hidden="true"><i data-w="${w}" style="width:${reduced() ? w : (prevBar.get(s.label) ?? 0)}%" class="g-${esc(s.grade)}"></i></span>
              </span>
            </button>
            <div class="formula-box">${esc(s.formula)}</div>
          </li>`;
  }).join("")}</ol>` : `<p class="muted">다른 유형은 아직 없습니다.</p>`;

  root.innerHTML = `
    <section class="card brief" aria-label="지금 조치할 일">
      <h2 class="pg-title">지금 조치할 일 <span class="muted small">통합 에이전트 브리핑${b ? ` · ${hhmm(b.created_at)}` : ""}</span></h2>
      ${b ? `<p class="brief-text">${leadSentence(b.text)}</p>${b.rationale ? `<p class="brief-why">근거: ${esc(b.rationale.replace(/^\s*근거\s*[:：]\s*/, ""))}</p>` : ""}`
          : `<p class="muted">워커가 에이전트를 한 바퀴 돌면 표시됩니다.</p>`}
      ${hasIssues && flipped && mine && lead ? `<p class="flip">건수 1위 <b>${esc(name(byCount[0].label))} ${byCount[0].freq}건</b>보다
        <b>${esc(lead.zone_name ?? "구역 미상")} ${esc(name(mine.label))} ${mine.freq}건</b>이 먼저입니다</p>` : ""}
    </section>

    ${hasIssues ? `
    ${main.length ? `<div class="icards" aria-label="조치할 일 카드">${main.map((c, i) => issueCard(c, i + 1, i === 0, zoneName)).join("")}</div>`
      : `<section class="card"><p class="muted">지금 바로 조치할 일은 없습니다.</p></section>`}
    ${group("more", "그 밖", more, main.length + 1, zoneName)}
    ${group("in_progress", "조치 중", prog, 1, zoneName)}
    ${group("done", "조치 완료", done, 1, zoneName)}`
    : (top ? hero(top, countRank.get(top.label) ?? 0, flipped && byCount[0] ? byCount[0] : null, heroSwap) : `
    <section class="card"><p class="muted">아직 판정된 민원이 없습니다.</p></section>`)}

    ${alerts.length ? `<ul class="alerts" aria-label="미확인 알림">${alerts.map((a) => { const fr = alertFresh.of(a.id); return `
      <li class="alert ${openAlerts.has(a.id) ? "open" : ""}${fr.cls}" style="${fr.style}" data-id="${a.id}">
        <button type="button" class="alert-row" aria-expanded="${openAlerts.has(a.id)}">
          ${gradeOf.has(a.label) ? badge(gradeOf.get(a.label)!) : ""}
          <b>${typeChip(a.label, true)}</b>
          <span class="alert-text">${esc(stripLabel(a.detail))}</span>
          <span class="alert-time">${hhmm(a.created_at)}</span>
        </button>
      </li>`; }).join("")}</ul>` : ""}

    <div class="grid2">
      ${hasIssues ? `
      <details class="card typerank" data-grp="rank" ${grpOpen.has("rank") ? "open" : ""}>
        <summary><span class="typerank-t">유형별 순위</span> <span class="muted small">카드 점수의 근거${top ? ` · ${hhmm(top.as_of)} 기준` : ""}</span></summary>
        ${sev.length ? rankList(sev, 1) : `<p class="muted">아직 판정된 유형이 없습니다.</p>`}
      </details>` : `
      <section class="card">
        <h2>그다음 순위 <span class="muted small">${top ? `${hhmm(top.as_of)} 기준 · 누르면 계산식` : ""}</span></h2>
        ${rankList(rest, 2)}
      </section>`}

      <section class="card">
        <h2>실시간 유입 <span class="muted counts">누적 <b>${d.total}</b> · 분류 대기 <b>${d.pending}</b>${reviewCounts(d.review ?? 0, d.review_safety ?? 0)}${d.deleted ? ` · 지운 민원 <b>${d.deleted}</b>` : ""}</span></h2>
        <ul class="feed">${feed.map((f) => {
          const done = f.status === "done" && f.label;
          const review = f.status === "review";   // 근거 없거나 신뢰도가 낮아 유형을 못 정한 민원 — 운영자가 봐야 한다
          const fr = feedFresh.of(f.id);
          return `<li class="${openFeed.has(f.id) ? "open" : ""}${fr.cls}" style="${fr.style}" data-id="${f.id}" data-fid="${f.id}">
            <button type="button" class="feed-item" title="${esc(f.raw_text)}">
              <span class="feed-text">${esc(f.raw_text)}</span>
              <span class="meta">
                <span class="tag ${done ? "" : review ? "review" : "wait"}">${done ? typeChip(f.label!, true) : review ? "확인 필요" : "분류 중"}</span>
                ${f.receipt_no ? `<span class="rcpt" title="방문객 접수번호">W-${f.receipt_no}</span>` : ""}
                <span>${esc(f.zone_id == null ? "구역 미상" : (zoneName.get(f.zone_id) ?? "구역 미상"))}</span>
                <span>${hhmm(f.ingested_at)}</span>
              </span>
            </button>
            ${delButton(f.id)}</li>`;
        }).join("") || `<li class="muted">접수된 민원이 없습니다.</li>`}</ul>
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
  const hb = root.querySelector<HTMLButtonElement>("#hero-formula");
  hb?.addEventListener("click", () => {
    const box = root.querySelector<HTMLElement>("#hero-formula-box")!;
    const show = box.hidden;
    box.hidden = !show;
    hb.textContent = show ? "계산식 접기" : "계산식 보기";
    hb.setAttribute("aria-expanded", String(show));
    show ? open.add(`hero:${top!.label}`) : open.delete(`hero:${top!.label}`);
    if (show) pop(box);
  });

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
  root.querySelectorAll<HTMLButtonElement>("[data-fx]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const k = btn.dataset.fx!;
      const box = btn.closest(".icard")!.querySelector<HTMLElement>(".ic-fx")!;
      const show = box.hidden;
      box.hidden = !show;
      btn.textContent = show ? "계산식 접기" : "계산식 보기";
      btn.setAttribute("aria-expanded", String(show));
      show ? openFx.add(k) : openFx.delete(k);
      if (show) pop(box);
    }));
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

  // 순위·유입이 옮겨진 만큼만 미끄러지고, 점수 막대는 바뀐 만큼만 채워진다
  flipPlay(root, ".rank li", "label", snapRank);
  flipPlay(root, ".feed li[data-id]", "id", snapFeed);
  flipPlay(root, ".icard[data-key]", "key", snapCards);
  const bars = root.querySelectorAll<HTMLElement>(".bar i[data-w]");
  if (!reduced()) requestAnimationFrame(() => requestAnimationFrame(() => bars.forEach((i) => { i.style.width = `${i.dataset.w}%`; })));
  sev.forEach((s) => prevBar.set(s.label, Math.min(100, s.score)));
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
  const zone = c.zone_name ?? (c.zone_id != null ? zoneName.get(c.zone_id) : null) ?? "구역 미상";
  const st = c.action_status;
  const stText = st ? (STATUS_LABEL[st] ?? st) : "요청서 없음";
  const srcText = c.text_source === "llm" ? "AI 정리" : c.text_source === "local" ? "기본 문구(local 대역)" : "기본 문구";
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
  const quoteLi = (q: Quote, del: boolean) => `<li${del ? ` data-fid="${q.id}"` : ""}><span class="qt" title="${esc(q.text)}">“${esc(q.text)}”</span><span class="muted small qm">${del ? "" : `#${q.id} · `}${hhmm(q.posted_at)}</span>${del ? delButton(q.id) : ""}</li>`;
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
        <ol class="ic-acts">${normal.map(actLi).join("") || `<li class="muted">${risky.length ? "일반 조치는 없고, 아래 판단이 필요한 조치만 있습니다." : "아직 정리된 조치가 없습니다."}</li>`}</ol>
        ${risky.length ? `
        <div class="ic-risk" role="group" aria-label="운영자 판단 필요">
          <p class="ic-risk-t"><span aria-hidden="true">⚠</span> 운영자 판단 필요 — 실행 전 현장 확인</p>
          <ol class="ic-acts">${risky.map(actLi).join("")}</ol>
        </div>` : ""}
        <p class="ic-who">담당 <b>${esc(c.department ?? "-")}</b>${c.contact ? ` · <a href="tel:${esc(c.contact.replace(/[^0-9+]/g, ""))}">${esc(c.contact)}</a>` : ""}</p>
        <div class="ic-quotes">
          <section class="ic-q" aria-label="판단 근거">
            <h4 class="ic-h2">판단 근거 <span class="muted small">문구가 바뀔 때만 바뀜</span></h4>
            <ul>${c.evidence.map((q) => quoteLi(q, false)).join("") || `<li class="muted">-</li>`}</ul>
          </section>
          <section class="ic-q" aria-label="최신 민원">
            <h4 class="ic-h2">최신 민원 <span class="muted small">실시간</span></h4>
            <ul>${c.latest.map((q) => quoteLi(q, true)).join("") || `<li class="muted">-</li>`}</ul>
          </section>
        </div>
        <div class="ic-actions">
          <button class="btn ${!st && (c.grade === "immediate" || c.grade === "high") ? "primary" : ""}" data-gen="${esc(c.label)}">${esc(name(c.label))} 전체 요청서 ${st && st !== "done" ? "다시 생성" : "생성"}</button>
          <span class="st st-${esc(st ?? "none")}">${esc(stText)}</span>
          <a class="linkbtn" href="#action">조치 화면에서 상태 바꾸기</a>
          <button type="button" class="linkbtn" data-fx="${esc(c.issue_key)}" aria-expanded="${openFx.has(c.issue_key)}">${openFx.has(c.issue_key) ? "계산식 접기" : "계산식 보기"}</button>
        </div>
        <div class="formula-box ic-fx" ${openFx.has(c.issue_key) ? "" : "hidden"}>카드 점수 ${esc(c.formula)}</div>
        <p class="ic-src muted small">${srcText}${c.text_updated_at ? ` · ${hhmm(c.text_updated_at)} 정리` : ""}</p>
      </div>`;
  const cls = `icard g-${esc(c.grade)}${big ? " big" : ""}${opened && !big ? " open" : ""}${fr.cls}${chOn ? " retext" : ""}`;
  const style = fr.style || (chOn ? `animation-delay:-${chMs}ms` : "");
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
  const shown = open.has(`hero:${s.label}`);
  return `
    <section class="card hero g-${esc(s.grade)}${swap ? " swap" : ""}" aria-label="심각도 1위">
      <p class="hero-kicker">심각도 1위 · ${hhmm(s.as_of)} 기준</p>
      <div class="hero-main">
        <span class="hero-name">${typeChip(s.label)}</span>
        ${badge(s.grade)}
        <span class="hero-score">${s.score.toFixed(1)}<small> 점</small></span>
      </div>
      <p class="hero-sub">${s.freq}건 · 건수로는 ${countRank}위</p>
      ${countTop ? `<p class="flip">건수 1위 <b>${esc(name(countTop.label))} ${countTop.freq}건</b>보다
        <b>${esc(name(s.label))} ${s.freq}건</b>이 먼저입니다</p>` : ""}
      <button type="button" class="linkbtn" id="hero-formula" aria-expanded="${shown}">${shown ? "계산식 접기" : "계산식 보기"}</button>
      <div class="formula-box" id="hero-formula-box" ${shown ? "" : "hidden"}>${esc(s.formula)}</div>
    </section>`;
}

/** 유입 제목 옆 '확인 필요 N' (안전 의심이 있으면 'N · 안전 의심 M'). 0 이면 조용하게, 있으면 눈에 띄게 (D5-26 ④). */
function reviewCounts(n: number, safety: number): string {
  const on = n > 0 ? " on" : "";
  const sus = safety > 0
    ? `<span class="rv-sep" aria-hidden="true">·</span><span class="rv-safe" role="img" aria-label="안전 의심 ${safety}건">${typeIcon("safety")}<span>안전 의심 <b>${safety}</b></span></span>` : "";
  return ` · <span class="rv${on}"><span>확인 필요 <b>${n}</b></span>${sus}</span>`;
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
