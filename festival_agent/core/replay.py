"""리플레이 엔진 — 과거 민원을 타임스탬프 순서대로 배속 재생한다.

왜 필요한가
  실시간 시스템은 3분 영상에서 '실시간임'을 보여주기 어렵다. 며칠치 민원이
  쌓이면서 심각도 순위가 뒤집히는 장면이 이 과제의 결론인데, 실제로 며칠을
  기다릴 수는 없다. 그래서 재생 기능을 **제품 기능으로** 넣는다.
  개발 중 테스트에도 그대로 쓰인다.

설계
  상태를 DB에 둔다. 워커와 대시보드가 서로 다른 프로세스라도 같은 재생
  상태를 본다. step()을 호출할 때마다 '지금 시각까지 도달한' 민원을 넣는다.
"""
import csv
from datetime import datetime, timedelta
from pathlib import Path

from . import db

SCHEMA = """
CREATE TABLE IF NOT EXISTS replay_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  csv_path TEXT, speed REAL, sim_start TEXT, wall_start TEXT,
  active INTEGER DEFAULT 0, cursor INTEGER DEFAULT 0, total INTEGER DEFAULT 0
);
"""


def ensure() -> None:
    with db.connect() as conn:
        conn.executescript(SCHEMA)
        conn.commit()


def load_rows(csv_path: str | Path) -> list[dict]:
    """CSV → [{posted_at, zone, text}] (posted_at 오름차순)."""
    path = Path(csv_path)
    if not path.exists():
        raise FileNotFoundError(f"시드 파일 없음: {path}")
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("text") or "").strip()]
    rows.sort(key=lambda r: r.get("posted_at") or "")
    return rows


def start(csv_path: str | Path, speed: float = 60.0) -> dict:
    """재생 시작. speed=60 이면 1초에 60초치가 흐른다."""
    ensure()
    rows = load_rows(csv_path)
    if not rows:
        raise ValueError("시드가 비어 있습니다")

    with db.connect() as conn:
        conn.execute("DELETE FROM replay_state")
        conn.execute(
            """INSERT INTO replay_state
               (id, csv_path, speed, sim_start, wall_start, active, cursor, total)
               VALUES (1,?,?,?,?,1,0,?)""",
            (str(csv_path), speed, rows[0]["posted_at"], db.now(), len(rows)),
        )
        conn.commit()
    return {"total": len(rows), "speed": speed, "sim_start": rows[0]["posted_at"]}


def stop() -> None:
    ensure()
    with db.connect() as conn:
        conn.execute("UPDATE replay_state SET active=0 WHERE id=1")
        conn.commit()


def state() -> dict | None:
    ensure()
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM replay_state WHERE id=1").fetchone()
    return dict(row) if row else None


def sim_now(st: dict) -> datetime:
    """현재 시뮬레이션 시각."""
    elapsed = (datetime.now() - datetime.fromisoformat(st["wall_start"])).total_seconds()
    return datetime.fromisoformat(st["sim_start"]) + timedelta(seconds=elapsed * st["speed"])


def step(max_batch: int = 40) -> int:
    """지금 시각까지 도달한 민원을 투입한다. 투입 건수를 돌려준다."""
    st = state()
    if not st or not st["active"]:
        return 0

    rows = load_rows(st["csv_path"])
    cursor = st["cursor"]
    if cursor >= len(rows):
        stop()
        db.log_agent("replay", "finished", output_summary=f"{len(rows)}건 재생 완료")
        return 0

    now_sim = sim_now(st)
    zone_by_name = {z["name"]: z["id"] for z in db.zones()}

    inserted = 0
    while cursor < len(rows) and inserted < max_batch:
        r = rows[cursor]
        try:
            posted = datetime.fromisoformat(r["posted_at"])
        except (TypeError, ValueError):
            cursor += 1
            continue
        if posted > now_sim:
            break

        # 비었거나 모르는 구역은 NULL(구역 미상). 첫 구역으로 넣으면 집중도가 그쪽으로 쏠린다.
        zid = zone_by_name.get((r.get("zone") or "").strip())
        if db.insert_feedback(zid, r["text"], source="replay",
                              posted_at=r["posted_at"]) is not None:
            inserted += 1
        cursor += 1

    with db.connect() as conn:
        conn.execute("UPDATE replay_state SET cursor=? WHERE id=1", (cursor,))
        conn.commit()

    if inserted:
        db.log_agent("replay", "inject", f"{inserted}건",
                     f"시뮬레이션 시각 {now_sim.strftime('%m-%d %H:%M')}",
                     f"{cursor}/{len(rows)} 진행")
    return inserted


def progress() -> dict | None:
    st = state()
    if not st:
        return None
    return {
        "active": bool(st["active"]),
        "cursor": st["cursor"],
        "total": st["total"],
        "speed": st["speed"],
        "sim_now": sim_now(st).strftime("%m-%d %H:%M") if st["active"] else "-",
    }
