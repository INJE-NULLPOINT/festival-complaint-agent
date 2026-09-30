"""웹 앱용 local 대역 API — Supabase 키가 없을 때 쓴다. 제출본 아님.

왜 있나
  웹 화면(web/)은 원래 Supabase(PostgREST · RPC · Realtime)에 직접 붙는다.
  키가 아직 없어서, 같은 동작을 SQLite(festival.db) 위에서 흉내 낸다.
  LLM 의 local 대역(core/llm.py)과 같은 자리다.

흉내 내는 것
  읽기        GET  /api/zones · /api/control · /api/action
  파일        GET  /api/docs/<파일명>  — output/ 의 조치요청서 DOCX (Storage 대역)
  쓰기(RPC)   POST /api/rpc/submit_feedback · request_doc · set_action_status
              → supabase/schema.sql 의 같은 이름 함수와 검증 규칙이 같다
  실시간      GET  /api/events  (SSE) — 1초마다 테이블 지문을 비교해 알린다

지키는 규칙 (Supabase 와 동일)
  민원은 feedback_inbox 에만 넣는다. 마스킹은 워커(db.pull_inbox)가 한다.
  조치요청서는 doc_job 에 요청만 넣는다. 작성은 워커(doc_jobs)가 한다.

비활성 시점
  web/.env 에 VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY 를 넣으면 웹은 이 서버를
  더 이상 부르지 않는다. 파일은 지우지 않고 키 없는 환경용으로 남긴다 (할일 D5-9).

실행
    python webapi.py              # 127.0.0.1:8765
    python webapi.py --port 9000
"""
import argparse
import json
import os
import select
import socket
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from core import admin, config, db, intake, issues, llm, privacy, review, source_id

BACKEND = "local"
STATUSES = ("requested", "in_progress", "done")
DOCS_DIR = (Path(__file__).resolve().parent / "output").resolve()
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
KST = timezone(timedelta(hours=9))   # schema.sql 의 now() at time zone 'Asia/Seoul'


def seoul_now() -> str:
    return datetime.now(KST).strftime("%Y-%m-%dT%H:%M:%S")


class ApiError(Exception):
    pass


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    with db.connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _one(sql: str, params: tuple = ()) -> dict | None:
    rows = _rows(sql, params)
    return rows[0] if rows else None


# ── 읽기 ──────────────────────────────────────────────────────────

def latest_severity() -> list[dict]:
    """가장 최근 심각도 스냅샷 한 묶음. 워커가 분류 직후마다 남긴다.

    data-supabase.ts 와 같은 방식: 최근 40행에서 첫 행의 as_of 만 고른다.
    """
    rows = _rows("SELECT * FROM severity ORDER BY id DESC LIMIT 40")
    if not rows:
        return []
    as_of, window = rows[0]["as_of"], rows[0]["window"]
    # 같은 초에 스냅샷이 겹치거나(워커·②감시) 창 길이가 다른 판정이 섞일 수 있다.
    # 가장 최근 행과 같은 as_of·창만 쓰고, 유형마다 최신 행(id 큰 쪽) 하나만 쓴다.
    latest: dict[str, dict] = {}
    for r in rows:
        if r["as_of"] == as_of and r["window"] == window:
            latest.setdefault(r["label"], r)
    # 등급 → 안전 계열 먼저 → 점수 (core/severity.rank_labels·관제 카드와 같은 순서)
    order = {"immediate": 0, "high": 1, "mid": 2, "low": 3}
    return sorted(latest.values(),
                  key=lambda r: (order.get(r["grade"], 4), -int((r["safety_w"] or 1) > 1), -r["score"]))


def get_zones() -> list[dict]:
    return _rows("SELECT id, name FROM zone ORDER BY id")


def get_festival() -> dict | None:
    """방문객 접수 화면 머리글용. Supabase 에서는 festival 테이블 anon 읽기."""
    return _one("SELECT name FROM festival ORDER BY id LIMIT 1")


