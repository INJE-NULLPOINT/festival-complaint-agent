"""확인 필요(review) 민원 처리 (할일 D5-32).

분류 신뢰도가 낮거나 내용이 없어 유형을 정하지 못한 민원(status='review')을 운영자가 처리한다.
운영자 동작은 세 가지다 — ①유형 지정(resolve) ②유형 없음으로 닫기(dismiss) ③지우기(D5-30 delete_feedback).
'무시'는 동작이 아니라 그냥 두는 것이다 (개수에 계속 남는다).

  resolve   status='review' → 'done'. 운영자가 고른 유형·안전 여부로 집계(심각도·카드·알림)에 들어간다.
            posted_at 은 원래 시각 그대로라 창 안이면 다음 주기부터 반영된다. 같은 문장이 다시 오면 쓰도록
            classify_cache 에도 넣는다.
  dismiss   'review' → 'dismissed'. 진짜 방문객 의견이지만 유형을 붙일 수 없는 것('좀 그랬어요'). 지우면 방문객
            목소리가 사라지므로 따로 둔다. 확인 필요 개수·심각도에서 빠지고 유입 목록에는 '유형 없음'으로 남는다.
  reopen    'dismissed' 나 운영자가 지정한 'done' 을 다시 'review' 로 (5초 되돌리기 토스트용).

세 동작 모두 운영자 코드(core/admin.py)로 보호되고, 상태 조건을 건다 — 이미 처리된 민원은 '이미 처리된 민원입니다'
(두 운영자가 동시에 눌러도 한 번만 된다: UPDATE 의 WHERE status 조건이 원자적이다).
운영자가 처리한 건(decided_by='operator')은 measure_accuracy 가 모델 정답으로 치지 않는다.

안전 의심(is_safety=1) review 가 STALE_MIN 분 넘게 처리되지 않으면 알림을 한 번 올린다 (kind='review_safety_stale').
저신뢰 안전 신호가 '확인 필요 N' 개수 속에서 썩지 않게 하려는 것이다 (D5-25 원칙의 연장).
"""
import hashlib

from . import config, db

STALE_MIN = 15                     # 설계값 [확인 필요: 운영 담당자 의견]. 미조치 가중(30분)보다 짧게 잡았다
MSG_DONE = "이미 처리된 민원입니다"
MSG_MISSING = "없는 민원입니다"
MSG_NOT_REOPENABLE = "되돌릴 수 있는 처리가 아닙니다"
ALERT_KIND = "review_safety_stale"


def _digest(raw_text: str) -> str:
    return hashlib.sha256(raw_text.encode()).hexdigest()


def _get(conn, feedback_id: int):
    return conn.execute(
        """SELECT c.feedback_id, c.status, c.label, c.sentiment, c.is_safety, c.confidence,
                  c.suggested_label, c.decided_by, f.raw_text
           FROM classification c JOIN feedback f ON f.id = c.feedback_id
           WHERE c.feedback_id = ?""", (feedback_id,)).fetchone()


def resolve(feedback_id: int, label: str, is_safety=None, ts: str | None = None) -> None:
    """유형 지정. 없는 민원 KeyError · 이미 처리됨·모르는 유형 ValueError."""
    if label not in config.LABELS:
        raise ValueError(f"모르는 민원 유형입니다: {label}")
    with db.connect() as conn:
        r = _get(conn, feedback_id)
        if not r:
            raise KeyError(MSG_MISSING)
        if r["status"] != "review":
            raise ValueError(MSG_DONE)
        # 안전·혼잡을 고르면 자동으로 안전 의심, 긍정은 안전이 아니다. 그 밖에는 운영자가 고른 값, 없으면 모델이 준 값
        if label in config.SAFETY_LABELS:
            safe = 1
        elif label == "positive":
            safe = 0
        elif is_safety is None:
            safe = int(bool(r["is_safety"]))
        else:
            safe = int(bool(is_safety))
        sug = r["suggested_label"] or "-"
        cur = conn.execute(
            """UPDATE classification
               SET label=?, is_safety=?, confidence=1.0, status='done', agent_note=?,
                   reviewed_at=?, review_action='label', decided_by='operator'
               WHERE feedback_id=? AND status='review'""",
            (label, safe, f"운영자 지정 (모델 제안: {sug})", ts or db.now(), feedback_id))
        if cur.rowcount == 0:
            raise ValueError(MSG_DONE)
        conn.commit()
        sentiment, raw = r["sentiment"], r["raw_text"]
    # 같은 문장이 다시 오면 운영자 지정을 쓴다 (리플레이 반복 대비)
    db.cache_put(_digest(raw), {"label": label, "sentiment": sentiment if sentiment is not None else -0.5,
                                "is_safety": bool(safe), "confidence": 1.0})


