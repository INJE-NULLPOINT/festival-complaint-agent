"""접수 도배 방지 (할일 D5-33) — '양으로는 막지 않고, 같은 글과 기계적 폭주만 막는다'.

이 시스템의 핵심 신호는 '한 구역에 민원이 몰림'(급증·S-04)이다. 구역·양으로 막으면 진짜 인파 사고 때 신고를 스스로
자르게 된다. 그래서 막는 것은 두 가지뿐이고, 구역 몰림은 막지 않고 표시만 한다.

  ① 같은 글 합치기  같은 구역 + 정규화한 본문(공백·기호 제거, 소문자)이 최근 2분 안에 이미 접수됐으면 새로 넣지 않고
                    성공처럼 응답한다(두 번 누름·새로고침·복붙 도배를 조용히 흡수). 합친 횟수는 dup_count 로 남긴다.
                    다른 사람이 **다른 말로** 쓴 같은 불편은 모두 들어간다.
  ② 출처별 폭주 제한 접속 주소(IP)의 하루짜리 해시(core/source_id.py)별로 1분 10건 · 10분 30건을 넘으면 거절한다.
                    원문 IP 는 저장하지 않는다. submit_rate(해시, 시각) 표에만 두고 24시간 뒤 지우며, 민원 행과는
                    연결하지 않는다(feedback 에 해시 열 없음). 한도는 사람 손이 아니라 스크립트만 닿는 수준이다.
                    출처를 알 수 없으면(IP 없음) ②는 건너뛴다.
  ③ 구역 몰림 표시  같은 구역에 1분 안에 20건 이상이면 zone_burst() 가 알려 준다 (관제에 '몰림 — 도배인지 확인').
                    심각도 계산은 그대로다(진짜 사고일 수 있다).

켜고 끄기: config.DEDUP_ENABLED · config.SUBMIT_LIMIT_ENABLED (환경변수 DEDUP_ENABLED · SUBMIT_LIMIT_ENABLED 로도).
숫자는 전부 설계값 [확인 필요: 리허설로 조정]. 쿠키·localStorage 기기 ID 는 쓰지 않는다.
Supabase 는 schema.sql 의 submit_feedback 이 같은 규칙을 한다 (② 는 x-forwarded-for 헤더가 와야 한다 — [확인 필요]).
"""
import re
import threading
from datetime import datetime, timedelta, timezone

from . import config, db, privacy

KST = timezone(timedelta(hours=9))
MSG_RATE = "잠시 후 다시 보내 주세요"          # 한도 숫자·기준은 알려 주지 않는다


_submit_lock = threading.Lock()       # 같은 글이 거의 동시에 두 번 와도 한 건으로 합치려면 '찾기 → 넣기'가 한 덩어리여야 한다


class RateLimited(Exception):
    """출처별 폭주 제한에 걸림."""


def normalize(text: str) -> str:
    """같은 글 판정용 정규화 — 개인정보 마스킹 뒤 공백·기호를 지우고 소문자로."""
    return re.sub(r"[^가-힣a-z0-9]", "", privacy.mask(text or "").lower())


def _stamp(dt: datetime) -> str:
    return dt.astimezone(KST).strftime("%Y-%m-%dT%H:%M:%S")


def seoul_now() -> datetime:
    return datetime.now(KST)


def find_duplicate(zone_id, text: str, now: datetime | None = None) -> int | None:
    """최근 DEDUP_WINDOW_SEC 안에 같은 구역·같은 글이 있으면 합치고(dup_count+1) 접수번호를 돌려준다. 없으면 None."""
    if not config.DEDUP_ENABLED:
        return None
    norm = normalize(text)
    if not norm:
        return None
    cutoff = _stamp((now or seoul_now()) - timedelta(seconds=config.DEDUP_WINDOW_SEC))
    with db.connect() as conn:
        # ① 아직 접수함에 원문이 남아 있는 것
        zsql, zarg = ("zone_id = ?", (zone_id,)) if zone_id is not None else ("zone_id IS NULL", ())
        for r in conn.execute(
                f"SELECT id, text FROM feedback_inbox WHERE {zsql} AND created_at >= ? AND text IS NOT NULL "
                "ORDER BY id DESC", (*zarg, cutoff)).fetchall():
            if normalize(r["text"]) == norm:
                conn.execute("UPDATE feedback_inbox SET dup_count = COALESCE(dup_count, 0) + 1 WHERE id=?", (r["id"],))
                conn.commit()
                return r["id"]
        # ② 워커가 이미 옮긴 것 (원문은 마스킹본)
        for r in conn.execute(
                f"SELECT f.id, f.raw_text FROM feedback f WHERE f.{zsql} AND f.ingested_at >= ? "
                f"AND {db.LIVE_FEEDBACK_SQL} ORDER BY f.id DESC", (*zarg, cutoff)).fetchall():
            if normalize(r["raw_text"]) == norm:
                conn.execute("UPDATE feedback SET dup_count = COALESCE(dup_count, 0) + 1 WHERE id=?", (r["id"],))
                receipt = conn.execute("SELECT MAX(id) m FROM feedback_inbox WHERE feedback_id=?", (r["id"],)).fetchone()["m"]
                conn.commit()
                return receipt or r["id"]
    return None