def get_control() -> dict:
    return {
        "sev": latest_severity(),
        "briefing": _one("SELECT * FROM briefing ORDER BY id DESC LIMIT 1"),
        "feed": _rows(
            """SELECT f.id, f.raw_text, f.ingested_at, f.zone_id, c.label, c.status,
                      (SELECT MAX(i.id) FROM feedback_inbox i WHERE i.feedback_id = f.id) receipt_no
               FROM feedback f LEFT JOIN classification c ON c.feedback_id = f.id
               WHERE f.deleted_at IS NULL
               ORDER BY f.id DESC LIMIT 10"""
        ),
        "pending": db.pending_count(),
        "review": db.review_count(),
        "review_safety": db.review_safety_count(),     # 확인 필요 중 안전 의심
        # 운영자가 처리할 확인 필요 목록 (안전 의심 먼저 · 오래된 것 먼저 · 최대 20건). 모델 제안은 suggested_label 열.
        "review_items": review.items(20),
        # 관제 '지금 조치할 일' 카드 (화면 순서). issue 표의 열 그대로 — Supabase 에서도 같은 모양.
        # actions·evidence_quotes·latest_quotes 는 JSON 문자열, grp: main|more|in_progress|done
        "issues": issues.list_active(),
        "total": _one("SELECT COUNT(*) n FROM feedback WHERE deleted_at IS NULL")["n"],
        "deleted": db.deleted_count(),                 # 운영자가 지운(숨긴) 민원 수 — 되돌리기용
        "crowding": intake.zone_burst(),                # 한 구역에 접수가 몰림 — 차단 없이 표시만 (D5-33 ③)
        "backend_llm": llm.backend(),                  # 헤더 표시용: claude_code | anthropic | local (webapi 프로세스 기준)
        "synthetic": db.synthetic_in_window(),         # 창 안에 replay/demo/dev 합성 민원이 있으면 on=true + count
        "alerts": _rows("SELECT * FROM alert WHERE acked=0 ORDER BY id DESC LIMIT 3"),
    }


def get_action() -> dict:
    actions = _rows("SELECT * FROM action_request ORDER BY id DESC LIMIT 15")
    for a in actions:
        # Storage 대역 URL 이 생기기 전에 만든 요청서도 DOCX 버튼이 뜨게 한다
        if not a.get("doc_url") and a.get("doc_path"):
            name = Path(a["doc_path"]).name
            if (DOCS_DIR / name).is_file():
                a["doc_url"] = f"/api/docs/{quote(name)}"
    return {
        "sev": latest_severity(),
        "actions": actions,
        "jobs": _rows("SELECT * FROM doc_job ORDER BY id DESC LIMIT 30"),
    }


# ── 쓰기 (schema.sql 의 RPC 와 같은 규칙) ─────────────────────────

def submit_feedback(p_zone_id, p_text, source: str | None = None) -> int:
    # schema.sql: 한글·영문·숫자 2개 미만 → 거절, length(p_text) > 500 → 거절, zone 존재
    # 내용 규칙은 core/privacy.has_content 와 같다 ('...' 'ㅋㅋ' '!!!!' 거부)
    if not isinstance(p_text, str) or not privacy.has_content(p_text):
        raise ApiError(privacy.NEED_MORE)
    if len(p_text) > 500:
        raise ApiError("500자 이내로 적어 주세요")
    try:
        zone_id = int(p_zone_id)
    except (TypeError, ValueError):
        raise ApiError("구역을 선택해 주세요")
    if not _one("SELECT id FROM zone WHERE id=?", (zone_id,)):
        raise ApiError("구역을 선택해 주세요")
    # D5-33: ②출처별 폭주 제한 → ①같은 글 합치기 → 저장을 intake.accept 가 한 덩어리로(락) 한다 —
    # 같은 글을 동시에 두 번 눌러도 한 건이 된다. (source 는 접속 주소의 하루 해시, 모르면 ② 건너뜀. 합쳐진 글은 같은 접수번호로 성공 응답)
    try:
        return intake.accept(zone_id, p_text.strip(" "), source)
    except intake.RateLimited as e:
        raise ApiError(str(e))


def request_doc(p_label) -> int:
    if not _one("SELECT label FROM department_map WHERE label=?", (p_label,)):
        raise ApiError(f"모르는 민원 유형입니다: {p_label}")
    busy = _one("SELECT id FROM doc_job WHERE label=? AND status IN ('queued','running') LIMIT 1",
                (p_label,))
    if busy:
        return busy["id"]
    with db.connect() as conn:
        cur = conn.execute("INSERT INTO doc_job (label, created_at) VALUES (?,?)",
                           (p_label, seoul_now()))
        conn.commit()
        return cur.lastrowid


