"""D0 시드 — 관광공사 API로 경남 축제 정보를 받아 DB에 채운다.

사용법
    python scripts/seed_festival.py --list                  경남 축제 목록 보기
    python scripts/seed_festival.py --pick 유등              해당 축제를 대상으로 설정
    python scripts/seed_festival.py --list --start 20261001  특정일 이후 축제

키가 없으면 목록 조회는 실패하지만, 시스템은 config.ZONES 수기 시드로
그대로 동작한다. (Fallback 확보 — 설명회 자료 D4 '실패 대비')
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import config, db, tourapi


def show_list(start: str | None) -> None:
    if not tourapi.available():
        print("TOURAPI_KEY 가 없습니다. .env 에 추가하세요.")
        print("  발급: data.go.kr → '한국관광공사_국문 관광정보 서비스_GW' 활용신청")
        print("        → 마이페이지 → 개발계정 → 일반 인증키(Decoding)")
        return
    try:
        rows = tourapi.search_festivals(event_start=start)
    except tourapi.TourAPIError as exc:
        print(f"조회 실패: {exc}")
        return

    if not rows:
        print("결과가 없습니다. --start 날짜를 바꿔 보세요.")
        return
    print(f"경남 축제 {len(rows)}건\n")
    for r in rows:
        print(f"  [{r['content_id']}] {r['title']}")
        print(f"      {r['start_date']} ~ {r['end_date']} · {r['addr']}")


def pick(keyword: str) -> None:
    info = tourapi.lookup(keyword)
    if not info:
        print(f"'{keyword}' 조회 실패 — 수기 시드({config.FESTIVAL['name']})를 그대로 씁니다.")
        return

    db.init_db()
    with db.connect() as conn:
        conn.execute(
            """UPDATE festival SET name=?, region=?, start_date=?, end_date=?
               WHERE id=(SELECT id FROM festival LIMIT 1)""",
            (info.get("title"), info.get("addr") or config.FESTIVAL["region"],
             _fmt(info.get("start_date")), _fmt(info.get("end_date"))),
        )
        conn.commit()

    print(f"대상 축제를 설정했습니다: {info.get('title')}")
    print(f"  기간 {_fmt(info.get('start_date'))} ~ {_fmt(info.get('end_date'))}")
    print(f"  장소 {info.get('addr')}")
    if info.get("tel"):
        print(f"  연락처 {info.get('tel')}")
    print("\n출처: 한국관광공사 TourAPI — 별지2 출처신고서에 기재하세요.")


def _fmt(yyyymmdd: str | None) -> str:
    if not yyyymmdd or len(yyyymmdd) != 8:
        return yyyymmdd or ""
    return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:]}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="경남 축제 목록 조회")
    ap.add_argument("--pick", metavar="키워드", help="대상 축제 설정")
    ap.add_argument("--start", metavar="YYYYMMDD", help="조회 시작일")
    args = ap.parse_args()

    if args.list:
        show_list(args.start)
    elif args.pick:
        pick(args.pick)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