def check_rate(src: str | None, now: datetime | None = None) -> None:
    """출처별 폭주 제한. 넘으면 RateLimited. 통과하면 이번 시도를 기록한다. 출처를 모르면 건너뛴다."""
    if not config.SUBMIT_LIMIT_ENABLED or not src:
        return
    now = now or seoul_now()
    with db.connect() as conn:
        conn.execute("DELETE FROM submit_rate WHERE at < ?", (_stamp(now - timedelta(hours=24)),))     # 24시간 뒤 삭제
        for seconds, limit in config.SUBMIT_LIMITS:
            n = conn.execute("SELECT COUNT(*) c FROM submit_rate WHERE src=? AND at >= ?",
                             (src, _stamp(now - timedelta(seconds=seconds)))).fetchone()["c"]
            if n >= limit:
                conn.commit()
                raise RateLimited(MSG_RATE)
        conn.execute("INSERT INTO submit_rate (src, at) VALUES (?, ?)", (src, _stamp(now)))
        conn.commit()


def accept(zone_id, text: str, source: str | None = None, via_inbox: bool = True) -> int | None:
    """접수 한 건을 받는다 — ②출처별 제한 → ①같은 글 합치기 → 저장을 한 덩어리로(프로세스 안에서 락).

    via_inbox=True  웹 접수: feedback_inbox 에 넣고 접수번호(inbox id)를 돌려준다 (워커가 마스킹해 옮긴다).
    via_inbox=False Streamlit 접수: db.insert_feedback 으로 바로 넣고 민원 번호를 돌려준다 (마스킹은 그 안에서).
    합쳐진 글은 같은 번호를 돌려준다(성공처럼). 제한에 걸리면 RateLimited. 같은 해시 글이라 저장이 거절되면 None.
    Supabase 는 submit_feedback 이 pg_advisory_xact_lock 으로 같은 일을 한다.
    """
    with _submit_lock:
        check_rate(source)
        dup = find_duplicate(zone_id, text)
        if dup is not None:
            return dup
        if not via_inbox:
            return db.insert_feedback(zone_id, text, source="qr")
        with db.connect() as conn:
            cur = conn.execute("INSERT INTO feedback_inbox (zone_id, text, created_at) VALUES (?,?,?)",
                               (zone_id, text.strip(" "), _stamp(seoul_now())))
            conn.commit()
            return cur.lastrowid


def purge_old(now: datetime | None = None) -> int:
    """24시간 지난 출처 기록(submit_rate)과 운영자 코드 실패 기록(admin_attempt)을 지운다. 워커가 주기적으로 부른다."""
    cutoff = _stamp((now or seoul_now()) - timedelta(hours=24))
    with db.connect() as conn:
        n = conn.execute("DELETE FROM submit_rate WHERE at < ?", (cutoff,)).rowcount
        n += conn.execute("DELETE FROM admin_attempt WHERE at < ?", (cutoff,)).rowcount
        conn.commit()
    return n


def zone_burst(window_sec: int | None = None, min_count: int | None = None, now: datetime | None = None) -> list[dict]:
    """최근 window_sec 안에 min_count 건 이상 접수가 몰린 구역 — 차단하지 않고 표시만 한다 (심각도는 그대로)."""
    window_sec = window_sec or config.CROWD_FLAG_SEC
    min_count = min_count or config.CROWD_FLAG_MIN
    cutoff = _stamp((now or seoul_now()) - timedelta(seconds=window_sec))
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT z.id zone_id, z.name zone, COUNT(*) n FROM feedback_inbox i
                JOIN zone z ON z.id = i.zone_id WHERE i.created_at >= ? GROUP BY z.id, z.name
                HAVING COUNT(*) >= ? ORDER BY n DESC""", (cutoff, min_count)).fetchall()
    return [{"zone_id": r["zone_id"], "zone": r["zone"], "count": r["n"], "window_sec": window_sec} for r in rows]
