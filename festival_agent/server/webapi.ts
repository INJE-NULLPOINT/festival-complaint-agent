// 웹 앱용 local 대역 API — Supabase 키가 없을 때 쓴다. 제출본 아님. (webapi.py 와 1:1 — 엔드포인트·응답·보안 동작이 같다)
//
// 왜 있나
//   웹 화면(web/)은 원래 Supabase(PostgREST · RPC · Realtime)에 직접 붙는다. 키가 아직 없어서, 같은 동작을 SQLite(festival.db) 위에서 흉내 낸다.
//
// 흉내 내는 것
//   읽기        GET  /api/zones · /api/control · /api/action · /api/festival
//   파일        GET  /api/docs/<파일명>  — DOCS_DIR(기본 output/)의 조치요청서 DOCX (Storage 대역)
//   쓰기(RPC)   POST /api/rpc/<이름> — supabase/schema.sql 의 같은 이름 함수와 검증 규칙이 같다
//   관리자 읽기 GET  /api/deleted (X-Admin-Code) — 최근 지운 민원
//   실시간      GET  /api/events  (SSE) — 1초마다 테이블 지문을 비교해 알린다
//
// 지키는 규칙 (Supabase 와 동일)
//   민원은 feedback_inbox 에만 넣는다. 마스킹은 워커(db.pull_inbox)가 한다.
//   조치요청서는 doc_job 에 요청만 넣는다. 작성은 워커(doc_jobs)가 한다.
//
// 보안 동작 (webapi.py 와 같다): 운영자 코드(헤더 X-Admin-Code 또는 본문 p_code, 틀리면 401 · 미설정 403 · 잠김 429, 출처별) ·
//   X-Forwarded-For(접속자가 루프백일 때만, 맨 오른쪽 값) · 본문 16KB 상한(413)·음수 길이 400 · POST 는 application/json 만(415) ·
//   400/500 은 고정 문구(상세는 콘솔) · SSE 동시 50개 상한(503)·최대 30분·끊기면 바로 자리 반환 · 요청 읽기 제한 시간 ·
//   같은 포트 중복 실행 거부 · 대기열(backlog) 128.
//
// 실행
//   node server/webapi.ts              # 127.0.0.1:8765
//   node server/webapi.ts --port 9000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import * as admin from "./core/admin.ts";
import { BASE_DIR, config } from "./core/config.ts";
import * as db from "./core/db.ts";
import * as intake from "./core/intake.ts";
import * as issues from "./core/issues.ts";
import * as llm from "./core/llm.ts";
import * as privacy from "./core/privacy.ts";
import * as review from "./core/review.ts";
import * as source_id from "./core/source_id.ts";

const BACKEND = "local";
const STATUSES = ["requested", "in_progress", "done"];
export const DOCS_DIR = path.resolve(process.env.DOCS_DIR || path.join(BASE_DIR, "output"));   // 시험은 DOCS_DIR 로 테스트 전용 폴더를 쓴다(운영 output/ 을 건드리지 않게)
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const KST_OFFSET_MS = 9 * 3600_000;   // schema.sql 의 now() at time zone 'Asia/Seoul'

export function seoul_now(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 19);
}

export class ApiError extends Error {}
/** Python 의 TypeError/ValueError 자리 — 모르는 인자·빠진 인자·잘못된 JSON. 응답은 고정 문구로 나간다. */
export class BadRequest extends Error {}

type Row = Record<string, any>;

async function _rows(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
  const conn = await db.connect();
  const cur = await conn.execute(sql, params);
  return cur.fetchall().map((r) => ({ ...r }));
}
async function _one(sql: string, params: readonly unknown[] = []): Promise<Row | null> {
  const rows = await _rows(sql, params);
  return rows.length ? rows[0] : null;
}

/** Python 의 KeyError·ValueError — core 모듈들이 던지는 클래스가 달라도(같은 이름) 이름으로 구분한다 */
const isKind = (e: unknown, name: string): boolean => (e as Error)?.name === name;

/** Python int(x) — 숫자·불리언·정수 문자열만. 그 밖은 TypeError/ValueError 와 같이 던진다. */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  throw new BadRequest("int");
}

