// local 대역 — Supabase 키가 없을 때 node server/webapi.ts 에 붙는다. 제출본 아님.
// web/.env 에 Supabase 키가 들어가면 쓰이지 않는다. 키 없는 환경용으로 남겨 둔다 (할일 D5-9).
import type { Backend, DeletedItem } from "./data";

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, body === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // 방문객 화면에도 그대로 보일 수 있는 문구 (개발 용어 없이). name 으로 '연결 실패'를 구분한다 (report.ts · isNetworkError)
    const e = new Error("서버에 연결할 수 없습니다");
    e.name = "NetworkError";
    throw e;
  }
  const json = await res.json().catch(() => ({}));
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
    requestDoc: (label) => call("/api/rpc/request_doc", { p_label: label }),
    setActionStatus: (id, status) =>
      call("/api/rpc/set_action_status", { p_id: id, p_status: status }),
    deleteFeedback: (id) => call("/api/rpc/delete_feedback", { p_id: id }),
    restoreFeedback: (id) => call("/api/rpc/restore_feedback", { p_id: id }),
    freshness: () => call("/api/freshness"),
    getSettings: () => call("/api/settings"),
    saveFestival: async (f) => { await call("/api/rpc/save_festival", { p_name: f.name, p_region: f.region, p_start_date: f.start_date, p_end_date: f.end_date }); },
    addZone: (name) => call("/api/rpc/add_zone", { p_name: name }),
    renameZone: async (id, name) => { await call("/api/rpc/rename_zone", { p_id: id, p_name: name }); },
    setZoneHidden: async (id, hidden) => { await call("/api/rpc/set_zone_hidden", { p_id: id, p_hidden: hidden ? 1 : 0 }); },
    saveDepartment: async (label, department, contact) => { await call("/api/rpc/save_department", { p_label: label, p_department: department, p_contact: contact }); },
    devFeed: (since) => call("/api/rpc/dev_feed", { p_since_log: since.log, p_since_cls: since.cls }),
    listDeleted: async () => (await call<{ items: DeletedItem[] }>("/api/rpc/list_deleted", {})).items ?? [],
    resolveReview: (id, label) => call("/api/rpc/resolve_review", { p_id: id, p_label: label }),
    dismissReview: (id) => call("/api/rpc/dismiss_review", { p_id: id }),
    reopenReview: (id) => call("/api/rpc/reopen_review", { p_id: id }),

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
