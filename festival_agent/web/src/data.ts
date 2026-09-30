// 데이터 계층. 화면(views)은 이 파일만 부른다.
//
// 백엔드 선택은 LLM 백엔드와 같은 방식이다.
//   web/.env 에 VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY 가 있으면  supabase
//   없으면                                                          local 대역 (python webapi.py)
import { gateAdmin } from "./admin";
import { localBackend } from "./data-local";
import { supabaseBackend } from "./data-supabase";

export type Zone = { id: number; name: string };
export type Severity = {
  id: number; label: string; as_of: string; window: string; freq: number; score: number;
  grade: string; formula: string;
  safety_w?: number;   // 안전 가중치(>1 이면 안전 계열) — 유형 순위 정렬에 쓴다
};
export type Briefing = { id: number; text: string; rationale: string | null; created_at: string };
export type FeedItem = {
  id: number; raw_text: string; ingested_at: string; zone_id: number | null; // 구역을 모르는 민원은 null
  label: string | null; status: string | null;
  receipt_no?: number | null;   // 방문객이 받은 접수번호 W-n (웹 접수만). 운영자가 번호로 민원을 찾는다
};
export type Alert = { id: number; label: string; kind: string; detail: string; created_at: string };
export type Action = {
  id: number; label: string; department: string; count: number;
  status: string; created_at: string; closed_at: string | null;
  doc_url: string | null; doc_json: string | null;
};
export type DocJob = {
  id: number; label: string; status: string; error: string | null;
  action_request_id: number | null; created_at: string;
};

/** 조치할 일 카드 한 장 (D5-29). 서버 issue 표의 열 그대로 — JSON 열 3개(actions·evidence_quotes·latest_quotes)는 문자열로 온다. */
export type Quote = { id: number; text: string; posted_at: string };
export type IssueAction = { text: string; quote_id: number | null; source: string };
export type Issue = {
  id: number; issue_key: string; rank_no: number;
  grp: string;                    // main(본 목록) | more(그 밖) | in_progress(조치 중) | done(조치 완료)
  label: string; zone_id: number | null; zone_name: string | null;   // zone null = 구역 미상
  grade: string; is_safety: number;
  type_score: number; conc: number; rec: number; card_score: number; formula: string;
  freq: number; type_freq: number; last_at: string;
  same_zone_others: number; recurred: number;
  new_since_request?: number;   // 요청서를 만든 뒤 새 구역이 생겼으면 1 (서버가 추가 예정)
  action_status: string | null; action_request_id: number | null;
  department: string | null; contact: string | null;
  title: string; needs_judgment: number;
  text_source: string; text_updated_at: string; updated_at: string;
  actions: string | IssueAction[]; evidence_quotes: string | Quote[]; latest_quotes: string | Quote[];
};

export type ControlData = {
  sev: Severity[]; briefing: Briefing | null; feed: FeedItem[];
  pending: number; total: number; alerts: Alert[];
  /** 운영자 확인 필요(유형 없음) 개수 · 그중 안전 의심. 서버가 아직 안 주면 없다 (D5-26 ④) */
  review?: number; review_safety?: number;
  /** 조치할 일 카드 (D5-29) — 서버가 rank_no 순서로 준다. 없으면(구버전 서버) 옛 유형 화면을 쓴다. */
  issues?: Issue[];
  /** 운영자가 지운(숨긴) 민원 개수 (D5-30) */
  deleted?: number;
};
export type ActionData = { sev: Severity[]; actions: Action[]; jobs: DocJob[] };

export type Handlers = {
  onChange: () => void;
  onAlert: (a: Alert) => void;
  onDocDone: (j: { label: string }) => void;
  onStatus: (connected: boolean) => void;
};

export interface Backend {
  name: "local" | "supabase";
  zones(): Promise<Zone[]>;
  /** 축제 이름 — 방문객 접수 화면 머리글에 쓴다 */
  festival(): Promise<string>;
  control(): Promise<ControlData>;
  action(): Promise<ActionData>;
  /** 접수번호를 돌려준다 */
  submitFeedback(zoneId: number, text: string): Promise<number>;
  // ── 관리자 동작 (D5-31) — 운영자 코드가 맞을 때만 서버가 실행한다.
  // 화면은 code 를 넘기지 않고 그대로 부른다. `api` 가 gateAdmin(admin.ts)으로 감싸져 있어 처음 누를 때 코드를 묻고,
  // 이 계층(data-local · data-supabase)은 마지막 인자 code 를 헤더(X-Admin-Code) / RPC 인자(p_code)로 서버에 싣는다.
  // 거부되면 AdminDenied(wrong 401 · unset 403 · locked 429)를 던진다.
  /** 코드가 맞는지만 확인 (입력 창용). 틀리면 AdminDenied. */
  checkAdmin(code: string): Promise<void>;
  requestDoc(label: string, code?: string): Promise<number>;
  setActionStatus(id: number, status: string, code?: string): Promise<void>;
  /** 관제에서 민원을 지운다(숨김). 되돌릴 수 있다 (D5-30) */
  deleteFeedback(id: number, code?: string): Promise<void>;
  restoreFeedback(id: number, code?: string): Promise<void>;
  subscribe(h: Handlers): void;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// 관리자 동작에는 문을 건다 (처음 누를 때 운영자 코드 입력). 읽기·접수(submit_feedback)는 그대로 지나간다.
export const api: Backend = gateAdmin(url && key ? supabaseBackend(url, key) : localBackend());

let zoneCache: Zone[] | null = null;
export async function zones(): Promise<Zone[]> {
  zoneCache ??= await api.zones();
  return zoneCache;
}
