"""개발·시연용 샘플 민원 CSV를 생성한다.

⚠ 주의 — 이 파일이 만드는 데이터는 **개발용 합성 데이터**입니다.
   실제 방문객이 쓴 리뷰가 아닙니다.
   제출용 리플레이 시드(200건)는 **공개 리뷰를 직접 수집·정제한 것**으로
   교체해야 합니다. 합성 데이터를 실제 수집분인 것처럼 제출하면
   설명회 주의사항 13번(허위·조작 금지) 위반입니다.

   개발 중 파이프라인을 돌려보고, 심각도 역전 장면을 리허설하는 용도입니다.

사용법
    python scripts/make_dev_seed.py                  # seed/dev_sample.csv 생성
    python scripts/make_dev_seed.py --rows 200       # 건수 지정
"""
import argparse
import csv
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import config

OUT = Path(__file__).resolve().parent.parent / "seed" / "dev_sample.csv"

# 유형별 예시 문장 (합성)
TEXTS = {
    "parking": [
        "주차장에서 나가는 데 한 시간 넘게 걸렸어요",
        "주차 안내가 없어서 계속 같은 자리만 돌았습니다",
        "주차장이 이미 만차인데 입구에서 알려주지 않아요",
        "갓길에 다 세워놔서 차가 아예 못 지나갑니다",
        "주차 요원이 한 명뿐이라 정리가 안 됩니다",
        "임시주차장 위치를 아무도 모릅니다",
        "나가는 길이 한 차선이라 계속 막혀요",
    ],
    "restroom": [
        "화장실 줄이 너무 깁니다 삼십 분 기다렸어요",
        "임시 화장실에 휴지가 없습니다",
        "화장실 위치 안내판이 안 보여요",
        "여자 화장실만 줄이 너무 깁니다",
        "화장실이 너무 더럽고 냄새가 심해요",
    ],
    "price": [
        "어묵 한 그릇에 만 원은 너무합니다",
        "작년보다 음식값이 두 배는 오른 것 같아요",
        "현금만 받는 가게가 많아서 불편했습니다",
        "가격표가 안 붙어 있어서 나중에 비싸게 받았어요",
        "생수 한 병에 삼천 원 받더라고요",
    ],
    "guide": [
        "안내도가 입구에만 있어서 중간에 길을 잃었어요",
        "프로그램 시간표를 어디서 보는지 모르겠습니다",
        "안내요원에게 물어봤는데 모른다고 하네요",
        "출구 표시가 없어서 한참 헤맸습니다",
    ],
    "crowd": [
        "다리 위에 사람이 너무 몰려서 위험했어요",
        "인파 때문에 아이 손을 놓칠 뻔했습니다",
        "좁은 길에 양방향 통행이라 밀려다녔어요",
    ],
    "safety": [
        "진입로에 불이 하나도 없어서 어두워서 넘어졌어요",
        "가로등이 없는 구간에서 발을 헛디뎠습니다",
        "조명이 꺼져 있어 바닥이 안 보입니다",
        "어두운 계단에서 미끄러질 뻔했어요",
        "난간이 흔들려서 위험해 보입니다",
    ],
    "positive": [
        "등이 정말 예뻤어요 내년에 또 올게요",
        "아이들이 너무 좋아했습니다 감사합니다",
        "야경이 사진으로 담기지 않을 만큼 좋았어요",
        "자원봉사자분들이 정말 친절했습니다",
    ],
}

# 유형별 등장 비중 — 주차가 압도적으로 많고 안전은 적다.
# (건수 1위와 심각도 1위가 갈리는 장면을 만들기 위한 구성)
WEIGHTS = {
    "parking": 30, "restroom": 18, "price": 16, "guide": 13,
    "positive": 14, "crowd": 5, "safety": 4,
}

ZONE_HINT = {
    "parking": ["진주교 남단 주차장", "셔틀버스 승강장"],
    "restroom": ["임시 화장실 A", "먹거리장터"],
    "price": ["먹거리장터"],
    "guide": ["촉석루 일원", "유등터널"],
    "crowd": ["유등터널", "남강 수상무대"],
    "safety": ["진주교 남단 주차장", "소망등 달기 구역"],
    "positive": ["남강 수상무대", "촉석루 일원"],
}


def generate(n: int, days: int = 4, seed: int = 20261006) -> list[dict]:
    rng = random.Random(seed)
    start = datetime.now().replace(hour=17, minute=0, second=0, microsecond=0) \
        - timedelta(days=days)

    labels = list(WEIGHTS)
    weights = [WEIGHTS[k] for k in labels]

    rows = []
    for i in range(n):
        day = i * days / n
        # 축제는 저녁에 사람이 몰린다 (17시~22시)
        t = start + timedelta(days=day, minutes=rng.randint(0, 300))
        label = rng.choices(labels, weights=weights, k=1)[0]

        # 마지막 날 후반부에 안전(조명) 민원을 집중시켜 급증을 만든다
        if day > days - 0.35 and rng.random() < 0.45:
            label = "safety"

        rows.append({
            "posted_at": t.isoformat(timespec="seconds"),
            "zone": rng.choice(ZONE_HINT.get(label, config.ZONES)),
            "text": rng.choice(TEXTS[label]),
            "_label_hint": label,        # 정확도 측정용 정답 라벨
        })
    rows.sort(key=lambda r: r["posted_at"])
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=120)
    ap.add_argument("--days", type=int, default=4)
    args = ap.parse_args()

    rows = generate(args.rows, args.days)
    OUT.parent.mkdir(exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["posted_at", "zone", "text", "_label_hint"])
        w.writeheader()
        w.writerows(rows)

    from collections import Counter
    dist = Counter(r["_label_hint"] for r in rows)
    print(f"생성: {OUT}  ({len(rows)}건, {args.days}일치)")
    print("유형 분포 (건수 기준)")
    for k, v in dist.most_common():
        print(f"  {config.LABELS.get(k, k):<10} {v:>4}건")
    print("\n⚠ 개발용 합성 데이터입니다. 제출용 시드는 실제 수집 리뷰로 교체하세요.")
    print("   _label_hint 열은 분류 정확도 측정용 정답이며, 시스템은 읽지 않습니다.")


if __name__ == "__main__":
    main()