/** Python urllib.parse.quote — 글자·숫자와 _.-~/ 만 그대로 둔다 */
function quote(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// ── 읽기 ──────────────────────────────────────────────────────────

export async function latest_severity(): Promise<Row[]> {
  // 가장 최근 심각도 스냅샷 한 묶음. 워커가 분류 직후마다 남긴다.
  // data-supabase.ts 와 같은 방식: 최근 40행에서 첫 행의 as_of 만 고른다.
  const rows = await _rows("SELECT * FROM severity ORDER BY id DESC LIMIT 40");
  if (!rows.length) return [];
  const as_of = rows[0].as_of, window = rows[0].window;
  // 같은 초에 스냅샷이 겹치거나(워커·②감시) 창 길이가 다른 판정이 섞일 수 있다.
  // 가장 최근 행과 같은 as_of·창만 쓰고, 유형마다 최신 행(id 큰 쪽) 하나만 쓴다.
  const latest = new Map<string, Row>();
  for (const r of rows) if (r.as_of === as_of && r.window === window && !latest.has(r.label)) latest.set(r.label, r);
  // 등급 → 안전 계열 먼저 → 점수 (core/severity.rank_labels·관제 카드와 같은 순서)
  const order: Record<string, number> = { immediate: 0, high: 1, mid: 2, low: 3 };
  const safe = (r: Row) => Number((r.safety_w || 1) > 1);
  return [...latest.values()].sort((a, b) =>
    (order[a.grade] ?? 4) - (order[b.grade] ?? 4) || safe(b) - safe(a) || b.score - a.score);
}

export async function get_zones(): Promise<Row[]> {
  return _rows("SELECT id, name FROM zone ORDER BY id");
}

export async function get_festival(): Promise<Row | null> {
  // 방문객 접수 화면 머리글용. Supabase 에서는 festival 테이블 anon 읽기.
  return _one("SELECT name FROM festival ORDER BY id LIMIT 1");
}

export async function get_control(): Promise<Row> {
  return {
    sev: await latest_severity(),
    briefing: await _one("SELECT * FROM briefing ORDER BY id DESC LIMIT 1"),
    feed: await _rows(
      `SELECT f.id, f.raw_text, f.ingested_at, f.zone_id, c.label, c.status,
              (SELECT MAX(i.id) FROM feedback_inbox i WHERE i.feedback_id = f.id) receipt_no
       FROM feedback f LEFT JOIN classification c ON c.feedback_id = f.id
       WHERE f.deleted_at IS NULL
       ORDER BY f.id DESC LIMIT 10`),
    pending: await db.pending_count(),
    review: await db.review_count(),
    review_safety: await db.review_safety_count(),     // 확인 필요 중 안전 의심
    // 운영자가 처리할 확인 필요 목록 (안전 의심 먼저 · 오래된 것 먼저 · 최대 20건). 모델 제안은 suggested_label 열.
    review_items: await review.items(20),
    // 관제 '지금 조치할 일' 카드 (화면 순서). issue 표의 열 그대로 — Supabase 에서도 같은 모양.
    // actions·evidence_quotes·latest_quotes 는 JSON 문자열, grp: main|more|in_progress|done
    issues: await issues.list_active(),
    total: (await _one("SELECT COUNT(*) n FROM feedback WHERE deleted_at IS NULL"))!.n,
    deleted: await db.deleted_count(),                 // 운영자가 지운(숨긴) 민원 수 — 되돌리기용
    crowding: await intake.zone_burst(),                // 한 구역에 접수가 몰림 — 차단 없이 표시만 (D5-33 ③)
    backend_llm: llm.backend(),                         // 헤더 표시용: claude_code | anthropic | local (webapi 프로세스 기준)
    synthetic: await db.synthetic_in_window(),          // 창 안에 replay/demo/dev 합성 민원이 있으면 on=true + count
    alerts: await _rows("SELECT * FROM alert WHERE acked=0 ORDER BY id DESC LIMIT 3"),
  };
}

export async function get_action(): Promise<Row> {
  const actions = await _rows("SELECT * FROM action_request ORDER BY id DESC LIMIT 15");
  for (const a of actions) {
    // Storage 대역 URL 이 생기기 전에 만든 요청서도 DOCX 버튼이 뜨게 한다
    if (!a.doc_url && a.doc_path) {
      const name = path.basename(String(a.doc_path).replace(/\\/g, "/"));
      if (isFile(path.join(DOCS_DIR, name))) a.doc_url = `/api/docs/${quote(name)}`;
    }
  }
  return {
    sev: await latest_severity(),
    actions,
    jobs: await _rows("SELECT * FROM doc_job ORDER BY id DESC LIMIT 30"),
  };
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ── 쓰기 (schema.sql 의 RPC 와 같은 규칙) ─────────────────────────

export async function submit_feedback(p_zone_id: unknown, p_text: unknown, source: string | null = null): Promise<number | null> {
  // schema.sql: 한글·영문·숫자 2개 미만 → 거절, length(p_text) > 500 → 거절, zone 존재
  // 내용 규칙은 core/privacy.has_content 와 같다 ('...' 'ㅋㅋ' '!!!!' 거부)
  if (typeof p_text !== "string" || !privacy.has_content(p_text)) throw new ApiError(privacy.NEED_MORE);
  if ([...p_text].length > 500) throw new ApiError("500자 이내로 적어 주세요");
  let zone_id: number;
  try { zone_id = pyInt(p_zone_id); } catch { throw new ApiError("구역을 선택해 주세요"); }
  if (!(await _one("SELECT id FROM zone WHERE id=?", [zone_id]))) throw new ApiError("구역을 선택해 주세요");
  // D5-33: ②출처별 폭주 제한 → ①같은 글 합치기 → 저장을 intake.accept 가 한 덩어리로(락) 한다 —
  // 같은 글을 동시에 두 번 눌러도 한 건이 된다. (source 는 접속 주소의 하루 해시, 모르면 ② 건너뜀. 합쳐진 글은 같은 접수번호로 성공 응답)
  try {
    return await intake.accept(zone_id, p_text.replace(/^ +| +$/g, ""), source);
  } catch (e) {
    if (e instanceof intake.RateLimited) throw new ApiError(e.message);
    throw e;
  }
}

export async function request_doc(p_label: unknown): Promise<number> {
  if (!(await _one("SELECT label FROM department_map WHERE label=?", [p_label]))) throw new ApiError(`모르는 민원 유형입니다: ${p_label}`);
  const busy = await _one("SELECT id FROM doc_job WHERE label=? AND status IN ('queued','running') LIMIT 1", [p_label]);
  if (busy) return busy.id;
  const conn = await db.connect();
  const cur = await conn.execute("INSERT INTO doc_job (label, created_at) VALUES (?,?)", [p_label, seoul_now()]);
  await conn.commit();
  return cur.lastrowid as number;
}

export async function set_action_status(p_id: unknown, p_status: unknown): Promise<null> {
  if (!STATUSES.includes(p_status as string)) throw new ApiError(`잘못된 상태: ${p_status}`);
  const conn = await db.connect();
  await conn.execute("UPDATE action_request SET status=?, closed_at=? WHERE id=?", [p_status, p_status === "done" ? seoul_now() : null, p_id]);
  await conn.commit();
  return null;
}

async function _set_deleted(p_id: unknown, deleted: boolean): Promise<null> {
  let fid: number;
  try { fid = pyInt(p_id); } catch { throw new ApiError("없는 민원입니다"); }
  try {
    await db.set_feedback_deleted(fid, deleted, seoul_now());
  } catch (e) {
    if (isKind(e, "KeyError")) throw new ApiError("없는 민원입니다");
    throw e;
  }
  return null;
}
/** 민원 1건 숨김 (되돌리기 가능). schema.sql delete_feedback 과 같은 규칙: 없는 id 는 오류. */
export const delete_feedback = (p_id: unknown) => _set_deleted(p_id, true);
/** 지운 민원 되돌리기. 없는 id 는 오류, 살아 있는 민원은 그대로 (멱등). */
export const restore_feedback = (p_id: unknown) => _set_deleted(p_id, false);

/** 확인 필요 처리 RPC 공통 — 입력 검증과 오류 메시지를 schema.sql 의 같은 이름 RPC 와 맞춘다. */
async function _review_call(fn: (fid: number, ...a: any[]) => Promise<unknown>, p_id: unknown, ...args: unknown[]): Promise<null> {
  let fid: number;
  try { fid = pyInt(p_id); } catch { throw new ApiError(review.MSG_MISSING); }
  try {
    await fn(fid, ...args);
  } catch (e) {
    if (isKind(e, "KeyError")) throw new ApiError(review.MSG_MISSING);
    if (isKind(e, "ValueError")) throw new ApiError((e as Error).message);   // Python 의 ValueError(사용자용 문구)
    throw e;
  }
  return null;
}
/** 확인 필요 → 운영자가 유형 지정 (status='review' 일 때만). 안전·혼잡을 고르면 안전 의심 자동. */
export const resolve_review = (p_id: unknown, p_label: unknown, p_is_safety: unknown = null) => _review_call(review.resolve, p_id, p_label, p_is_safety, seoul_now());
/** 확인 필요 → 유형 없음으로 닫기 (status='review' 일 때만). */
export const dismiss_review = (p_id: unknown) => _review_call(review.dismiss, p_id, seoul_now());
/** 닫은 것·운영자가 지정한 것을 다시 확인 필요로 (되돌리기). */
export const reopen_review = (p_id: unknown) => _review_call(review.reopen, p_id);

/** 최근에 지운 민원 (되돌리기용 목록, D5-42). 운영자 코드가 필요하다(ADMIN_RPC). schema.sql 의 list_deleted(p_code) 와 같은 모양 {ok, items}.
 *  원문은 접수 때 이미 마스킹된 것이다. 지운 시각 최신순, 기본 50건(최대 200). */
export async function list_deleted(p_limit: unknown = 50): Promise<Row> {
  let n: number;
  try { n = pyInt(p_limit); } catch { n = 50; }
  return { ok: true, items: await db.list_deleted(n) };
}

/** 운영자 코드가 맞는지만 확인한다 (코드 입력 창용). 검사는 call_rpc 가 한다. */
export async function check_admin(): Promise<boolean> {
  return true;
}

// RPC 표: [함수, 필수 인자, 선택 인자]. 모르는 인자·빠진 필수 인자는 Python 의 TypeError 처럼 BadRequest → 400 고정 문구.
type RpcSpec = [(...a: any[]) => Promise<unknown>, string[], string[]];
export const RPC: Record<string, RpcSpec> = {
  submit_feedback: [submit_feedback, ["p_zone_id", "p_text"], []],
  request_doc: [request_doc, ["p_label"], []],
  set_action_status: [set_action_status, ["p_id", "p_status"], []],
  delete_feedback: [delete_feedback, ["p_id"], []],
  restore_feedback: [restore_feedback, ["p_id"], []],
  resolve_review: [resolve_review, ["p_id", "p_label"], ["p_is_safety"]],
  dismiss_review: [dismiss_review, ["p_id"], []],
  reopen_review: [reopen_review, ["p_id"], []],
  list_deleted: [list_deleted, [], ["p_limit"]],
  check_admin: [check_admin, [], []],
};
// 관리자 동작 — 운영자 코드(X-Admin-Code 헤더 또는 p_code)가 맞을 때만 실행한다 (D5-31).
// 방문객이 쓰는 것은 submit_feedback 하나뿐이다. schema.sql 의 같은 이름 RPC 는 p_code 인자로 같은 검사를 한다.
const MAX_BODY = 16 * 1024;          // POST 본문 상한 (바이트)
const MAX_SSE = Number(process.env.WEBAPI_MAX_SSE) || 50;                      // 동시 실시간(SSE) 연결 상한 (D5-40 ④)
const SSE_MAX_SECONDS = Number(process.env.WEBAPI_SSE_MAX_SECONDS) || 1800;    // 한 연결 최대 유지 시간 — 끊으면 브라우저가 다시 붙는다
const REQUEST_TIMEOUT = Number(process.env.WEBAPI_REQUEST_TIMEOUT) || 30;      // 요청을 읽는 동안 이 시간 안에 안 오면 끊는다 (느린 연결로 자리를 잡아 두는 것 방지)
let _sse_open = 0;

/** 자세한 오류는 콘솔(로그)에만 남기고 응답에는 고정 문구만 보낸다 (경로·SQL 조각이 새지 않게, D5-40 ③). */
function _log_error(where: string, e: unknown): void {
  const err = e as Error;
  console.error(`[webapi] 오류 ${where}: ${err?.name ?? "Error"}: ${err?.message ?? e}`);
}
export const ADMIN_RPC = new Set(["request_doc", "set_action_status", "delete_feedback", "restore_feedback",
  "resolve_review", "dismiss_review", "reopen_review", "list_deleted", "check_admin"]);

/** RPC 하나를 실행한다. 관리자 동작이면 먼저 운영자 코드를 검사한다.
 *  코드 거부는 admin.AdminError(status 401/403/429), 검증 오류는 ApiError, 모르는 인자는 BadRequest.
 *  코드는 헤더(code)나 본문의 p_code 로 받는다 (Supabase RPC 와 같은 인자 이름).
 *  source 는 접속 주소의 하루짜리 해시 — 틀린 코드 횟수·잠금을 출처별로 센다 (D5-40). */
export async function call_rpc(name: string, args: Row, code: string | null = null, source: string | null = null): Promise<unknown> {
  const a: Row = { ...(args ?? {}) };
  const body_code = a.p_code ?? null;
  delete a.p_code;
  const [fn, required, optional] = RPC[name];
  if (ADMIN_RPC.has(name)) await admin.verify(code ? code : body_code, source);
  const known = new Set([...required, ...optional]);
  for (const k of Object.keys(a)) if (!known.has(k)) throw new BadRequest(`unexpected keyword argument '${k}'`);
  for (const k of required) if (!(k in a)) throw new BadRequest(`missing argument '${k}'`);
  const vals = [...required, ...optional].filter((k) => k in a).map((k) => a[k]);
  if (name === "submit_feedback") return fn(a.p_zone_id, a.p_text, source);   // 출처별 폭주 제한용 (D5-33 ②)
  return fn(...vals);
}

const GET: Record<string, () => Promise<unknown>> = {
  "/api/zones": get_zones,
  "/api/festival": get_festival,
  "/api/control": get_control,
  "/api/action": get_action,
};

// ── 실시간 대역 ───────────────────────────────────────────────────

let _fp_cache: { at: number; value: unknown[]; pending: Promise<unknown[]> | null } | null = null;

/** SSE 연결마다 1초에 한 번 DB 를 훑으면 접속자 수만큼 DB 일이 늘어난다 (D5-37).
 *  0.8초 안에 누가 이미 계산했다면 그 값을 같이 쓴다 → 접속자가 늘어도 초당 DB 조회는 한 번. (동시에 부르면 한 번만 계산한다) */
export async function shared_fingerprint(max_age = 0.8): Promise<unknown[]> {
  const now = performance.now() / 1000;
  if (_fp_cache?.pending) return _fp_cache.pending;
  if (!_fp_cache || now - _fp_cache.at >= max_age) {
    const prev = _fp_cache;
    const pending = fingerprint().then((v) => { _fp_cache = { at: performance.now() / 1000, value: v, pending: null }; return v; },
      (e) => { _fp_cache = prev ? { ...prev, pending: null } : null; throw e; });
    _fp_cache = { at: prev?.at ?? 0, value: prev?.value ?? [], pending };
    return pending;
  }
  return _fp_cache.value;
}

/** 화면에 영향을 주는 변화를 한 줄로 요약한다. 값이 바뀌면 다시 그린다. */
export async function fingerprint(): Promise<unknown[]> {
  const conn = await db.connect();
  const q = async (sql: string) => Object.values((await conn.execute(sql)).fetchone() ?? {});
  return [
    await q("SELECT MAX(id), COUNT(*), COUNT(deleted_at), MAX(deleted_at) FROM feedback"),   // 개수만 보면 '되돌리기 + 새 삭제'가 1초 안에 겹칠 때 놓친다 → 지운 시각의 최댓값도
    await q("SELECT COUNT(*) FROM classification WHERE status='pending'"),
    // 확인 필요 처리(유형 지정·닫기·되돌리기)가 화면에 바로 반영되도록
    await q("SELECT COUNT(*), COUNT(reviewed_at), MAX(reviewed_at), COALESCE(SUM(CASE status WHEN 'review' THEN 1 "
      + "WHEN 'dismissed' THEN 2 ELSE 0 END), 0) FROM classification"),
    await q("SELECT MAX(id) FROM severity"),
    await q("SELECT MAX(id) FROM briefing"),
    await q("SELECT COUNT(*), MAX(updated_at), SUM(active) FROM issue"),
    // GROUP_CONCAT 은 SQLite 전용이다. 상태를 숫자로 바꿔 id 와 곱해 더하면
    // 어느 행의 상태가 바뀌어도 값이 달라진다 (SQLite·Postgres 공용).
    await q("SELECT MAX(id), COUNT(*), SUM(id * CASE status WHEN 'requested' THEN 1 "
      + "WHEN 'in_progress' THEN 2 WHEN 'done' THEN 3 ELSE 4 END), MAX(closed_at) "
      + "FROM (SELECT id, status, closed_at FROM action_request "
      + "ORDER BY id DESC LIMIT 15) t"),
    await q("SELECT MAX(id), COUNT(*), SUM(id * CASE status WHEN 'queued' THEN 1 "
      + "WHEN 'running' THEN 2 WHEN 'done' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END) "
      + "FROM (SELECT id, status FROM doc_job ORDER BY id DESC LIMIT 30) t"),
  ];
}

async function max_id(table: string): Promise<number> {
  return ((await _one(`SELECT MAX(id) m FROM ${table}`)) ?? {}).m || 0;
}

// ── HTTP ──────────────────────────────────────────────────────────

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

function send(res: Res, code: number, body: unknown, closeAfter = false): void {
  const data = Buffer.from(JSON.stringify(body), "utf-8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "X-Backend": BACKEND,
    ...(closeAfter ? { Connection: "close" } : {}),
  });
  res.end(data);
  if (closeAfter) res.on("finish", () => res.socket?.destroy());
}

function clientSource(req: Req): string {
  // 헤더가 여러 줄이어도 맨 오른쪽이 마지막 (Node 는 같은 이름의 헤더를 ", " 로 합쳐 준다)
  const xff = req.headers["x-forwarded-for"];
  return source_id.client_source(req.socket.remoteAddress ?? null, Array.isArray(xff) ? xff.join(",") : (xff ?? ""));
}
const header = (req: Req, name: string): string | null => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : (v ?? null);
};

