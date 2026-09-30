// 화면 공용 — 라벨·등급 이름, 유형 아이콘, 이스케이프, 배지, 토스트, 모션 도우미.

// core/config.py 와 같게 유지
export const LABELS: Record<string, string> = {
  parking: "주차/교통",
  restroom: "화장실",
  price: "가격/바가지",
  guide: "안내/동선",
  crowd: "혼잡",
  safety: "안전",
  positive: "긍정",
};

export const GRADES: Record<string, string> = {
  immediate: "즉시",
  high: "높음",
  mid: "보통",
  low: "낮음",
};

/** 화면에서 좁은 곳(유입 태그·알림)에 쓰는 짧은 이름. 전체 이름은 aria-label · title 로 남긴다. */
export const SHORT: Record<string, string> = {
  parking: "주차",
  restroom: "화장실",
  price: "가격",
  guide: "안내",
  crowd: "혼잡",
  safety: "안전",
  positive: "긍정",
};

/** 유형 아이콘 한 벌 (D5-26). 인라인 SVG · 24 격자 · 선 아이콘 · currentColor — 외부 폰트·CDN 없음.
 *  색은 글자색을 따라가므로 흑백이다. 위험도 색은 등급 배지에만 둔다. */
const ICON_PATHS: Record<string, string> = {
  // 혼잡: 사람 둘이 겹쳐 선 모양
  crowd: `<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.2a5 5 0 0 1 4 4.8v1"/>`,
  // 안전: 방패 + 느낌표
  safety: `<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/><path d="M12 8v5"/><path d="M12 16.2h.01"/>`,
  // 주차/교통: 네모 안의 P
  parking: `<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.5 16.5v-9h3.2a2.8 2.8 0 0 1 0 5.6H9.5"/>`,
  // 화장실: 네모 안의 WC
  restroom: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 9.5l1.1 5 1.4-4 1.4 4 1.1-5"/><path d="M17.6 10.4a2.5 2.5 0 1 0 0 3.2"/>`,
  // 가격/바가지: 동전 안의 원화 표시
  price: `<circle cx="12" cy="12" r="9"/><path d="M7.5 9l1.8 6.5L12 9l2.7 6.5L16.5 9"/><path d="M6.8 11.4h10.4M6.8 13.6h10.4"/>`,
  // 안내/동선: 두 갈래 이정표
  guide: `<path d="M12 21V4"/><path d="M12 5h7l2 2.5-2 2.5h-7"/><path d="M12 12H5l-2 2.5L5 17h7"/>`,
  // 긍정: 엄지 척
  positive: `<path d="M7 11v9H4.5a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 4.5 11z"/><path d="M7 11l4-8a2.5 2.5 0 0 1 2.4 3.2L13 9h5.6a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.4 20H7"/>`,
};

/** 아이콘만. 장식이므로 스크린리더에는 숨긴다 — 이름은 옆의 글자나 aria-label 이 맡는다. */
export function typeIcon(label: string): string {
  const d = ICON_PATHS[label] ?? `<circle cx="12" cy="12" r="3"/>`;
  return `<svg class="ti" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
}

/** 유형이 아닌 화면 부품 아이콘 (같은 선 아이콘 스타일): 휴지통(민원 지우기), 위치 핀. */
const UI_PATHS = {
  trash: `<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>`,
  pin: `<path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9.5" r="2.5"/>`,
};
export function uiIcon(name: keyof typeof UI_PATHS): string {
  return `<svg class="ti" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${UI_PATHS[name]}</svg>`;
}

/** 민원 지우기 버튼 (D5-30). 글자 없이 아이콘만이라 aria-label 이 이름이다. */
export function delButton(id: number): string {
  return `<button type="button" class="del" data-del="${id}" aria-label="민원 지우기" title="민원 지우기">${uiIcon("trash")}</button>`;
}

/** 서버가 JSON 문자열로 주는 열을 배열로. 이미 배열이면 그대로, 깨졌으면 빈 배열. */
export function jsonList<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string" && v) {
    try { const x = JSON.parse(v); return Array.isArray(x) ? (x as T[]) : []; } catch { return []; }
  }
  return [];
}

/** 아이콘 + 글자. short 면 짧은 이름을 보이고 전체 이름은 aria-label · title 에 남긴다. */
export function typeChip(label: string, short = false): string {
  const full = LABELS[label] ?? label;
  const text = short ? (SHORT[label] ?? full) : full;
  const aria = short ? ` role="img" aria-label="${esc(full)}" title="${esc(full)}"` : "";
  return `<span class="ty ty-${esc(label)}"${aria}>${typeIcon(label)}<span>${esc(text)}</span></span>`;
}

/** 움직임을 줄여 달라는 설정이면 true — 스크립트로 하는 모션(FLIP·막대 채움)은 이때 건너뛴다. CSS 쪽은 미디어 쿼리로 끈다. */
export const reduced = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 방금 들어온 항목만 움직이게 하는 추적기 (D5-26).
 *  화면은 SSE 마다 통째로 다시 그려지므로, 새로 생긴 id 만 골라 'fresh' 를 붙이고
 *  다시 그려져도 애니메이션이 처음부터 다시 돌지 않게 지난 시간만큼 앞당겨 이어서 재생한다. */
