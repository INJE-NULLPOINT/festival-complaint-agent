"""규칙 기반 분류 — local 백엔드 전용.

⚠ 이것은 제출물이 아니다. LLM_BACKEND=anthropic 으로 돌리면 ①분류 에이전트가
   이 자리를 대신하고, 이 모듈은 호출되지 않는다.

   개발 중 API 비용 없이 오케스트레이션 전체(①②③④)를 돌리기 위한 대역이다.
   키워드 규칙이라 자연어 이해가 없다. 모호한 문장·비꼬는 표현·처음 보는
   표현에서 실제 에이전트와 차이가 난다. 그 차이를 확인하는 것이 제출 전
   검증 항목이다.
"""
from . import config

# 순서가 중요하다. 위에서부터 먼저 걸리는 것을 택한다.
KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("safety", ("넘어", "어두", "조명", "불이 없", "불이 하나", "미끄러", "난간",
                "위험", "헛디", "다칠", "사고", "깜깜")),
    ("crowd", ("인파", "사람이 너무", "밀려", "몰려", "붐벼", "혼잡", "압사")),
    ("parking", ("주차", "셔틀", "갓길", "차가 못", "차량", "견인", "정체")),
    ("restroom", ("화장실", "휴지", "변기", "세면")),
    ("price", ("비싸", "바가지", "가격", "현금만", "만원", "천원", "원이나", "값이",
               "원 받", "원이라", "원씩", "원에", "결제", "카드 안")),
    ("guide", ("안내", "표지", "표시", "시간표", "길을", "헤맸", "안내도", "출구")),
    ("positive", ("예뻤", "좋았", "친절", "감사", "또 올", "최고", "멋있", "행복")),
]

# 유형별 기본 감정 강도. 실제 에이전트는 문장마다 다르게 준다.
SENTIMENT = {
    "safety": -0.85, "crowd": -0.70, "parking": -0.60, "restroom": -0.55,
    "price": -0.50, "guide": -0.45, "positive": 0.80,
}

# 규칙에 걸리지 않은 민원. 라벨 체계에 '미분류'가 없어 guide 로 넘기지만, 신뢰도가
# UNMATCHED_CONFIDENCE(< config.REVIEW_CONFIDENCE)라 classifier.save_classification 이
# 유형을 저장하지 않고 status='review'(운영자 확인)로 돌린다 (할일 D5-25).
# (실제로 "생수 한 병에 삼천 원 받더라고요"가 guide 로 떨어져 안내 유형의
#  조치요청서에 가격 민원이 인용된 적이 있다)
FALLBACK_LABEL = "guide"
MATCHED_CONFIDENCE = 0.55      # 규칙 기반이라 신뢰도를 낮게 잡는다
UNMATCHED_CONFIDENCE = 0.25    # 미분류. config.REVIEW_CONFIDENCE 아래 → review
LOW_CONFIDENCE = 0.4           # 이 아래는 인용 후보에서 후순위


def classify(text: str) -> dict:
    """민원 1건 → 분류 결과. 실제 에이전트와 같은 모양으로 돌려준다."""
    for label, keys in KEYWORDS:
        if any(k in text for k in keys):
            return _result(label, matched=True)
    return _result(FALLBACK_LABEL, matched=False)


def _result(label: str, matched: bool) -> dict:
    return {
        "label": label,
        "sentiment": SENTIMENT.get(label, -0.5),
        "is_safety": label in config.SAFETY_LABELS,
        "confidence": MATCHED_CONFIDENCE if matched else UNMATCHED_CONFIDENCE,
        "note": ("키워드 규칙 일치 (local 대역)" if matched
                 else "규칙 미일치 — 미분류 (local 대역). 실제 에이전트가 재분류해야 함"),
    }


def pick_quotes(rows: list[dict], n: int = 5) -> list[dict]:
    """인용할 대표 민원을 고른다. 구역이 겹치지 않게 섞는다.

    실제 ③조치 에이전트는 문장의 구체성까지 보고 고른다. 여기서는
    신뢰도 → 구역 분산 → 길이 순으로 본다. 규칙에 걸리지 않아 떠밀려 온
    민원(저신뢰)이 조치요청서에 인용되면 부서가 엉뚱한 문서를 받는다.
    """
    def sort_key(r):
        conf = r.get("confidence")
        low = 1 if (conf is not None and conf < LOW_CONFIDENCE) else 0
        return (low, -len(r.get("raw_text", "")))

    seen: set[str] = set()
    picked: list[dict] = []
    for r in sorted(rows, key=sort_key):
        zone = r.get("zone") or ""
        if zone in seen and len(picked) < n:
            continue
        seen.add(zone)
        picked.append(r)
        if len(picked) >= n:
            break
    if len(picked) < n:                       # 구역이 부족하면 남은 것으로 채운다
        for r in rows:
            if r not in picked:
                picked.append(r)
            if len(picked) >= n:
                break
    return picked[:n]


def suggestions_for(label: str) -> list[str]:
    """local 대역의 조치 제안. config.ACTION_CATALOG(참고 예시) 앞 3개를 쓴다."""
    return config.ACTION_CATALOG.get(label, ["담당 부서 현장 확인 후 조치 방안 수립"])[:3]