async function adminGet(req: Req, res: Res, rpcName: string): Promise<void> {
  try {
    const data = (await call_rpc(rpcName, {}, header(req, "x-admin-code"), clientSource(req))) as Row;
    send(res, 200, { backend: BACKEND, data: data.items });
  } catch (e) {
    if (e instanceof admin.AdminError) return send(res, e.status, { error: e.message });   // 401 · 403 · 429 — POST 와 같은 규칙
    _log_error(`GET ${rpcName}`, e);
    send(res, 500, { error: "서버 오류" });
  }
}

async function doGet(req: Req, res: Res): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  if (pathname === "/api/events") return events(req, res);
  if (pathname.startsWith("/api/docs/")) return doc(res, safeDecode(pathname.slice("/api/docs/".length)));
  if (pathname === "/api/deleted") return adminGet(req, res, "list_deleted");   // 관리자 전용 읽기 — X-Admin-Code 헤더 (한글 코드는 POST /api/rpc/list_deleted 의 p_code)
  const fn = GET[pathname];
  if (!fn) return send(res, 404, { error: "없는 경로" });
  try {
    send(res, 200, { backend: BACKEND, data: await fn() });
  } catch (e) {
    _log_error(`GET ${pathname}`, e);
    send(res, 500, { error: "서버 오류" });
  }
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 요청 본문을 최대 MAX_BODY 바이트까지 읽는다. 넘으면 null. */
function readBody(req: Req): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("aborted")));
  });
}

