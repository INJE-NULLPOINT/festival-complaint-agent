// local 대역 — Supabase 키가 없을 때 python webapi.py 에 붙는다. 제출본 아님.
// web/.env 에 Supabase 키가 들어가면 쓰이지 않는다. 키 없는 환경용으로 남겨 둔다 (할일 D5-9).
import { AdminDenied } from "./admin";
import type { Backend, DeletedItem } from "./data";

/** HTTP 헤더 값은 영문·숫자·기호(ISO-8859-1)만 된다. 한글 등이 섞인 코드는 헤더에 못 싣는다. */
const headerSafe = (s: string) => /^[\x20-\x7e]+$/.test(s);

/** code 가 있으면 운영자 코드를 싣는다 (관리자 RPC 전용, D5-31).
 *  영문·숫자 코드는 X-Admin-Code 헤더로, 한글 등이 섞인 코드는 본문 p_code 로 보낸다 (서버는 둘 다 받는다 — 헤더에 한글을 넣으면 요청 자체가 만들어지지 않는다). */
async function call<T>(path: string, body?: unknown, code?: string): Promise<T> {
  let res: Response;
  const viaHeader = !!code && headerSafe(code);
  const payload = code && !viaHeader ? { ...(body as object), p_code: code } : body;
  try {
    res = await fetch(path, body === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(viaHeader ? { "X-Admin-Code": code! } : {}) },
      body: JSON.stringify(payload),
    });
  } catch {
    // 방문객 화면에도 그대로 보일 수 있는 문구 (개발 용어 없이). name 으로 '연결 실패'를 구분한다 (report.ts · isNetworkError)
    const e = new Error("서버에 연결할 수 없습니다");
    e.name = "NetworkError";
    throw e;
  }
  const json = await res.json().catch(() => ({}));
  // 서버의 운영자 코드 검사: 401 코드 없음·틀림 · 403 서버에 코드 미설정 · 429 틀린 시도가 많아 잠김
  if (res.status === 401) throw new AdminDenied("wrong", json.error ?? "운영자 코드가 필요합니다");
  if (res.status === 403) throw new AdminDenied("unset", json.error ?? "운영자 코드가 설정되지 않았습니다");
  if (res.status === 429) throw new AdminDenied("locked", json.error ?? "시도가 너무 많습니다");
  // 프록시(vite · nginx 등) 뒤에서 webapi 가 죽으면 연결 거부가 아니라 502·503·504 나 본문 없는 500 으로 돌아온다.
  // webapi 자신의 오류는 항상 {error: ...} JSON 이라서, 그 모양이 아닌 5xx 는 '서버에 닿지 못함'으로 본다.
  if (res.status >= 500 && typeof json.error !== "string") {
    const e = new Error("서버에 연결할 수 없습니다");
    e.name = "NetworkError";
    throw e;
  }
  if (!res.ok) throw new Error(json.error ?? `요청 실패 (${res.status})`);
  return json.data as T;
}

export function localBackend(): Backend {
  return {
    name: "local",
    zones: () => call("/api/zones"),
    festival: async () => (await call<{ name: string } | null>("/api/festival"))?.name ?? "",
    control: () => call("/api/control"),
    action: () => call("/api/action"),
    submitFeedback: (zoneId, text) =>
      call("/api/rpc/submit_feedback", { p_zone_id: zoneId, p_text: text }),
    // 관리자 동작 — 코드를 헤더로 싣는다 (묻는 것은 admin.ts 의 gateAdmin)
    checkAdmin: async (code) => { await call("/api/rpc/check_admin", {}, code); },
    requestDoc: (label, code) => call("/api/rpc/request_doc", { p_label: label }, code),
    setActionStatus: (id, status, code) =>
      call("/api/rpc/set_action_status", { p_id: id, p_status: status }, code),
    deleteFeedback: (id, code) => call("/api/rpc/delete_feedback", { p_id: id }, code),
    restoreFeedback: (id, code) => call("/api/rpc/restore_feedback", { p_id: id }, code),
    listDeleted: async (code) => (await call<{ items: DeletedItem[] }>("/api/rpc/list_deleted", {}, code)).items ?? [],
    resolveReview: (id, label, code) => call("/api/rpc/resolve_review", { p_id: id, p_label: label }, code),
    dismissReview: (id, code) => call("/api/rpc/dismiss_review", { p_id: id }, code),
    reopenReview: (id, code) => call("/api/rpc/reopen_review", { p_id: id }, code),

    subscribe(h) {
      // EventSource 는 끊기면 보통 알아서 다시 붙는다. 그런데 서버가 죽어 연결이 아예 닫힌(CLOSED) 채로 남는 브라우저가 있어,
      // 그때는 직접 다시 연다 (1초 → 2 → 4 → 8초, 붙으면 처음으로). 다시 붙으면 그 사이 놓친 변화를 받으려고 한 번 다시 그린다 (D5-36).
      let wait = 1000;
      let first = true;
      const open = () => {
        const es = new EventSource("/api/events");
        es.addEventListener("ready", () => {
          wait = 1000;
          h.onStatus(true);
          if (!first) h.onChange();
          first = false;
        });
        es.addEventListener("change", () => h.onChange());
        es.addEventListener("alert", (e) => h.onAlert(JSON.parse((e as MessageEvent).data)));
        es.addEventListener("doc_done", (e) => h.onDocDone(JSON.parse((e as MessageEvent).data)));
        es.onerror = () => {
          h.onStatus(false);
          if (es.readyState === 2) {        // EventSource.CLOSED — 브라우저가 포기했으니 직접 다시
            es.close();
            setTimeout(open, wait);
            wait = Math.min(wait * 2, 8000);
          }
        };
      };
      open();
    },
  };
}
