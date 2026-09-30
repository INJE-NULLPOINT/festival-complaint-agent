"""시연 영상용 합성 시나리오 (D7-1) — 배경 민원 24건 즉시 투입 + 휴대폰 입력을 대신할 예약 2건.

모든 문장은 시연용으로 **지어낸 가상 민원**이다 (source='demo'). 실제 수집 민원이라고 말하지 않는다.
기본 DB 는 운영 DB(festival.db)가 아니라 별도 파일 output/demo_festival.db 이다.

사용법
    python scripts/demo_scenario.py --dry-run               넣지 않고 계획만 보기 (DB 를 만들지도 않음)
    python scripts/demo_scenario.py --reset                 시연 DB 를 비우고 다시 만든 뒤 투입 (테이크마다)
    python scripts/demo_scenario.py --reset --lead 120      녹화 시작 T = 지금 + 120초 (기본 90초)
    python scripts/demo_scenario.py --at 2026-10-04T14:00:00 --reset     T 를 직접 지정
    python scripts/demo_scenario.py --no-wait               배경 24건만 넣고 예약 2건은 넣지 않음
    python scripts/demo_scenario.py --db output/take2.db --reset

흐름
    ① 배경 24건을 posted_at = T-40분 ~ T-1분에 흩어 바로 넣는다 (서로 다른 문장, 전부 비안전).
    ② 시연 DB 로 워커를 띄워 두고(아래) 배경 분류가 끝나면 T 에 맞춰 녹화를 시작한다.
    ③ 이 스크립트는 T+40초·T+50초에 유등터널 혼잡 2건을 넣는다 (posted_at=그 시각, 시간선 속도 1).
       휴대폰 입력(T+30초 전후)은 사람이 직접 한다.

시연 DB 로 돌리는 법 (PowerShell)
    $env:DB_PATH = "output/demo_festival.db"
    python worker.py            # 분류·브리핑·카드  (별도 창)
    python webapi.py            # 관제 화면 API    (별도 창)
    → 같은 DB_PATH 를 두 창 모두에 줘야 한다. 운영 festival.db 는 건드리지 않는다.

시연 전제: 자막으로 '배경 민원 24건과 혼잡 2건은 개발용 합성 시나리오' 임을 밝힌다.
"""
import argparse
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DEFAULT_DB = ROOT / "output" / "demo_festival.db"
SOURCE = "demo"

# (구역, 문장) — 24건. 서로 다른 문장, 전부 비안전. 주차/교통 12 · 화장실 5 · 가격 4 · 안내 2 · 홍보성 1.
BACKGROUND = [
    # 주차/교통 12 — 진주교 남단 주차장 8, 셔틀버스 승강장 4
    ("진주교 남단 주차장", "주차장이 벌써 만차라서 한참을 돌다가 겨우 자리를 찾았어요"),
    ("진주교 남단 주차장", "주차 자리를 기다리는 차들이 길게 늘어서서 진입로가 꽉 막혀 있어요"),
    ("진주교 남단 주차장", "주차 안내 요원이 없어서 차들이 제멋대로 세워 두었어요"),
    ("진주교 남단 주차장", "주차장에서 나가는 데만 오래 걸려서 일정이 다 틀어졌습니다"),
    ("진주교 남단 주차장", "임시 주차장 위치를 알 수 없어서 주변 도로를 계속 돌았어요"),
    ("진주교 남단 주차장", "주차 요금을 받는 곳이 하나뿐이라 출차 줄이 너무 깁니다"),
    ("진주교 남단 주차장", "대형 주차장이 가득 찬 뒤에도 차를 계속 들여보내서 뒤엉켰어요"),
    ("진주교 남단 주차장", "주차하고 행사장까지 걸어가는 길 안내가 부족해서 불편했어요"),
    ("셔틀버스 승강장", "셔틀버스가 한참 동안 오지 않아서 승강장에서 오래 서 있었어요"),
    ("셔틀버스 승강장", "셔틀버스 배차 간격이 너무 길어서 돌아가는 시간이 늦어졌어요"),
    ("셔틀버스 승강장", "버스 승강장 줄이 어디서 시작하는지 알 수 없어서 헷갈렸어요"),
    ("셔틀버스 승강장", "마지막 셔틀버스 시간을 알려 주는 표지가 없어서 불안했어요"),
    # 화장실 5
    ("임시 화장실 A", "임시 화장실 앞에 줄이 너무 길어서 한참 기다렸어요"),
    ("임시 화장실 A", "화장실 휴지가 다 떨어져서 그냥 나왔습니다"),
    ("임시 화장실 A", "화장실 안이 지저분해서 사용하기가 꺼려졌어요"),
    ("임시 화장실 A", "화장실 수가 너무 적어서 아이를 데리고 가기가 힘들었어요"),
    ("임시 화장실 A", "화장실 세면대에 물이 안 나와서 손을 못 씻었어요"),
    # 가격 4
    ("먹거리장터", "먹거리장터 음식 가격이 다른 곳보다 터무니없이 비싸요"),
    ("먹거리장터", "메뉴판에 적힌 것보다 더 많이 받아서 당황했어요"),
    ("먹거리장터", "양은 적은데 가격만 높아서 바가지를 쓴 기분이에요"),
    ("먹거리장터", "가격표가 없는 가게가 많아서 얼마를 내야 할지 몰랐어요"),
    # 안내 2
    ("촉석루 일원", "촉석루 쪽으로 가는 길을 알려 주는 표지판이 부족해서 헤맸어요"),
    ("소망등 달기 구역", "소망등 달기 체험 장소와 시간이 안내되지 않아서 물어보고 다녔어요"),
    # 홍보성 장난 1 — 지우기 장면용
    ("먹거리장터", "동네 치킨집 홍보합니다 지금 전화 주시면 할인해 드려요 많이 이용해 주세요"),
]
assert len(BACKGROUND) == 24 and len({t for _, t in BACKGROUND}) == 24