async function doPost(req: Req, res: Res): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  const name = pathname.startsWith("/api/rpc/") ? pathname.slice("/api/rpc/".length) : pathname;
  // 본문은 라우팅보다 먼저 끝까지 읽는다 — 안 읽고 답하면 연결이 끊겨 간헐 오류가 난다.
  // 크기는 0~16KB (접수는 500자라 충분). 음수·과대 값은 읽지 않고 거절한다 (D5-40 ②).
  // (Content-Length 가 숫자가 아니거나 음수인 요청은 Node 의 HTTP 파서가 읽기 전에 400 으로 끊는다.)
  const cl = header(req, "content-length");
  const n = cl === null || cl === "" ? 0 : Number(cl);
  if (!Number.isInteger(n) || n < 0) return send(res, 400, { error: "요청 형식이 올바르지 않습니다" }, true);
  if (n > MAX_BODY) return send(res, 413, { error: "요청이 너무 큽니다" }, true);
  let raw: Buffer | null;
  try { raw = await readBody(req); } catch { return; }
  if (raw === null) return send(res, 413, { error: "요청이 너무 큽니다" }, true);
  if (!pathname.startsWith("/api/rpc/") || !(name in RPC)) return send(res, 404, { error: "없는 함수" });
  // 다른 사이트의 <form>·text/plain '단순 요청'이 접수를 실행하지 못하게 JSON 만 받는다 (브라우저는 JSON 이면 교차 출처 POST 전에 사전 확인을 해서 막힌다, D5-40 ⑥)
  if (!(header(req, "content-type") ?? "").toLowerCase().startsWith("application/json")) return send(res, 415, { error: "application/json 으로 보내 주세요" });
  try {
    let args: unknown;
    try { args = raw.length ? JSON.parse(raw.toString("utf-8")) : {}; } catch { throw new BadRequest("json"); }
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ApiError("요청 형식이 올바르지 않습니다");
    const data = await call_rpc(name, args as Row, header(req, "x-admin-code"), clientSource(req));
    send(res, 200, { backend: BACKEND, data });
  } catch (e) {
    if (e instanceof admin.AdminError) return send(res, e.status, { error: e.message });   // 401 코드 없음·틀림 · 403 코드 미설정 · 429 잠김
    if (e instanceof ApiError) return send(res, 400, { error: e.message });                // 입력 검사 문구(사용자에게 보여 줄 문장)
    if (e instanceof BadRequest) { _log_error(`POST ${pathname}`, e); return send(res, 400, { error: "요청 형식이 올바르지 않습니다" }); }   // 모르는 인자 · 잘못된 JSON — 고정 문구
    _log_error(`POST ${pathname}`, e);
    send(res, 500, { error: "서버 오류" });
  }
}

