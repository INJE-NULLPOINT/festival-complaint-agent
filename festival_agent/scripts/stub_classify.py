"""개발용 스텁 분류기 — LLM 호출 없이 파이프라인을 검증한다.

⚠ 이것은 **개발 도구이지 제품이 아니다.** 제출물에서 분류는 ①분류 에이전트가
   수행한다. 이 스크립트는 다음 두 경우에만 쓴다.
     1. API 키 없이 접수→심각도→대시보드 흐름을 확인할 때
     2. 시연 리허설에서 API 비용·지연 없이 화면 동선을 맞출 때

   dev_sample.csv 의 _label_hint 열(정답 라벨)을 읽어 그대로 채운다.
   실제 리뷰 시드에는 이 열이 없으므로 키워드 규칙으로 대체된다.

사용법
    python scripts/stub_classify.py            대기열 전부 처리
    python scripts/stub_classify.py --reset    분류 결과 초기화
"""
import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import config, db

SEED = Path(__file__).resolve().parent.parent / "seed" / "dev_sample.csv"

# _label_hint 가 없을 때 쓰는 키워드 규칙 (스텁 전용, 조잡해도 된다)
RULES = [
    ("safety", ["넘어", "어두", "조명", "불이", "미끄러", "난간", "위험", "헛디"]),
    ("crowd", ["인파", "사람이 너무", "밀려", "몰려"]),
    ("parking", ["주차", "차가", "셔틀", "갓길"]),
    ("restroom", ["화장실", "휴지"]),
    ("price", ["원", "비싸", "가격", "현금", "값"]),
    ("guide", ["안내", "표시", "시간표", "길을"]),
    ("positive", ["예뻤", "좋았", "친절", "감사", "또 올"]),
]

SENTIMENT = {"safety": -0.85, "crowd": -0.7, "parking": -0.6,
             "restroom": -0.55, "price": -0.5, "guide": -0.45, "positive": 0.8}


def hints() -> dict[str, str]:
    """text → 정답 라벨 (dev_sample.csv 에만 존재)."""
    if not SEED.exists():
        return {}
    with SEED.open(encoding="utf-8-sig", newline="") as f:
        return {r["text"]: r.get("_label_hint", "")
                for r in csv.DictReader(f) if r.get("_label_hint")}


def guess(text: str) -> str:
    for label, keys in RULES:
        if any(k in text for k in keys):
            return label
    return "guide"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="분류 결과를 대기 상태로 되돌림")
    args = ap.parse_args()

    db.init_db()

    if args.reset:
        with db.connect() as conn:
            conn.execute("UPDATE classification SET status='pending', label=NULL, "
                         "sentiment=NULL, is_safety=NULL, confidence=NULL")
            conn.execute("DELETE FROM severity")
            conn.execute("DELETE FROM alert")
            conn.commit()
        print("초기화 완료 · 대기열", db.pending_count(), "건")
        return

    table = hints()
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT c.feedback_id, f.raw_text FROM classification c
               JOIN feedback f ON f.id=c.feedback_id WHERE c.status='pending'"""
        ).fetchall()

    n = 0
    for r in rows:
        text = r["raw_text"]
        label = table.get(text) or guess(text)
        if label not in config.LABELS:
            label = "guide"
        is_safety = 1 if label in config.SAFETY_LABELS else 0
        with db.connect() as conn:
            conn.execute(
                """UPDATE classification SET label=?, sentiment=?, is_safety=?,
                   confidence=?, status='done', processed_at=?, agent_note='STUB(개발용)'
                   WHERE feedback_id=?""",
                (label, SENTIMENT.get(label, -0.5), is_safety, 0.6,
                 db.now(), r["feedback_id"]),
            )
            conn.commit()
        n += 1

    db.log_agent("stub", "classify", f"{n}건", "개발용 스텁 — 제품 경로 아님")
    print(f"스텁 분류 {n}건 완료 (agent_note='STUB(개발용)' 으로 표시됨)")
    print("실제 제출물에서는 ①분류 에이전트가 이 역할을 합니다.")


if __name__ == "__main__":
    main()
