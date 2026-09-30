"""심각도 계산 — 이 과제의 심장.

★ 여기에는 LLM이 없다. 에이전트는 이 함수를 '도구'로 호출만 한다.
   같은 입력 → 항상 같은 점수. 계산식 문자열을 함께 돌려주므로
   화면에 근거를 그대로 띄울 수 있다.

규칙 (설계 문서 S-01 ~ S-06)
  S-01 기본점수 = 윈도우 내 빈도 60% + 부정강도 40%
  S-02 안전 관련 ×2.0
  S-03 급증 ×1.5      (최근 15분 유입률 >= 직전 60분 평균 × 2)
  S-04 안전 N건 이상이면 점수와 무관하게 immediate
  S-05 positive 는 심각도에서 제외
  S-06 미조치 30분 경과 ×1.2

경계 규칙 (한가한 창에서 1건이 100점·즉시가 되지 않게 — 할일 D5-25)
  B-01 빈도비 = freq / max(창 전체 건수, MIN_WINDOW_TOTAL)      창이 10건 미만이면 비율 항목을 부풀리지 않는다
  B-02 급증은 최근 구간에 SPIKE_MIN_RECENT(3)건 이상일 때만     기준선이 최근 건까지 포함해 1건이 늘 4.0배로 잡히던 문제
  B-03 비안전 유형이 5건 미만이면 점수를 79.9 로 자른다         (최고 high). formula 끝에 표시
  B-04 안전 유형은 1건이라도 점수 하한 60 (최소 high)           S-04(3건 이상 즉시)는 그대로
"""
from collections import defaultdict
from datetime import datetime, timedelta

from . import config


GRADE_ORDER = {"immediate": 0, "high": 1, "mid": 2, "low": 3}


def grade_of(score: float) -> str:
    for cutoff, name in config.GRADE_CUTOFF:
        if score >= cutoff:
            return name
    return "low"


def compute_severity(freq: int, avg_sentiment: float, total: int, *,
                     is_safety: bool = False, spiked: bool = False,
                     unhandled: bool = False) -> dict:
    """라벨 1개의 심각도. 결정적 함수 — 무작위성 없음."""
    freq_ratio = freq / max(total, config.MIN_WINDOW_TOTAL) if freq else 0.0   # B-01
    intensity = max(0.0, -avg_sentiment)          # 부정일수록 커짐 (0.0~1.0)

    base = freq_ratio * config.W_FREQ + intensity * config.W_INTENSITY   # S-01
    safety_w = config.W_SAFETY if is_safety else 1.0                     # S-02
    spike_w = config.W_SPIKE if spiked else 1.0                          # S-03
    pending_w = config.W_PENDING if unhandled else 1.0                   # S-06

    score = min(100.0, base * safety_w * spike_w * pending_w)

    note = ""
    if is_safety:
        if freq >= 1 and score < config.SAFETY_FLOOR:                    # B-04
            score = config.SAFETY_FLOOR
            note = f" (안전 → 하한 {config.SAFETY_FLOOR:.0f})"
    elif freq < config.NONSAFETY_IMMEDIATE_MIN and score > config.NONSAFETY_CAP:   # B-03
        score = config.NONSAFETY_CAP
        note = f" (비안전 {config.NONSAFETY_IMMEDIATE_MIN}건 미만 → 상한 {config.NONSAFETY_CAP})"

    if is_safety and freq >= config.SAFETY_THRESHOLD:                    # S-04
        grade = "immediate"
    else:
        grade = grade_of(score)

    formula = (
        f"({freq_ratio:.2f}×{config.W_FREQ:.0f} + {intensity:.2f}×{config.W_INTENSITY:.0f})"
        f" × 안전{safety_w} × 급증{spike_w} × 미조치{pending_w} = {score:.1f}{note}"
    )
    return {
        "freq": freq, "avg_sentiment": round(avg_sentiment, 3),
        "base_score": round(base, 2), "safety_w": safety_w,
        "spike_w": spike_w, "pending_w": pending_w,
        "score": round(score, 1), "grade": grade, "formula": formula,
    }


def detect_spike(rows, label: str,
                 window_min: int = config.SPIKE_WINDOW_MIN,
                 baseline_min: int = config.SPIKE_BASELINE_MIN,
                 ref: datetime | None = None) -> dict:
    """최근 window_min 유입률이 baseline_min 평균의 N배 이상인가. (S-03)

    기준 시각(ref)은 민원 발생 시간선을 따른다. 리플레이로 과거 데이터를
    한꺼번에 넣어도 전부 급증으로 잡히지 않는다.
    """
    nowt = ref or datetime.now()
    w_cut = nowt - timedelta(minutes=window_min)
    b_cut = nowt - timedelta(minutes=baseline_min)

    recent = base = 0
    for r in rows:
        if r["label"] != label:
            continue
        try:
            t = datetime.fromisoformat(r["posted_at"])
        except (TypeError, ValueError):
            continue
        if t >= b_cut:
            base += 1
        if t >= w_cut:
            recent += 1

    rate = recent / window_min                       # 분당 유입
    baseline = base / baseline_min if base else 0.0
    spiked = (baseline > 0 and rate >= baseline * config.SPIKE_MULTIPLIER
              and recent >= config.SPIKE_MIN_RECENT)              # B-02
    return {
        "label": label, "recent": recent, "rate": round(rate, 3),
        "baseline": round(baseline, 3),
        "multiplier": round(rate / baseline, 2) if baseline else 0.0,
        "spiked": bool(spiked),
    }


def rank_labels(rows, unhandled_fn=None, ref: datetime | None = None) -> list[dict]:
    """윈도우 행들을 받아 라벨별 심각도를 계산하고 점수순으로 돌려준다.

    rows: db.window_rows() 결과 (label / sentiment / is_safety / ingested_at)
    unhandled_fn: label -> bool. 미조치 경과 여부 (S-06). 없으면 전부 False.
    """
    buckets: dict[str, list] = defaultdict(list)
    for r in rows:
        if r["label"] in config.EXCLUDED_FROM_SEVERITY:   # S-05
            continue
        buckets[r["label"]].append(r)

    total = sum(len(v) for v in buckets.values())
    out = []
    for label, items in buckets.items():
        avg = sum((i["sentiment"] or 0.0) for i in items) / len(items)
        is_safety = label in config.SAFETY_LABELS or any(i["is_safety"] for i in items)
        spike = detect_spike(rows, label, ref=ref)
        unhandled = bool(unhandled_fn(label)) if unhandled_fn else False

        res = compute_severity(
            freq=len(items), avg_sentiment=avg, total=total,
            is_safety=is_safety, spiked=spike["spiked"], unhandled=unhandled,
        )
        res.update(label=label, spike=spike)
        out.append(res)

    # 정렬: 등급 → 안전 계열(안전·혼잡) 먼저 → 점수. 점수만으로 세우면 S-04 로 '즉시'가 된 혼잡이
    # 점수가 더 높은 '높음' 주차 아래로 내려간다. 관제 카드(core/issues.py)와 같은 원칙이다.
    out.sort(key=lambda r: (GRADE_ORDER[r["grade"]], -int(r["safety_w"] > 1), -r["score"]))
    return out