/** DOCS_DIR 의 DOCX 만 내준다. 경로 탈출(../, 절대경로, 하위 폴더)은 막는다. */
function doc(res: Res, name: string): void {
  const target = path.resolve(DOCS_DIR, name);
  if (!name || /[\\/]/.test(name) || name !== path.basename(name) || !name.endsWith(".docx")
      || path.dirname(target) !== DOCS_DIR || !isFile(target)) return send(res, 404, { error: "없는 문서" });
  const data = fs.readFileSync(target);
  res.writeHead(200, {
    "Content-Type": DOCX_TYPE,
    "Content-Length": data.length,
    "Content-Disposition": `attachment; filename*=UTF-8''${quote(name)}`,
    "X-Backend": BACKEND,
  });
  res.end(data);
}

async function events(req: Req, res: Res): Promise<void> {
  if (_sse_open >= MAX_SSE) {                        // 상한: 연결·DB 조회가 접속자 수만큼 늘어나는 것을 막는다 (D5-40 ④)
    return send(res, 503, { error: "연결이 너무 많습니다. 잠시 뒤 다시 시도해 주세요" });
  }
  _sse_open++;
  let gone = false;
  req.on("close", () => { gone = true; });          // 브라우저가 닫으면 바로 자리를 돌려준다
  try {
    // Python 처럼 '연결이 닫힐 때까지가 본문'인 응답(청크 없음)으로 보낸다. 청크 응답은 프록시(vite) 뒤에서 서버가 죽어도
    // 브라우저 쪽 연결이 끊긴 것으로 전달되지 않아 화면이 '실시간' 으로 남는다 (서버 껐다 켜기 시험에서 발견).
    res.useChunkedEncodingByDefault = false;
    res.shouldKeepAlive = false;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Backend": BACKEND, Connection: "close" });
    const emit = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    let last_fp = await shared_fingerprint(0);        // 처음 값은 새로 계산
    let last_alert = await max_id("alert");
    const done_jobs = new Set<number>((await _rows("SELECT id FROM doc_job WHERE status='done'")).map((r) => r.id));
    emit("ready", { backend: BACKEND });
    let idle = 0;
    const t_start = performance.now();
    while (performance.now() - t_start < SSE_MAX_SECONDS * 1000) {    // 오래 붙은 연결은 끊는다 — 브라우저가 스스로 다시 붙는다
      await new Promise((r) => setTimeout(r, 1000));
      if (gone || res.destroyed) break;
      const fp = await shared_fingerprint();
      if (JSON.stringify(fp) !== JSON.stringify(last_fp)) {
        last_fp = fp; idle = 0;
        for (const a of await _rows("SELECT * FROM alert WHERE id>? ORDER BY id", [last_alert])) {
          last_alert = a.id;
          emit("alert", a);
        }
        for (const j of await _rows("SELECT id, label FROM doc_job WHERE status='done'")) {
          if (!done_jobs.has(j.id)) { done_jobs.add(j.id); emit("doc_done", j); }
        }
        emit("change", {});
      } else if (++idle >= 15) {                     // 연결 유지
        idle = 0;
        res.write(": ping\n\n");
      }
    }
  } catch (e) {
    if (!gone) _log_error("GET /api/events", e);
  } finally {
    _sse_open--;
    if (!res.writableEnded) res.end();
  }
}