def set_action_status(p_id, p_status) -> None:
    if p_status not in STATUSES:
        raise ApiError(f"잘못된 상태: {p_status}")
    with db.connect() as conn:
        conn.execute("UPDATE action_request SET status=?, closed_at=? WHERE id=?",
                     (p_status, seoul_now() if p_status == "done" else None, p_id))
        conn.commit()


def delete_feedback(p_id) -> None:
    """민원 1건 숨김 (되돌리기 가능). schema.sql delete_feedback 과 같은 규칙: 없는 id 는 오류."""
    _set_deleted(p_id, True)


def restore_feedback(p_id) -> None:
    """지운 민원 되돌리기. 없는 id 는 오류, 살아 있는 민원은 그대로 (멱등)."""
    _set_deleted(p_id, False)


def _set_deleted(p_id, deleted: bool) -> None:
    try:
        fid = int(p_id)
    except (TypeError, ValueError):
        raise ApiError("없는 민원입니다")
    try:
        db.set_feedback_deleted(fid, deleted, seoul_now())
    except KeyError:
        raise ApiError("없는 민원입니다")


def _review_call(fn, p_id, *args):
    """확인 필요 처리 RPC 공통 — 입력 검증과 오류 메시지를 schema.sql 의 같은 이름 RPC 와 맞춘다."""
    try:
        fid = int(p_id)
    except (TypeError, ValueError):
        raise ApiError(review.MSG_MISSING)
    try:
        fn(fid, *args)
    except KeyError:
        raise ApiError(review.MSG_MISSING)
    except ValueError as e:
        raise ApiError(str(e))


def resolve_review(p_id, p_label, p_is_safety=None) -> None:
    """확인 필요 → 운영자가 유형 지정 (status='review' 일 때만). 안전·혼잡을 고르면 안전 의심 자동."""
    _review_call(review.resolve, p_id, p_label, p_is_safety, seoul_now())


def dismiss_review(p_id) -> None:
    """확인 필요 → 유형 없음으로 닫기 (status='review' 일 때만)."""
    _review_call(review.dismiss, p_id, seoul_now())


def reopen_review(p_id) -> None:
    """닫은 것·운영자가 지정한 것을 다시 확인 필요로 (되돌리기)."""
    _review_call(review.reopen, p_id)


def list_deleted(p_limit=50) -> dict:
    """최근에 지운 민원 (되돌리기용 목록, D5-42). 운영자 코드가 필요하다(ADMIN_RPC). schema.sql 의 list_deleted(p_code) 와 같은 모양 {ok, items}.
    원문은 접수 때 이미 마스킹된 것이다. 지운 시각 최신순, 기본 50건(최대 200)."""
    try:
        n = int(p_limit)
    except (TypeError, ValueError):
        n = 50
    return {"ok": True, "items": db.list_deleted(n)}


def check_admin() -> bool:
    """운영자 코드가 맞는지만 확인한다 (코드 입력 창용). 검사는 call_rpc 가 한다."""
    return True


RPC = {
    "submit_feedback": submit_feedback,
    "request_doc": request_doc,
    "set_action_status": set_action_status,
    "delete_feedback": delete_feedback,
    "restore_feedback": restore_feedback,
    "resolve_review": resolve_review,
    "dismiss_review": dismiss_review,
    "reopen_review": reopen_review,
    "list_deleted": list_deleted,
    "check_admin": check_admin,
}
# 관리자 동작 — 운영자 코드(X-Admin-Code 헤더 또는 p_code)가 맞을 때만 실행한다 (D5-31).
# 방문객이 쓰는 것은 submit_feedback 하나뿐이다. schema.sql 의 같은 이름 RPC 는 p_code 인자로 같은 검사를 한다.
MAX_BODY = 16 * 1024          # POST 본문 상한 (바이트)
MAX_SSE = int(os.environ.get("WEBAPI_MAX_SSE") or 50)                 # 동시 실시간(SSE) 연결 상한 (D5-40 ④)
SSE_MAX_SECONDS = int(os.environ.get("WEBAPI_SSE_MAX_SECONDS") or 1800)   # 한 연결 최대 유지 시간 — 끊으면 브라우저가 다시 붙는다
REQUEST_TIMEOUT = float(os.environ.get("WEBAPI_REQUEST_TIMEOUT") or 30)   # 요청을 읽는 동안 이 시간 안에 안 오면 끊는다 (느린 연결로 스레드를 잡아 두는 것 방지)
_sse_lock = threading.Lock()
_sse_open = 0