def dismiss(feedback_id: int, ts: str | None = None) -> None:
    """유형 없음으로 닫기."""
    with db.connect() as conn:
        r = _get(conn, feedback_id)
        if not r:
            raise KeyError(MSG_MISSING)
        cur = conn.execute(
            """UPDATE classification
               SET status='dismissed', reviewed_at=?, review_action='dismissed', decided_by='operator'
               WHERE feedback_id=? AND status='review'""", (ts or db.now(), feedback_id))
        if cur.rowcount == 0:
            raise ValueError(MSG_DONE)
        conn.commit()


def reopen(feedback_id: int) -> None:
    """운영자 처리(닫기·유형 지정)를 되돌려 다시 '확인 필요'로."""
    with db.connect() as conn:
        r = _get(conn, feedback_id)
        if not r:
            raise KeyError(MSG_MISSING)
        was_label = r["status"] == "done" and r["decided_by"] == "operator"
        if not (r["status"] == "dismissed" or was_label):
            raise ValueError(MSG_NOT_REOPENABLE)
        sug = r["suggested_label"] or "-"
        cur = conn.execute(
            """UPDATE classification
               SET status='review', label=NULL, confidence=NULL, agent_note=?,
                   reviewed_at=NULL, review_action=NULL, decided_by=NULL
               WHERE feedback_id=? AND (status='dismissed' OR (status='done' AND decided_by='operator'))""",
            (f"확인 필요 — 운영자가 되돌림. 모델 제안: {sug}", feedback_id))
        if cur.rowcount == 0:
            raise ValueError(MSG_NOT_REOPENABLE)
        if was_label:                       # 지정하며 넣어 둔 같은 문장 캐시는 지운다
            conn.execute("DELETE FROM classify_cache WHERE hash=?", (_digest(r["raw_text"]),))
        conn.commit()


def items(limit: int = 20) -> list[dict]:
    """운영자가 처리할 확인 필요 목록. 안전 의심이 먼저, 그 안에서는 오래된 것 먼저 (최대 limit건)."""
    with db.connect() as conn:
        rows = conn.execute(
            f"""SELECT f.id, f.raw_text, f.ingested_at, f.posted_at, f.zone_id,
                       COALESCE(z.name, '{config.ZONE_UNKNOWN}') zone,
                       c.suggested_label, COALESCE(c.is_safety, 0) is_safety, c.confidence, c.agent_note
                FROM classification c
                JOIN feedback f ON f.id = c.feedback_id
                LEFT JOIN zone z ON z.id = f.zone_id
                WHERE c.status='review' AND {db.LIVE_FEEDBACK_SQL}
                ORDER BY COALESCE(c.is_safety, 0) DESC, f.ingested_at ASC, f.id ASC
                LIMIT ?""", (limit,)).fetchall()
    return [dict(r) for r in rows]


def raise_stale_alerts(minutes: int = STALE_MIN) -> int:
    """안전 의심 확인 필요가 minutes 분 넘게 처리되지 않았으면 알림 1회 (같은 민원은 한 번만). 올린 알림 수."""
    from datetime import datetime, timedelta
    cutoff = (datetime.now() - timedelta(minutes=minutes)).isoformat(timespec="seconds")
    raised = 0
    with db.connect() as conn:
        stale = conn.execute(
            f"""SELECT f.id, f.raw_text, c.suggested_label
                FROM classification c JOIN feedback f ON f.id = c.feedback_id
                WHERE c.status='review' AND c.is_safety=1 AND {db.LIVE_FEEDBACK_SQL}
                  AND f.ingested_at <= ?
                ORDER BY f.ingested_at""", (cutoff,)).fetchall()
        done = {r["detail"] for r in conn.execute(
            "SELECT detail FROM alert WHERE kind=?", (ALERT_KIND,)).fetchall()}
    for r in stale:
        marker = f"[#{r['id']}]"            # 같은 민원에 알림이 두 번 나가지 않게 표식을 본문에 둔다
        if any(marker in d for d in done):
            continue
        label = r["suggested_label"] if r["suggested_label"] in config.LABELS else "safety"
        db.raise_alert(label, ALERT_KIND,
                       f"{marker} 확인 필요 안전 의심 민원이 {minutes}분 넘게 처리되지 않았습니다: "
                       f"{(r['raw_text'] or '')[:40]}")
        raised += 1
    return raised