export function create_server(): http.Server {
  const server = http.createServer({
    requestTimeout: REQUEST_TIMEOUT * 1000,
    headersTimeout: REQUEST_TIMEOUT * 1000,
    connectionsCheckingInterval: 1000,       // 제한 시간 검사를 1초마다 (기본은 30초라 짧은 제한이 안 먹는다)
  }, (req, res) => {
    const run = req.method === "POST" ? doPost : req.method === "GET" ? doGet : null;
    if (!run) return send(res, 501, { error: "지원하지 않는 방식" });
    run(req, res).catch((e) => {
      _log_error(`${req.method} ${req.url}`, e);
      if (!res.headersSent) send(res, 500, { error: "서버 오류" }); else res.end();
    });
  });
  return server;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8765" } } });
  const host = values.host as string, port = Number(values.port);
  if (db.is_pg()) {
    console.log("[webapi] SUPABASE_DB_URL 이 설정돼 있습니다. 웹은 Supabase 에 직접 붙이세요 (web/.env). 이 서버는 local 대역입니다.");
  }
  const srv = create_server();
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen({ host, port, backlog: 128, exclusive: true }, () => resolve());    // backlog: 방문객이 한꺼번에 접속해도 거부되지 않게
    });
  } catch {
    console.error(`[webapi] ${host}:${port} 에 이미 서버가 실행 중입니다. 그 서버를 쓰거나 --port 로 다른 포트를 지정하세요.`);
    process.exit(1);
  }
  await db.init_db();
  if (!config.ADMIN_CODE) {
    console.log("[webapi] ADMIN_CODE 가 비어 있어 관리자 동작(민원 지우기·조치 상태 변경·요청서 생성)을 .env 에 코드를 넣기 전까지 모두 거부합니다.");
  }
  console.log(`[webapi] local 대역 · http://${host}:${port}  (DB ${config.DB_PATH})`);
  process.on("SIGINT", () => { console.log("\n[webapi] 종료"); process.exit(0); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