let freshEpoch = 0;
/** 화면에 (다시) 들어왔을 때 호출한다 — 그 사이에 쌓인 항목이 한꺼번에 '새 항목' 으로 튀지 않게, 다음 그리기를 기준선으로 삼는다. */
export function resetFresh(): void { freshEpoch++; }

export function makeFresh(life = 1000) {
  const seen = new Set<number>();
  const born = new Map<number, number>();
  let epoch = -1;
  return {
    /** 이번에 그릴 id 들을 알린다. 화면에 들어온 뒤 첫 그리기이거나 한꺼번에 8개 넘게 늘면 '기존' 으로 친다.
     *  (시간이 아니라 화면 진입을 기준으로 한다 — 조용한 시간이 길어도 그 뒤에 들어온 항목은 새 항목이다.) */
    update(ids: number[]): void {
      const now = Date.now();
      const first = epoch !== freshEpoch;
      epoch = freshEpoch;
      const added = ids.filter((i) => !seen.has(i));
      if (first || added.length > 8) { ids.forEach((i) => seen.add(i)); return; }
      for (const i of added) { seen.add(i); born.set(i, now); }
    },
    /** 되돌리기 등으로 다시 나타나는 항목이 새 항목처럼 들어오게 한다. */
    forget(id: number): void { seen.delete(id); born.delete(id); },
    /** 항목에 붙일 class · style. 새 항목이 아니면 빈 문자열. */
    of(id: number): { cls: string; style: string } {
      const t = born.get(id);
      if (t === undefined) return { cls: "", style: "" };
      const el = Date.now() - t;
      if (el >= life) { born.delete(id); return { cls: "", style: "" }; }
      return { cls: " fresh", style: `animation-delay:-${el}ms` };
    },
  };
}

/** FLIP — 다시 그리기 전에 위치를 적어 두고(snap), 그린 뒤 옮겨진 항목만 이전 자리에서 새 자리로 미끄러지게 한다. */
export function flipSnap(root: HTMLElement, sel: string, key: string): Map<string, number> {
  const m = new Map<string, number>();
  root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
    const k = el.dataset[key];
    if (k !== undefined) m.set(k, el.getBoundingClientRect().top);
  });
  return m;
}
export function flipPlay(root: HTMLElement, sel: string, key: string, snap: Map<string, number>): void {
  if (reduced() || !snap.size) return;
  const moved: HTMLElement[] = [];
  root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
    const old = snap.get(el.dataset[key] ?? "");
    if (old === undefined) return;
    const dy = old - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 2) return;
    el.style.transition = "none";
    el.style.transform = `translateY(${dy}px)`;
    moved.push(el);
  });
  if (!moved.length) return;
  void root.offsetHeight; // 시작 자리를 먼저 확정
  requestAnimationFrame(() => moved.forEach((el) => {
    el.style.transition = "transform 240ms ease";
    el.style.transform = "";
    setTimeout(() => { el.style.transition = ""; }, 280);
  }));
}

/** 사용자가 펼치거나 접을 때만 짧게 움직인다 (다시 그릴 때는 붙지 않는다). */
export function pop(el: Element): void {
  el.classList.remove("pop");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("pop");
  setTimeout(() => el.classList.remove("pop"), 300);
}

/** 사람이 고르는 처리 상태 (세그먼트 버튼). set_action_status RPC 허용 목록과 같다. */
export const STATUS: Record<string, string> = {
  requested: "요청",
  in_progress: "조치중",
  done: "완료",
};

/** 표시용 — 워커가 붙이는 상태까지. 같은 유형 요청서를 다시 만들면 이전 열린 건은 superseded. */
export const STATUS_LABEL: Record<string, string> = { ...STATUS, superseded: "대체됨" };

/** 더 이상 처리할 필요가 없는 상태 */
export const isClosed = (status: string) => status === "done" || status === "superseded";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export const hhmm = (iso: string | null | undefined) => (iso ? iso.slice(11, 16) : "");

export function badge(grade: string): string {
  return `<span class="badge g-${esc(grade)}">${esc(GRADES[grade] ?? grade)}</span>`;
}

export function toast(msg: string, kind: "info" | "warn" = "info"): void {
  const box = document.getElementById("toasts")!;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), reduced() ? 0 : 200);
  }, 6000);
}

/** 버튼이 달린 토스트 (D5-30 '지웠습니다 · 되돌리기'). ms 동안만 보이고, 버튼을 누르면 바로 닫히며 onAction 이 실행된다.
 *  #toasts 는 터치를 통과시키지만 이 버튼만은 눌려야 하므로 CSS 에서 .toast-act 만 pointer-events:auto 이다. */
export function toastAction(msg: string, actionLabel: string, onAction: () => void, ms = 5000): void {
  const box = document.getElementById("toasts")!;
  const el = document.createElement("div");
  el.className = "toast has-act";
  const text = document.createElement("span");
  text.textContent = `${msg} ·`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-act";
  btn.textContent = actionLabel;
  el.appendChild(text);
  el.appendChild(btn);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add("out");
    setTimeout(() => el.remove(), reduced() ? 0 : 200);
  };
  btn.addEventListener("click", () => { close(); onAction(); });
  box.appendChild(el);
  setTimeout(close, ms);
}
