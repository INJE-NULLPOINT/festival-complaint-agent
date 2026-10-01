// 관제 맨 위 KPI 4장 (관리자 화면 구조 개편). 값은 /api/control 에 이미 있는 숫자만 쓴다 — 없는 숫자는 만들지 않는다.
//   접수 누적   total            (지운 민원 제외한 누적. '오늘' 건수는 API 에 없어 '오늘'이라고 적지 않는다)
//   조치할 일   issues 의 main    (지금 바로 조치할 카드 수 · 그 밖 N)
//   확인 필요   review           (그중 안전 의심 review_safety)
//   알림        alerts           (확인 안 한 알림 — 서버가 최근 3건까지만 줘서 '3건 이상'이 될 수 있다)
import type { ControlData } from "../data";
import { esc } from "../ui";

export function kpiRow(d: ControlData): string {
  const issues = d.issues;
  const main = issues.filter((i) => i.grp === "main").length;
  const more = issues.filter((i) => i.grp === "more").length;
  const review = d.review;
  const safe = d.review_safety;
  const alerts = d.alerts_total;
  const cards: [string, string, string, string][] = [
    ["kpi-total", "접수 누적", String(d.total), d.pending ? `분류 대기 ${d.pending}건` : ""],
    ["kpi-todo", "조치할 일", String(main), more ? `그 밖에 ${more}건 더 있음` : ""],
    ["kpi-review", "확인 필요", String(review), review ? `안전 의심 ${safe}건` : ""],
    ["kpi-alert", "확인 안 한 알림", String(alerts), alerts > d.alerts.length ? `등급 높은 ${d.alerts.length}건 표시` : ""],
  ];
  return `<section class="kpis" aria-label="요약">${cards.map(([id, label, value, sub]) =>
    `<div class="kpi" id="${id}"><span class="kpi-l">${esc(label)}</span><b class="kpi-v">${esc(value)}</b>${sub ? `<span class="kpi-s">${esc(sub)}</span>` : ""}</div>`).join("")}</section>`;
}
