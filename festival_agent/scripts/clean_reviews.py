"""사람이 직접 모은 공개 리뷰 CSV → 리플레이 시드 (할일 D6-6).

**수집은 사람이 한다.** 이 스크립트는 정제만 하고, 문장을 만들거나 고치지 않는다.
합성 데이터를 실제 수집분으로 제출하면 설명회 주의사항 13번(허위·조작) 위반이다.

입력: scripts/templates/real_reviews_template.csv 와 같은 열
    posted_at      리뷰 작성 시각 (ISO. 날짜만 있으면 날짜만 — 시각을 지어내지 않는다)
    zone           구역 이름 (core/config.py ZONES 중 하나, 모르면 빈칸)
    text           리뷰 원문 (한 줄로 옮긴 것)
    _label_hint    사람이 붙인 정답 유형 (정확도 측정용, 선택)
    source_url     리뷰가 있던 공개 주소 (필수)
    source_name    출처 이름 (예: 블로그 · 지도 앱 리뷰 · 커뮤니티)
    collected_at   수집한 날짜

하는 일
  개인정보 마스킹(core/privacy.mask) · 공백 정리 · 길이 필터(5~500자) ·
  같은 문장 중복 제거 · source_url 없는 행 제외 · 유형·구역 값 검사
  → seed/real_reviews.csv + 정제 결과 요약 출력

    python scripts/clean_reviews.py 수집원문.csv
    python scripts/clean_reviews.py 수집원문.csv --out seed/real_reviews.csv
"""
import argparse
import csv
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import config, privacy  # noqa: E402

COLUMNS = ["posted_at", "zone", "text", "_label_hint", "source_url", "source_name", "collected_at"]
MIN_LEN, MAX_LEN = 5, 500        # 500 은 접수 RPC 와 같은 상한


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="사람이 모은 원문 CSV")
    ap.add_argument("--out", default=str(ROOT / "seed" / "real_reviews.csv"))
    args = ap.parse_args()

    src = Path(args.src)
    if src.name == "dev_sample.csv":
        print("dev_sample.csv 는 합성 데이터입니다. 실제 수집분만 넣으세요.")
        return 1
    with src.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        missing = {"posted_at", "text", "source_url"} - set(reader.fieldnames or [])
        if missing:
            print(f"필수 열이 없습니다: {', '.join(sorted(missing))} "
                  "(scripts/templates/real_reviews_template.csv 참고)")
            return 1
        rows = list(reader)

    zones = set(config.ZONES)
    drop: Counter = Counter()
    notes: Counter = Counter()
    seen: set[str] = set()
    out = []
    for r in rows:
        text = re.sub(r"\s+", " ", (r.get("text") or "")).strip()
        url = (r.get("source_url") or "").strip()
        posted = (r.get("posted_at") or "").strip()
        if not url:
            drop["출처 URL 없음"] += 1
            continue
        try:
            when = datetime.fromisoformat(posted)
        except ValueError:
            drop["작성 시각 형식 오류"] += 1
            continue
        if len(text) < MIN_LEN or len(text) > MAX_LEN:
            drop[f"길이 {MIN_LEN}~{MAX_LEN}자 밖"] += 1
            continue
        masked = privacy.mask(text)
        key = re.sub(r"\W", "", masked)
        if key in seen:
            drop["중복 문장"] += 1
            continue
        seen.add(key)
        if masked != text:
            notes["개인정보 마스킹"] += 1
        if privacy.looks_like_injection(masked):
            notes["인젝션 의심 표현 (그대로 둠 · 확인 필요)"] += 1
        if len(posted) <= 10:
            notes["작성 시각이 날짜뿐 (시각 미상)"] += 1
        label = (r.get("_label_hint") or "").strip()
        if label and label not in config.LABELS:
            notes[f"모르는 유형 '{label}' → 비움"] += 1
            label = ""
        zone = (r.get("zone") or "").strip()
        if zone and zone not in zones:
            notes[f"모르는 구역 '{zone}' → 비움"] += 1
            zone = ""
        out.append({
            "posted_at": when.isoformat(timespec="seconds") if len(posted) > 10 else posted,
            "zone": zone, "text": masked, "_label_hint": label, "source_url": url,
            "source_name": (r.get("source_name") or "").strip(),
            "collected_at": (r.get("collected_at") or "").strip(),
        })

    out.sort(key=lambda r: r["posted_at"])
    dst = Path(args.out)
    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(out)

    labeled = sum(1 for r in out if r["_label_hint"])
    print(f"입력 {len(rows)}행 → 출력 {len(out)}행  ({dst})")
    for k, v in drop.most_common():
        print(f"  제외  {k}: {v}")
    for k, v in notes.most_common():
        print(f"  표시  {k}: {v}")
    print(f"  출처  {len(Counter(r['source_name'] for r in out))}종 · "
          f"정답 라벨 {labeled}행 · 구역 지정 {sum(1 for r in out if r['zone'])}행")
    if len(out) < 100:
        print("  ※ 100행 미만입니다. 할일 D6-6 판정은 출처 URL 이 있는 행 100개 이상부터 통과합니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
