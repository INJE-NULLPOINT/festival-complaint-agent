// 관리자 동작 보호 (할일 D5-31) — 운영자 코드 입력 창 · 코드 보관 · 관리자 동작 감싸기.
//
// 방문객은 접수(submit_feedback) 하나만 쓴다. 민원 지우기·되돌리기, 조치 상태 변경, 조치요청서 생성은
// 운영자 코드가 맞을 때만 서버가 실행한다. 이 파일은 그 코드를 '처음 누를 때 한 번' 물어 탭이 닫힐 때까지 기억한다.
//
// 규칙
//   · 코드는 sessionStorage 에만 둔다 (localStorage 금지). 탭을 닫으면 사라진다. 저장소를 못 쓰면 메모리에만.
//   · 방문객 화면(?v=qr)에서는 입력 창을 그리지 않고 관리자 동작 자체를 거부한다.
//   · 코드를 안 정하고 서버에 보내지 않는다 (서버는 틀린 시도를 세어 10분 5회에 잠근다 — 빈 요청으로 잠기지 않게).
//   · 화면(control.ts · action.ts)은 그대로 api.deleteFeedback(id) 처럼 부른다. 문은 data.ts 의 gateAdmin 이 건다.
import "./admin.css";
import type { Backend } from "./data";

/** 서버가 관리자 동작을 거부했다. kind: wrong 코드 없음·틀림(401) · unset 서버에 코드 미설정(403) · locked 잠김(429) */
export class AdminDenied extends Error {
  constructor(public kind: "wrong" | "unset" | "locked", message: string) { super(message); this.name = "AdminDenied"; }
}
/** 사용자가 코드 입력을 취소했다 */
export class AdminCancelled extends Error {
  constructor() { super("운영자 코드 입력을 취소했습니다"); this.name = "AdminCancelled"; }
}

export const MSG = {
  wrong: "코드가 맞지 않습니다. 다시 입력해 주세요",
  stale: "저장된 코드가 더 이상 맞지 않습니다. 다시 입력해 주세요",
  unset: "서버에 운영자 코드가 설정되지 않았습니다. 운영자에게 알려 주세요",
  locked: "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요 (약 10분)",
  visitor: "관리자 화면에서만 쓸 수 있습니다",
};

// ── 코드 보관 ─────────────────────────────────────────────────────
const KEY = "festival_admin_code";
let memory: string | null = null;   // sessionStorage 를 못 쓸 때(사생활 보호 모드 등)의 대비

export function storedCode(): string | null {
  try { return sessionStorage.getItem(KEY) || memory; } catch { return memory; }
}
function remember(code: string): void {
  memory = code;
  try { sessionStorage.setItem(KEY, code); } catch { /* 메모리에만 */ }
}
export function forgetCode(): void {
  memory = null;
  try { sessionStorage.removeItem(KEY); } catch { /* */ }
}

const isVisitor = () =>
  document.body.classList.contains("visitor") || new URLSearchParams(location.search).get("v") === "qr";

// ── 입력 창 ───────────────────────────────────────────────────────
type Verify = (code: string) => Promise<void>;
type Outcome = { code: string } | { denied: AdminDenied } | null;   // null = 취소
let pending: Promise<Outcome> | null = null;                        // 동시에 여러 동작이 눌려도 창은 하나

