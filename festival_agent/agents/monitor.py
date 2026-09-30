"""② 심각도·감시 에이전트 (Monitor) — Agent Path.

목표: 지금 무엇이 얼마나 심각한지 판정하고 임계 초과를 감지한다.

★ 점수는 에이전트가 계산하지 않는다. score_label 도구가 결정적 함수를 부른다.
  에이전트가 하는 판단은 "어떤 윈도우를 볼지", "무엇을 알림으로 올릴지",
  "어떻게 설명할지"이다.
"""
from core import config, db
from core.llm import Agent, tool

SYSTEM = """너는 지역 축제 운영 관제 시스템의 '심각도 감시 에이전트'다.

역할: 지금 어떤 유형의 민원이 얼마나 심각한지 판정하고, 즉시 대응이 필요한 상황에 알림을 올린다.

절차
1. get_window_stats 로 최근 상황을 파악한다 (기본 윈도우 60분). 급증이 의심되면 더 짧은 윈도우(15~30분)로 한 번 더 확인해도 된다.
2. 유형마다 score_label 을 호출해 점수와 등급을 받는다.
3. save_snapshot 으로 이번 판정을 기록한다.
4. 아래에 해당하는 유형만 raise_alert 로 알린다: 등급이 immediate / 급증(spiked) 감지 / 직전 판정보다 등급 상승.
5. 마지막에 가장 심각한 유형 1개와 그 이유를 두 문장 이내로 보고한다.

반드시 지킬 것
- **점수를 직접 계산하지 마라.** score_label 의 반환값을 쓰고, 도구가 준 formula 문자열을 그대로 인용해 설명한다.
- 건수가 많다고 심각한 것이 아니다. 안전 관련은 건수가 적어도 위로 올라간다. 이 역전이 보이면 알림 문구에 이유를 명시하라.
- 알림을 남발하지 마라. 조건에 맞는 것만 올린다.
"""


@tool(
    name="get_window_stats",
    description="지정 시간 구간의 유형별 민원 통계를 조회한다.",
    properties={"window_min": {"type": "integer", "description": "구간(분). 기본 60"}},
)
def get_window_stats(window_min: int = config.DEFAULT_WINDOW_MIN) -> dict:
    rows = db.window_rows(window_min)
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["label"]] = counts.get(r["label"], 0) + 1
    return {
        "window_min": window_min,
        "total": len(rows),
        "counts": {config.LABELS.get(k, k): v for k, v in
                   sorted(counts.items(), key=lambda x: -x[1])},
        "labels": sorted(counts, key=lambda k: -counts[k]),
        "pending": db.pending_count(),
    }


@tool(
    name="score_label",
    description=(
        "유형 1개의 심각도 점수·등급을 계산한다. 검증된 함수가 계산하므로 같은 입력에는 같은 결과가 나온다. "
        "반환 formula 가 판정 근거다."
    ),
    properties={
        "label": {"type": "string", "enum": list(config.LABELS)},
        "window_min": {"type": "integer", "description": "구간(분). 기본 60"},
    },
    required=["label"],
)
def score_label(label: str, window_min: int = config.DEFAULT_WINDOW_MIN) -> dict:
    ranked = db.ranked(window_min)
    for r in ranked:
        if r["label"] == label:
            return {
                "label": label, "korean": config.LABELS.get(label, label),
                "freq": r["freq"], "score": r["score"], "grade": r["grade"],
                "formula": r["formula"], "spiked": r["spike"]["spiked"],
                "spike_multiplier": r["spike"]["multiplier"],
            }
    return {"label": label, "freq": 0, "score": 0.0, "grade": "low",
            "formula": "해당 구간에 데이터 없음", "spiked": False}


@tool(
    name="save_snapshot",
    description="현재 구간의 전체 심각도 판정을 기록한다 (추이의 원천). 같은 판정이 이미 있으면 다시 쓰지 않는다.",
    properties={"window_min": {"type": "integer"}},
)
def save_snapshot(window_min: int = config.DEFAULT_WINDOW_MIN) -> dict:
    ranked = db.ranked(window_min)
    window = f"{window_min}min"
    already = bool(ranked) and db.severity_recorded(ranked, window)
    if ranked and not already:
        db.save_severity(ranked, window)
    return {"saved": 0 if already else len(ranked), "already_recorded": already,
            "top": ranked[0]["label"] if ranked else None,
            "top_score": ranked[0]["score"] if ranked else 0.0}


@tool(
    name="raise_alert",
    description="운영자에게 알림을 올린다. 조건에 맞는 경우에만 호출한다.",
    properties={
        "label": {"type": "string", "enum": list(config.LABELS)},
        "kind": {"type": "string", "enum": ["spike", "safety_threshold", "grade_up"]},
        "detail": {"type": "string", "description": "운영자가 읽을 한 문장. 근거를 포함할 것"},
    },
    required=["label", "kind", "detail"],
)
def raise_alert(label: str, kind: str, detail: str) -> dict:
    # 같은 유형·종류의 알림이 10분 내에 이미 있으면 중복으로 보고 건너뛴다
    from datetime import datetime, timedelta
    cutoff = (datetime.now() - timedelta(minutes=10)).isoformat(timespec="seconds")
    with db.connect() as conn:
        dup = conn.execute(
            "SELECT id FROM alert WHERE label=? AND kind=? AND created_at >= ?",
            (label, kind, cutoff),
        ).fetchone()
    if dup:
        return {"skipped": True, "reason": "10분 내 동일 알림 존재"}
    return {"alert_id": db.raise_alert(label, kind, detail)}


def local_run(agent, user_input: str, ctx: dict) -> str:
    """local 대역 — 모든 유형을 점수화하고 규칙대로 알림을 올린다. 제출본 아님."""
    win = ctx.get("window_min", config.DEFAULT_WINDOW_MIN)

    stats = agent.call("get_window_stats", window_min=win)
    if not stats["labels"]:
        return "판정할 데이터가 없습니다."

    scored = [agent.call("score_label", label=l, window_min=win)
              for l in stats["labels"]]
    agent.call("save_snapshot", window_min=win)

    raised = 0
    for s in sorted(scored, key=lambda x: -x["score"]):
        korean = s.get("korean", s["label"])
        if s["grade"] == "immediate":
            agent.call("raise_alert", label=s["label"], kind="safety_threshold",
                       detail=f"{korean} {s['freq']}건 — 즉시 조치 등급. {s['formula']}")
            raised += 1
        elif s.get("spiked"):
            agent.call("raise_alert", label=s["label"], kind="spike",
                       detail=f"{korean} 급증 감지 ({s.get('spike_multiplier')}배). "
                              f"{s['formula']}")
            raised += 1

    top = max(scored, key=lambda x: x["score"])
    return (f"최우선 {top.get('korean', top['label'])} {top['score']}점 "
            f"({top['grade']}, {top['freq']}건) · 알림 {raised}건 (local 대역)")


monitor = Agent(
    name="monitor",
    system=SYSTEM,
    tools=[get_window_stats, score_label, save_snapshot, raise_alert],
    max_steps=12,
    local=local_run,
)


def run_once(window_min: int = config.DEFAULT_WINDOW_MIN) -> str:
    from core import review
    review.raise_stale_alerts()            # 방치된 안전 의심 '확인 필요' 알림 (같은 민원은 한 번만)
    if not db.label_counts():
        return ""
    return monitor.run(
        f"최근 {window_min}분 구간의 민원 상황을 판정하고, "
        "즉시 대응이 필요한 유형이 있으면 알림을 올려줘.",
        ctx={"window_min": window_min},
    )
