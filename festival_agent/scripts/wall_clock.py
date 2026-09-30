"""접수 → 분류 완료 벽시계 측정 (워커 폴링 포함) — 임시 DB, 운영 DB는 쓰지 않는다.

실제 worker.py(--no-agents)를 띄우고, 웹 접수(feedback_inbox)로 민원을 넣은 뒤 분류가 끝날 때까지 시간을 잰다.
호출 시간이 아니라 '접수 → 분류 완료' 전체(워커 수거 3초 주기 + 분류 주기 + 모델 호출)다.

사용법
    python scripts/wall_clock.py                                   agent 모드 · claude_code · 1건 3번 + 5건 1번
    python scripts/wall_clock.py --mode prefetch                   B′ 모드 (CLASSIFY_MODE=prefetch)
    python scripts/wall_clock.py --mode agent --n 5 --batch 10     1건 5번 + 10건 묶음
    python scripts/wall_clock.py --backend anthropic               API 경로 (키가 있을 때 — 제출 기준 측정)
    python scripts/wall_clock.py --backend local                   비용 없는 구조 확인 (규칙 대역)
    python scripts/wall_clock.py --backend local --concurrent 20   동시 접수 20건 — 유실·중복 수와 유입·분류 지연을 표로 (D6-8)

결과는 표로 출력한다. --report 를 주면 tests/wall_clock_report.md 에도 쓴다 (덮어씀).
판정 기준은 '중앙값'과 '최댓값'이다 (신청서 목표: 접수 후 10초 이내). 폴링 위상을 흩으려고 접수 전에 0~3초 무작위로 쉰다.
"""
import argparse
import os
import random
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 문장은 측정용으로 지어낸 것이다(서로 달라야 캐시·같은 글 합치기에 걸리지 않는다). 구역은 돌아가며 쓴다.
TEXTS = [
    "유등터널 입구에서 사람들이 한꺼번에 몰려 앞으로 나가기 힘들었어요",
    "임시 화장실 앞 줄이 너무 길어서 삼십 분이나 기다렸습니다",
    "먹거리장터 어묵 가격이 너무 비싸서 놀랐어요",
    "촉석루 가는 길 표지판이 없어서 헤맸어요",
    "남강 수상무대 옆 계단 난간이 흔들려서 무서웠어요",
    "셔틀버스가 한참 오지 않아서 승강장에서 오래 기다렸어요",
    "소망등 달기 구역 안내가 없어서 물어보고 다녔어요",
    "주차장이 만차라서 한참 돌다가 겨우 세웠습니다",
    "공연이 정말 좋았고 다음에도 꼭 오고 싶어요",
    "다리 위 바닥이 젖어서 미끄러질 뻔했어요",
    "진주교 근처 조명이 꺼져 있어 많이 어두웠어요",
    "화장실 휴지가 다 떨어져서 그냥 나왔습니다",
    "주차 안내요원이 없어서 차들이 엉켜 있었어요",
    "소망등 값이 생각보다 비싸서 망설였어요",
    "출구를 알려 주는 표시가 없어서 한참 돌았어요",
    "터널 안이 너무 붐벼서 아이 손을 놓칠 뻔했어요",
]