def _log_error(where: str, e: Exception) -> None:
    """자세한 오류는 콘솔(로그)에만 남기고 응답에는 고정 문구만 보낸다 (경로·SQL 조각이 새지 않게, D5-40 ③)."""
    print(f"[webapi] 오류 {where}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
ADMIN_RPC = frozenset({"request_doc", "set_action_status", "delete_feedback", "restore_feedback",
                       "resolve_review", "dismiss_review", "reopen_review", "list_deleted", "check_admin"})


def call_rpc(name: str, args: dict, code: str | None = None, source: str | None = None):
    """RPC 하나를 실행한다. 관리자 동작이면 먼저 운영자 코드를 검사한다.

    없는 함수는 KeyError, 코드 거부는 admin.AdminError(status 401/403/429), 검증 오류는 ApiError.
    코드는 헤더(code)나 본문의 p_code 로 받는다 (Supabase RPC 와 같은 인자 이름).
    source 는 접속 주소의 하루짜리 해시 — 틀린 코드 횟수·잠금을 출처별로 센다 (D5-40).
    """
    args = dict(args or {})
    body_code = args.pop("p_code", None)
    fn = RPC[name]
    if name in ADMIN_RPC:
        admin.verify(code if code else body_code, source)
    if name == "submit_feedback":
        return fn(**args, source=source)                  # 출처별 폭주 제한용 (D5-33 ②)
    return fn(**args)
GET = {
    "/api/zones": get_zones,
    "/api/festival": get_festival,
    "/api/control": get_control,
    "/api/action": get_action,
}


# ── 실시간 대역 ───────────────────────────────────────────────────

_fp_lock = threading.Lock()
_fp_cache: tuple[float, tuple] | None = None


def shared_fingerprint(max_age: float = 0.8) -> tuple:
    """SSE 연결마다 1초에 한 번 DB 를 훑으면 접속자 수만큼 DB 일이 늘어난다 (D5-37).
    0.8초 안에 누가 이미 계산했다면 그 값을 같이 쓴다 → 접속자가 늘어도 초당 DB 조회는 한 번."""
    global _fp_cache
    with _fp_lock:
        now = time.monotonic()
        if _fp_cache is None or now - _fp_cache[0] >= max_age:
            _fp_cache = (time.monotonic(), fingerprint())
        return _fp_cache[1]


def fingerprint() -> tuple:
    """화면에 영향을 주는 변화를 한 줄로 요약한다. 값이 바뀌면 다시 그린다."""
    with db.connect() as conn:
        q = lambda sql: tuple(conn.execute(sql).fetchone())
        return (
            q("SELECT MAX(id), COUNT(*), COUNT(deleted_at) FROM feedback"),
            q("SELECT COUNT(*) FROM classification WHERE status='pending'"),
            # 확인 필요 처리(유형 지정·닫기·되돌리기)가 화면에 바로 반영되도록
            q("SELECT COUNT(*), COUNT(reviewed_at), COALESCE(SUM(CASE status WHEN 'review' THEN 1 "
              "WHEN 'dismissed' THEN 2 ELSE 0 END), 0) FROM classification"),
            q("SELECT MAX(id) FROM severity"),
            q("SELECT MAX(id) FROM briefing"),
            q("SELECT COUNT(*), MAX(updated_at), SUM(active) FROM issue"),
            # GROUP_CONCAT 은 SQLite 전용이다. 상태를 숫자로 바꿔 id 와 곱해 더하면
            # 어느 행의 상태가 바뀌어도 값이 달라진다 (SQLite·Postgres 공용).
            q("SELECT MAX(id), COUNT(*), SUM(id * CASE status WHEN 'requested' THEN 1 "
              "WHEN 'in_progress' THEN 2 WHEN 'done' THEN 3 ELSE 4 END), MAX(closed_at) "
              "FROM (SELECT id, status, closed_at FROM action_request "
              "ORDER BY id DESC LIMIT 15) t"),
            q("SELECT MAX(id), COUNT(*), SUM(id * CASE status WHEN 'queued' THEN 1 "
              "WHEN 'running' THEN 2 WHEN 'done' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END) "
              "FROM (SELECT id, status FROM doc_job ORDER BY id DESC LIMIT 30) t"),
        )


def max_id(table: str) -> int:
    return (_one(f"SELECT MAX(id) m FROM {table}") or {}).get("m") or 0


# ── HTTP ──────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    timeout = REQUEST_TIMEOUT        # StreamRequestHandler: 연결 소켓의 읽기·쓰기 제한 시간

    def log_message(self, fmt, *args):  # 요청마다 찍으면 워커 로그가 묻힌다
        pass

    def _send(self, code: int, body) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Backend", BACKEND)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/events":
            return self._events()
        if path.startswith("/api/docs/"):
            return self._doc(unquote(path.removeprefix("/api/docs/")))
        if path == "/api/deleted":                      # 관리자 전용 읽기 — X-Admin-Code 헤더 (한글 코드는 POST /api/rpc/list_deleted 의 p_code)
            return self._admin_get("list_deleted")
        fn = GET.get(path)
        if not fn:
            return self._send(404, {"error": "없는 경로"})
        try:
            self._send(200, {"backend": BACKEND, "data": fn()})
        except Exception as e:
            _log_error(f"GET {path}", e)
            self._send(500, {"error": "서버 오류"})

    def _admin_get(self, rpc_name: str) -> None:
        try:
            src = source_id.client_source(self.client_address[0], ",".join(self.headers.get_all("X-Forwarded-For") or []))
            data = call_rpc(rpc_name, {}, self.headers.get("X-Admin-Code"), src)
            self._send(200, {"backend": BACKEND, "data": data["items"]})
        except admin.AdminError as e:                    # 401 · 403 · 429 — POST 와 같은 규칙
            self._send(e.status, {"error": str(e)})
        except Exception as e:
            _log_error(f"GET {rpc_name}", e)
            self._send(500, {"error": "서버 오류"})

    def do_POST(self):
        path = urlparse(self.path).path
        name = path.removeprefix("/api/rpc/")
        # 본문은 라우팅보다 먼저 끝까지 읽는다 — 안 읽고 답하면 Windows 에서 연결이 끊겨(WinError 10053) 간헐 오류가 난다.
        # 크기는 0~16KB (접수는 500자라 충분). 음수·과대 값은 읽지 않고 거절한다 (D5-40 ②).
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0:
            self.close_connection = True
            return self._send(400, {"error": "요청 형식이 올바르지 않습니다"})
        if n > MAX_BODY:
            self.close_connection = True
            return self._send(413, {"error": "요청이 너무 큽니다"})
        raw = self.rfile.read(n) if n else b""
        if not path.startswith("/api/rpc/") or name not in RPC:
            return self._send(404, {"error": "없는 함수"})
        # 다른 사이트의 <form>·text/plain '단순 요청'이 접수를 실행하지 못하게 JSON 만 받는다 (브라우저는 JSON 이면 교차 출처 POST 전에 사전 확인을 해서 막힌다, D5-40 ⑥)
        if not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
            return self._send(415, {"error": "application/json 으로 보내 주세요"})
        try:
            args = json.loads(raw or b"{}")
            if not isinstance(args, dict):
                raise ApiError("요청 형식이 올바르지 않습니다")
            src = source_id.client_source(self.client_address[0], ",".join(self.headers.get_all("X-Forwarded-For") or []))   # 헤더가 여러 줄이어도 맨 오른쪽이 마지막
            data = call_rpc(name, args, self.headers.get("X-Admin-Code"), src)
            self._send(200, {"backend": BACKEND, "data": data})
        except admin.AdminError as e:                    # 401 코드 없음·틀림 · 403 코드 미설정 · 429 잠김
            self._send(e.status, {"error": str(e)})
        except ApiError as e:                           # 입력 검사 문구(사용자에게 보여 줄 문장)
            self._send(400, {"error": str(e)})
        except (TypeError, ValueError) as e:            # 모르는 인자 · 잘못된 JSON — 함수 이름·인자가 보이지 않게 고정 문구
            _log_error(f"POST {path}", e)
            self._send(400, {"error": "요청 형식이 올바르지 않습니다"})
        except Exception as e:
            _log_error(f"POST {path}", e)
            self._send(500, {"error": "서버 오류"})

    def _doc(self, name: str) -> None:
        """output/ 의 DOCX 만 내준다. 경로 탈출(../, 절대경로, 하위 폴더)은 막는다."""
        target = (DOCS_DIR / name).resolve()
        if (not name or name != Path(name).name or not name.endswith(".docx")
                or target.parent != DOCS_DIR or not target.is_file()):
            return self._send(404, {"error": "없는 문서"})
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", DOCX_TYPE)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")
        self.send_header("X-Backend", BACKEND)
        self.end_headers()
        self.wfile.write(data)

    def _events(self) -> None:
        global _sse_open
        with _sse_lock:
            if _sse_open >= MAX_SSE:
                full = True
            else:
                _sse_open += 1
                full = False
        if full:                                        # 상한: 스레드·DB 조회가 접속자 수만큼 늘어나는 것을 막는다 (D5-40 ④)
            return self._send(503, {"error": "연결이 너무 많습니다. 잠시 뒤 다시 시도해 주세요"})
        try:
            self._events_stream()
        finally:
            with _sse_lock:
                _sse_open -= 1

    def _client_gone(self) -> bool:
        """브라우저가 연결을 닫았는지 (읽을 수 있는데 0바이트 = 상대가 끊음). 다음 전송 실패까지 기다리지 않고 자리를 바로 돌려준다."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def _events_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Backend", BACKEND)
        self.end_headers()

        def emit(event: str, data) -> None:
            msg = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
            self.wfile.write(msg.encode())
            self.wfile.flush()

        last_fp = shared_fingerprint(0)        # 처음 값은 새로 계산
        last_alert = max_id("alert")
        done_jobs = {r["id"] for r in _rows("SELECT id FROM doc_job WHERE status='done'")}
        emit("ready", {"backend": BACKEND})
        idle = 0
        t_start = time.monotonic()
        try:
            while time.monotonic() - t_start < SSE_MAX_SECONDS:     # 오래 붙은 연결은 끊는다 — 브라우저가 스스로 다시 붙는다
                time.sleep(1)
                if self._client_gone():
                    break
                fp = shared_fingerprint()
                if fp != last_fp:
                    last_fp, idle = fp, 0
                    for a in _rows("SELECT * FROM alert WHERE id>? ORDER BY id", (last_alert,)):
                        last_alert = a["id"]
                        emit("alert", a)
                    for j in _rows("SELECT id, label FROM doc_job WHERE status='done'"):
                        if j["id"] not in done_jobs:
                            done_jobs.add(j["id"])
                            emit("doc_done", j)
                    emit("change", {})
                else:
                    idle += 1
                    if idle >= 15:            # 연결 유지
                        idle = 0
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            pass


class ExclusiveServer(ThreadingHTTPServer):
    """같은 포트에 두 번째 서버가 뜨지 못하게 한다.

    HTTPServer 는 기본으로 SO_REUSEADDR 를 켠다. Windows 에서는 이 옵션이 있으면
    다른 프로세스가 같은 포트에 또 바인드할 수 있어서, 요청이 두 서버로 나뉜다.
    """
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):          # Windows 전용
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> None:
    # 백그라운드로 띄워도 로그가 바로 보이게
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    if db.is_pg():
        print("[webapi] SUPABASE_DB_URL 이 설정돼 있습니다. 웹은 Supabase 에 직접 붙이세요 "
              "(web/.env). 이 서버는 local 대역입니다.")
    try:
        srv = ExclusiveServer((args.host, args.port), Handler)
    except OSError:
        print(f"[webapi] {args.host}:{args.port} 에 이미 서버가 실행 중입니다. "
              "그 서버를 쓰거나 --port 로 다른 포트를 지정하세요.", file=sys.stderr)
        sys.exit(1)
    db.init_db()
    if not config.ADMIN_CODE:
        print("[webapi] ADMIN_CODE 가 비어 있어 관리자 동작(민원 지우기·조치 상태 변경·요청서 생성)을 "
              ".env 에 코드를 넣기 전까지 모두 거부합니다.")
    print(f"[webapi] local 대역 · http://{args.host}:{args.port}  (DB {config.DB_PATH})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[webapi] 종료")


if __name__ == "__main__":
    main()
