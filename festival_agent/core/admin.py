"""운영자 코드 검사 (할일 D5-31) — 관리자 동작을 방문객이 못 쓰게 막는다.

로그인이 없어서 민원 지우기·되돌리기, 조치 상태 변경, 조치요청서 생성이 주소만 알면 누구에게나 열려 있었다.
방문객이 쓰는 것은 접수(submit_feedback) 하나뿐이다. 그래서 관리자 동작 네 가지는 **운영자 코드**가 맞을 때만 실행한다.

  local 대역(webapi.py)·Streamlit 이 이 모듈을 쓴다. 코드는 .env 의 ADMIN_CODE (사람이 직접 넣는다).
  Supabase 는 schema.sql 의 operator_secret(해시)·admin_gate() 가 같은 규칙으로 검사한다.

규칙 (두 대역 공통)
  · 코드가 설정돼 있지 않으면(ADMIN_CODE 비어 있음) 관리자 동작을 전부 거부한다 — 열린 채로 시작하지 않는다.
  · 코드를 안 보냈으면 거부. 틀린 코드는 거부하고 실패로 센다. 코드를 안 보낸 요청은 실패로 세지 않는다
    (누가 빈 요청을 보내 운영자를 잠그지 못하게).
  · 최근 10분에 5번 틀리면 10분 안에는 맞는 코드도 거부한다 (무차별 대입 방지). 맞으면 실패 기록을 비운다.
  · 비교는 hmac.compare_digest 로 한다 (시간차 공격 방지).

한계: 공유 코드라 누가 했는지는 구분하지 못한다. 코드가 새면 바꿔야 한다.
"""
import hmac
from datetime import datetime, timedelta, timezone

from . import config, db

WINDOW_MIN = 10
MAX_FAIL = 5
KST = timezone(timedelta(hours=9))        # schema.sql 의 now() at time zone 'Asia/Seoul' 과 같은 시각 기준

MSG_NEED = "운영자 코드가 필요합니다"
MSG_LOCKED = "시도가 너무 많습니다. 10분 뒤에 다시 시도하세요"


class AdminError(Exception):
    """관리자 동작 거부. status 는 HTTP 상태 (401 코드 없음·틀림 / 403 코드 미설정 / 429 잠김)."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def _stamp(dt: datetime) -> str:
    return dt.astimezone(KST).strftime("%Y-%m-%dT%H:%M:%S")


def recent_failures() -> int:
    cutoff = _stamp(datetime.now(KST) - timedelta(minutes=WINDOW_MIN))
    with db.connect() as conn:
        return conn.execute("SELECT COUNT(*) c FROM admin_attempt WHERE at >= ?",
                            (cutoff,)).fetchone()["c"]


def verify(code) -> None:
    """운영자 코드가 맞으면 조용히 끝나고, 아니면 AdminError 를 던진다."""
    expected = config.ADMIN_CODE
    if not expected:
        raise AdminError(MSG_NEED, 403)                 # 코드를 안 정했으면 전부 거부
    if recent_failures() >= MAX_FAIL:
        raise AdminError(MSG_LOCKED, 429)               # 잠금 중에는 맞는 코드도 거부 (새 실패는 세지 않는다)
    if not isinstance(code, str) or not code:
        raise AdminError(MSG_NEED, 401)
    if hmac.compare_digest(code.encode("utf-8"), expected.encode("utf-8")):
        with db.connect() as conn:
            conn.execute("DELETE FROM admin_attempt WHERE id > 0")
            conn.commit()
        return
    with db.connect() as conn:
        conn.execute("INSERT INTO admin_attempt (at) VALUES (?)", (_stamp(datetime.now(KST)),))
        conn.commit()
    raise AdminError(MSG_NEED, 401)