def run_concurrent(args, db, webapi, worker, log, tmp) -> int:
    """동시 접수 N건 — 서로 다른 문장을 스레드 N개가 한꺼번에 접수하고 워커가 처리하는 동안 지연을 잰다.

    유실 = 접수번호는 받았는데 끝내 민원(feedback)이 안 생긴 건(저장 거절 포함). 중복 = 같은 문장이 민원으로 둘 이상 생긴 건.
    유입 지연 = 접수 시작 → feedback 생성, 분류 지연 = 접수 시작 → 분류(done·review) 완료.
    """
    import threading
    n = args.concurrent
    texts = [f"{TEXTS[i % len(TEXTS)]} ({i + 1}번째 동시 접수 시험)" for i in range(n)]
    receipts: dict[int, int] = {}          # 접수번호 → 문장 번호
    errors: list[str] = []
    gate = threading.Barrier(n)
    lock = threading.Lock()

    def go(i: int) -> None:
        gate.wait()
        try:
            r = webapi.submit_feedback(1 + i % 6, texts[i], source=None)
            with lock:
                receipts[r] = i
        except Exception as exc:                        # noqa: BLE001 — 접수 자체가 실패한 것도 유실로 센다
            with lock:
                errors.append(str(exc))
    t0 = time.time()
    ths = [threading.Thread(target=go, args=(i,)) for i in range(n)]
    [th.start() for th in ths]
    [th.join() for th in ths]
    t_submitted = time.time() - t0

    seen_ingest: dict[int, float] = {}
    seen_done: dict[int, float] = {}
    deadline = time.time() + args.timeout
    while time.time() < deadline and len(seen_done) < len(receipts):
        with db.connect() as c:
            for r in receipts:
                row = c.execute("SELECT i.feedback_id fid, c.status st FROM feedback_inbox i "
                                "LEFT JOIN classification c ON c.feedback_id=i.feedback_id WHERE i.id=?", (r,)).fetchone()
                now = time.time() - t0
                if row and row["fid"] not in (None, -1) and r not in seen_ingest:
                    seen_ingest[r] = now
                if row and row["st"] in ("done", "review") and r not in seen_done:
                    seen_done[r] = now
        time.sleep(0.1)
    worker.terminate()
    try:
        worker.wait(timeout=10)
    except subprocess.TimeoutExpired:
        worker.kill()
    log.close()

    with db.connect() as c:
        fb = [r["raw_text"] for r in c.execute("SELECT raw_text FROM feedback WHERE source='qr'").fetchall()]
    dup = len(fb) - len(set(fb))
    lost = n - len(seen_done)                             # 끝내 분류까지 못 간 건 (접수 실패 포함)
    lost_ingest = n - len(seen_ingest)
    def stat(d):
        v = sorted(d.values())
        return (f"{statistics.median(v):.1f}s", f"{max(v):.1f}s") if v else ("-", "-")
    lines = [
        f"# 동시 접수 {n}건 측정 ({datetime.now():%Y-%m-%d %H:%M})", "",
        f"- 모드 `{args.mode}` · 백엔드 `{args.backend}` · 임시 DB(운영 DB 미사용) · 접수 스레드 {n}개가 한꺼번에 출발 (접수 호출 완료까지 {t_submitted:.2f}s)", "",
        "| 지표 | 값 |", "|---|---|",
        f"| 접수 성공 / 요청 | {len(receipts)} / {n} (접수 오류 {len(errors)}건) |",
        f"| 유실(유입까지) | {lost_ingest}건 |", f"| 유실(분류까지) | {lost}건 |", f"| 중복 민원 | {dup}건 |",
        f"| 유입 지연 중앙값 · 최댓값 | {stat(seen_ingest)[0]} · {stat(seen_ingest)[1]} |",
        f"| 분류 지연 중앙값 · 최댓값 | {stat(seen_done)[0]} · {stat(seen_done)[1]} |", "",
    ]
    if errors:
        lines.append(f"- 접수 오류 예: {errors[0][:80]}")
    out = "\n".join(lines)
    print("\n" + out)
    if args.report:
        (ROOT / "tests" / "wall_clock_report.md").write_text(out + "\n", encoding="utf-8")
    return 0 if not lost and not dup else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--mode", choices=["agent", "prefetch"], default="agent", help="CLASSIFY_MODE")
    ap.add_argument("--backend", choices=["claude_code", "anthropic", "local"], default="claude_code", help="LLM_BACKEND")
    ap.add_argument("--n", type=int, default=3, help="1건 접수를 몇 번 잴지")
    ap.add_argument("--batch", type=int, default=5, help="한꺼번에 접수할 묶음 건수 (0 이면 생략)")
    ap.add_argument("--concurrent", type=int, default=0, metavar="N",
                    help="동시 접수 N건(스레드가 한꺼번에 출발)을 넣고 유실·중복 수, 유입·분류 지연 중앙값·최댓값을 잰다 (--n·--batch 대신)")
    ap.add_argument("--timeout", type=int, default=180, help="한 번 기다리는 최대 초")
    ap.add_argument("--report", action="store_true", help="tests/wall_clock_report.md 에도 쓴다")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

    need = args.n + max(args.batch, 0)
    if not args.concurrent and need > len(TEXTS):
        print(f"측정용 문장이 {len(TEXTS)}개뿐이라 --n 과 --batch 합이 그 이하여야 합니다 (지금 {need}).")
        return 2
    tmp = Path(tempfile.mkdtemp(prefix="wall_")) / "t.db"
    os.environ.update(DB_PATH=str(tmp), LLM_BACKEND=args.backend, CLASSIFY_MODE=args.mode,
                      SUPABASE_DB_URL="", PYTHONIOENCODING="utf-8")
    sys.path.insert(0, str(ROOT))
    from core import config, db
    assert Path(config.DB_PATH).resolve() == tmp.resolve() and Path(config.DB_PATH).resolve() != (ROOT / "festival.db").resolve()
    import webapi

    db.init_db()
    log = open(tmp.parent / "worker.log", "w", encoding="utf-8")
    worker = subprocess.Popen([sys.executable, "worker.py", "--no-agents"], cwd=str(ROOT),
                              stdout=log, stderr=log, env=os.environ)
    print(f"측정 시작: 모드 {args.mode} · 백엔드 {args.backend} · 임시 DB {tmp} (워커 pid {worker.pid})")
    time.sleep(4)

    def wait_done(receipts: list[int]) -> dict[int, float]:
        done: dict[int, float] = {}
        t0 = time.time()
        while time.time() - t0 < args.timeout and len(done) < len(receipts):
            with db.connect() as c:
                for r in receipts:
                    if r in done:
                        continue
                    row = c.execute("SELECT c.status FROM feedback_inbox i JOIN classification c ON c.feedback_id=i.feedback_id "
                                    "WHERE i.id=?", (r,)).fetchone()
                    if row and row["status"] in ("done", "review"):
                        done[r] = time.time()
            time.sleep(0.25)
        return done

    if args.concurrent:
        return run_concurrent(args, db, webapi, worker, log, tmp)

    results: list[tuple[str, list[float], int]] = []
    k = 0
    trials = [(f"1건 #{i + 1}", 1) for i in range(args.n)] + ([(f"{args.batch}건 묶음", args.batch)] if args.batch > 0 else [])
    try:
        for label, n in trials:
            time.sleep(random.uniform(0, 3))                      # 워커 폴링 주기의 위상을 흩는다
            t = time.time()
            receipts = [webapi.submit_feedback(1 + (k + i) % 6, TEXTS[k + i], source=None) for i in range(n)]
            k += n
            done = wait_done(receipts)
            lat = [done[r] - t for r in receipts if r in done]
            results.append((label, lat, n - len(lat)))
            print(f"  {label}: " + (" / ".join(f"{x:.1f}s" for x in sorted(lat)) if lat else "미완료")
                  + (f" (미완료 {n - len(lat)}건)" if len(lat) < n else ""))
            time.sleep(3)
    finally:
        worker.terminate()
        try:
            worker.wait(timeout=10)
        except subprocess.TimeoutExpired:
            worker.kill()
        log.close()

    with db.connect() as c:
        calls = c.execute("SELECT COUNT(*) n, ROUND(AVG(latency_ms)) ms FROM agent_log "
                          "WHERE action IN ('cli_call','api_call') AND agent='classifier'").fetchone()
        lookups = c.execute("SELECT COUNT(*) n FROM agent_log WHERE action='lookup_similar'").fetchone()["n"]
        tokens = c.execute("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM agent_log "
                           "WHERE action IN ('cli_call','api_call')").fetchone()

    singles = [x for label, lat, _ in results if label.startswith("1건") for x in lat]
    every = [x for _, lat, _ in results for x in lat]
    lines = [
        f"# 접수→분류 벽시계 측정 ({datetime.now():%Y-%m-%d %H:%M})", "",
        f"- 모드 `{args.mode}` · 백엔드 `{args.backend}` · 임시 DB (운영 DB 미사용) · 워커 폴링 3초 포함", "",
        "| 묶음 | 건수 | 최소 | 중앙값 | 최대 | 미완료 |", "|---|---|---|---|---|---|",
        *[f"| {label} | {len(lat)} | {min(lat):.1f}s | {statistics.median(lat):.1f}s | {max(lat):.1f}s | {miss} |"
          if lat else f"| {label} | 0 | - | - | - | {miss} |" for label, lat, miss in results], "",
    ]
    if singles:
        lines.append(f"**1건 접수: 중앙값 {statistics.median(singles):.1f}s · 최대 {max(singles):.1f}s** "
                     f"(신청서 목표 10초 이내 → {'달성' if max(singles) <= 10 else '미달' if statistics.median(singles) > 10 else '중앙값은 달성, 최대는 초과'})")
    avg = f"{calls['ms']:.0f}ms" if calls["ms"] is not None else "-"
    lines += [f"- 분류 모델 호출 {calls['n']}회 · 호출 평균 {avg} · lookup_similar {lookups}회 · "
              f"입력 {tokens['i']} · 출력 {tokens['o']} 토큰",
              "- 백엔드 `claude_code` 는 CLI 경유 참고값이다. 제출 기준은 `--backend anthropic` 측정이다."]
    out = "\n".join(lines)
    print("\n" + out)
    if args.report:
        (ROOT / "tests" / "wall_clock_report.md").write_text(out + "\n", encoding="utf-8")
        print("\n리포트: tests/wall_clock_report.md")
    return 0 if every else 1


if __name__ == "__main__":
    sys.exit(main())