# 예약 2건 — 유등터널 혼잡 (T+40초, T+50초)
RESERVED = [
    (40, "유등터널", "유등터널 안에서 사람들이 한꺼번에 몰려서 앞으로 나갈 수가 없어요"),
    (50, "유등터널", "터널 입구에 사람이 계속 들어와서 안쪽이 너무 붐비고 떠밀려요"),
]


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def plan(t0: datetime):
    """배경 24건의 posted_at 을 T-40분 ~ T-1분에 균등하게 흩는다 (구역 순서와 무관하게 섞이도록 섞어 배치)."""
    n = len(BACKGROUND)
    order = [(i * 7) % n for i in range(n)]            # 7 과 24 는 서로소 → 모든 문장이 한 번씩, 순서는 섞임
    step = 39 * 60 / (n - 1)                            # 40분 전 ~ 1분 전
    rows = []
    for slot, idx in enumerate(order):
        zone, text = BACKGROUND[idx]
        rows.append((zone, text, t0 - timedelta(seconds=round(40 * 60 - slot * step))))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--db", default=str(DEFAULT_DB), help="시연 DB 파일 (기본 output/demo_festival.db)")
    ap.add_argument("--dry-run", action="store_true", help="넣지 않고 계획만 출력 (DB 를 만들지도 않음)")
    ap.add_argument("--reset", action="store_true", help="시연 DB 파일을 지우고 새로 만든다")
    ap.add_argument("--at", help="녹화 시작 시각 T (YYYY-MM-DDTHH:MM:SS). 없으면 지금 + --lead")
    ap.add_argument("--lead", type=int, default=90, help="--at 이 없을 때 T = 지금 + N초 (기본 90)")
    ap.add_argument("--no-wait", action="store_true", help="배경 24건만 넣고 예약 2건은 넣지 않는다")
    args = ap.parse_args()

    t0 = datetime.fromisoformat(args.at) if args.at else datetime.now().replace(microsecond=0) + timedelta(seconds=args.lead)
    rows = plan(t0)
    db_path = Path(args.db).resolve()

    print(f"녹화 시작 시각 T = {_iso(t0)}   시연 DB = {db_path}")
    if db_path == (ROOT / "festival.db").resolve():
        print("거부: 운영 DB(festival.db)에는 시연 데이터를 넣지 않습니다. --db 로 다른 파일을 주세요.")
        return 1
    print(f"\n배경 {len(rows)}건 (posted_at T-40분 ~ T-1분, source='{SOURCE}'):")
    for zone, text, at in sorted(rows, key=lambda r: r[2]):
        print(f"  {at:%H:%M:%S}  [{zone}] {text}")
    print("\n예약 (휴대폰 입력은 사람이 T+30초 전후에 직접):")
    for sec, zone, text in RESERVED:
        print(f"  T+0:{sec:02d}  {_iso(t0 + timedelta(seconds=sec))}  [{zone}] {text}")
    if args.dry_run:
        print("\n(--dry-run: 아무것도 넣지 않았습니다)")
        return 0

    # config 는 import 때 DB_PATH 를 읽으므로, core 를 불러오기 전에 정한다.
    os.environ["DB_PATH"] = str(db_path)
    os.environ["SUPABASE_DB_URL"] = ""                   # 시연은 항상 SQLite — Supabase 운영 데이터에 넣지 않는다
    from core import config, db
    if config.SUPABASE_DB_URL or Path(config.DB_PATH).resolve() != db_path:
        print("거부: 시연 DB 설정이 적용되지 않았습니다. 넣지 않습니다.")
        return 1

    if args.reset:
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(db_path) + suffix)
            if p.exists():
                p.unlink()
    elif db_path.exists():
        with db.connect() as conn:
            left = conn.execute("SELECT COUNT(*) AS n FROM feedback").fetchone()["n"]
        if left:
            print(f"거부: 시연 DB 에 이미 민원 {left}건이 있습니다. 새 테이크는 --reset 으로 시작하세요.")
            return 1
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db.init_db()
    zone_id = {z["name"]: z["id"] for z in db.zones()}

    done = 0
    for zone, text, at in rows:
        if db.insert_feedback(zone_id[zone], text, source=SOURCE, posted_at=_iso(at)):
            done += 1
    print(f"\n배경 {done}/{len(rows)}건을 넣었습니다.")
    print("이제 같은 DB_PATH 로 worker.py 를 띄워 배경 분류가 끝나게 두세요 (끝나기 전에는 녹화를 시작하지 않습니다).")

    if args.no_wait:
        print("--no-wait: 예약 2건은 넣지 않았습니다.")
        return 0

    print(f"\nT({t0:%H:%M:%S})까지 기다린 뒤 예약 2건을 넣습니다. Ctrl+C 로 멈추면 예약은 넣지 않습니다.")
    try:
        for sec, zone, text in RESERVED:
            due = t0 + timedelta(seconds=sec)
            while (left := (due - datetime.now()).total_seconds()) > 0:
                print(f"\r  다음 예약까지 {left:5.0f}초 ", end="", flush=True)
                time.sleep(min(1.0, left))
            fid = db.insert_feedback(zone_id[zone], text, source=SOURCE, posted_at=_iso(datetime.now().replace(microsecond=0)))
            print(f"\r  T+0:{sec:02d} 투입 → 민원 #{fid}          ")
    except KeyboardInterrupt:
        print("\n중단했습니다 (남은 예약은 넣지 않았습니다).")
        return 130
    print("끝. 이 DB 와 agent_log 는 영상 원본과 함께 보관하세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