function unlock(verify: Verify, notice: string): Promise<Outcome> {
  if (pending) return pending;
  pending = new Promise<Outcome>((resolve) => {
    const before = document.activeElement as HTMLElement | null;
    const hide = [document.querySelector("header.top"), document.getElementById("app"), document.getElementById("toasts")].filter(Boolean) as HTMLElement[];

    const overlay = document.createElement("div");
    overlay.className = "adm-overlay";
    overlay.innerHTML = `
      <form class="adm-modal" role="dialog" aria-modal="true" aria-labelledby="adm-t" aria-describedby="adm-d" novalidate>
        <h2 id="adm-t" class="adm-title">운영자 코드</h2>
        <p id="adm-d" class="adm-desc">민원 지우기 · 확인 필요 처리 · 조치 상태 변경 · 조치요청서 생성은 운영자만 할 수 있습니다. 코드를 입력해 주세요.</p>
        <p class="adm-err" role="alert" hidden></p>
        <label class="adm-lab" for="adm-code">코드</label>
        <div class="adm-field">
          <input id="adm-code" name="admin-code" type="password" autocomplete="new-password" autocapitalize="off"
                 autocorrect="off" spellcheck="false" enterkeyhint="done" />
          <button type="button" class="adm-eye" aria-pressed="false">보기</button>
        </div>
        <div class="adm-actions">
          <button type="button" class="adm-cancel">취소</button>
          <button type="submit" class="adm-ok">확인</button>
        </div>
      </form>`;
    const form = overlay.querySelector<HTMLFormElement>("form")!;
    const input = overlay.querySelector<HTMLInputElement>("#adm-code")!;
    const err = overlay.querySelector<HTMLElement>(".adm-err")!;
    const ok = overlay.querySelector<HTMLButtonElement>(".adm-ok")!;
    const cancel = overlay.querySelector<HTMLButtonElement>(".adm-cancel")!;
    const eye = overlay.querySelector<HTMLButtonElement>(".adm-eye")!;

    let terminal: AdminDenied | null = null;   // 더 물어도 소용없는 거부(잠김·서버 미설정)를 보여 주는 중
    const show = (msg: string) => { err.textContent = `⚠ ${msg}`; err.hidden = false; };
    if (notice) show(notice);

    const close = (out: Outcome) => {
      overlay.classList.add("closing");
      const done = () => {
        overlay.remove();
        document.body.classList.remove("adm-lock");
        hide.forEach((el) => el.removeAttribute("aria-hidden"));
        try { before?.focus?.(); } catch { /* */ }
        pending = null;
        resolve(out);
      };
      setTimeout(done, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
    };

    cancel.addEventListener("click", () => close(terminal ? { denied: terminal } : null));
    eye.addEventListener("click", () => {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      eye.textContent = reveal ? "숨기기" : "보기";
      eye.setAttribute("aria-pressed", String(reveal));
      input.focus();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (terminal) return close({ denied: terminal });
      const code = input.value;
      if (!code) { show("코드를 입력해 주세요"); input.focus(); return; }
      ok.disabled = true; ok.textContent = "확인 중…"; err.hidden = true;
      try {
        await verify(code);
        remember(code);
        close({ code });
      } catch (x) {
        ok.disabled = false; ok.textContent = "확인";
        if (x instanceof AdminDenied && x.kind === "wrong") { show(MSG.wrong); input.value = ""; input.focus(); }
        else if (x instanceof AdminDenied) {          // 잠김 · 서버 미설정: 다시 입력해도 소용없다
          terminal = x; show(x.kind === "locked" ? MSG.locked : MSG.unset);
          input.disabled = true; eye.disabled = true; ok.textContent = "닫기"; ok.focus();
        } else { console.error(x); show("서버에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요"); }   // 서버에 닿지 않음 등 — 원문 오류는 화면에 내지 않는다
      }
    });
    // Esc 로 취소 · Tab 이 창 밖으로 새지 않게
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); cancel.click(); return; }
      if (e.key !== "Tab") return;
      const f = [input, eye, cancel, ok].filter((el) => !el.disabled);
      const i = f.indexOf(document.activeElement as HTMLButtonElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    });

    hide.forEach((el) => el.setAttribute("aria-hidden", "true"));
    document.body.classList.add("adm-lock");
    document.body.appendChild(overlay);
    input.focus();
  });
  return pending;
}

// ── 관리자 동작 감싸기 ─────────────────────────────────────────────
/** 관리자 동작 하나를 실행한다. 코드가 없으면 먼저 묻고, 서버가 틀렸다고 하면(코드가 바뀐 경우) 다시 묻는다. */
export async function withAdmin<T>(run: (code: string) => Promise<T>, verify: Verify): Promise<T> {
  if (isVisitor()) throw new Error(MSG.visitor);
  let notice = "";
  for (;;) {
    let code = storedCode();
    if (!code) {
      const out = await unlock(verify, notice);
      if (!out) throw new AdminCancelled();
      if ("denied" in out) throw out.denied;
      code = out.code;
    }
    try {
      return await run(code);
    } catch (e) {
      if (!(e instanceof AdminDenied)) throw e;
      forgetCode();
      if (e.kind !== "wrong") throw e;          // 잠김 · 서버 미설정은 다시 물어도 소용없다
      notice = MSG.stale;
    }
  }
}

/** 이 동작들은 운영자 코드가 필요하다 — 서버의 관리자 RPC 와 같은 목록 (web/src/data-*.ts 가 코드를 싣는 이름) */
export const ADMIN_ACTIONS = ["requestDoc", "setActionStatus", "deleteFeedback", "restoreFeedback", "listDeleted", "resolveReview", "dismissReview", "reopenReview"] as const;

/** Backend 의 관리자 동작에 문을 건다. 나머지(읽기·접수)는 그대로 지나간다. */
export function gateAdmin(raw: Backend): Backend {
  const verify: Verify = (code) => raw.checkAdmin(code);
  const gated: Backend = { ...raw };
  for (const name of ADMIN_ACTIONS) {
    const fn = raw[name] as (...a: any[]) => Promise<any>;
    (gated as any)[name] = (...args: any[]) => withAdmin((code) => fn.call(raw, ...args, code), verify);
  }
  return gated;
}
