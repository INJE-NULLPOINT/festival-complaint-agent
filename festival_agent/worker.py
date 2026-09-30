"""에이전트 오케스트레이터.

두 경로를 한 프로세스에서 돌린다.

  Fast Path  (매 주기)     웹 접수 · 리플레이 투입 → ①분류 → 심각도 스냅샷
                           웹에서 요청한 조치요청서 생성
  Agent Path (느린 주기)   ②감시 → ③조치 → ④통합

Agent Path를 매 주기 돌리면 LLM 호출이 폭증한다. 기본 60초 간격이고,
새로 분류된 민원이 있을 때만 돈다.

실행
    python worker.py                      기본 (분류 3초 / 에이전트 60초)
    python worker.py --agent-interval 20  시연용 (반응을 빠르게)
    python worker.py --no-agents          ①분류만 (비용 절약)
    python worker.py --once               한 주기만

스레드 4개로 나눠 돈다. Agent Path 한 바퀴가 claude_code 로 몇 분씩 걸리고
①분류 한 배치도 수십 초 걸리므로, 서로 기다리면 접수·요청이 밀린다.

  ingest   (--interval)  웹 접수 수거(마스킹) · 리플레이 투입 — 화면 유입이 바로 뜨게
  메인     (--interval)  ①분류 → 심각도 스냅샷. 분류는 이 스레드만 한다
  doc_jobs (--interval)  웹의 조치요청서 요청
  issues   (5초)         관제 '지금 조치할 일' 카드의 건수·마지막 시각·최신 민원 갱신 (LLM 없음)
  agents   (필요할 때)   Agent Path 한 바퀴. 끝나야 다음 바퀴를 띄운다

--once 는 스레드 없이 예전처럼 한 번씩 차례로 돈다.
"""
import argparse
import sys
import threading
import time
import traceback

from core import db, issues, replay, review

# ③조치는 한 번에 하나만 돈다. 웹 요청 스레드와 Agent Path 가 같은 유형의
# 문서를 동시에 만들거나, 새로 생긴 action_request 를 서로의 것으로 잡지 않게.
DISPATCH_LOCK = threading.Lock()


def ingest() -> int:
    """웹 접수 수거(마스킹) + 리플레이 투입. 들어온 건수를 돌려준다."""
    return db.pull_inbox() + replay.step()


def fast_path(batch: int, window: int) -> int:
    """웹 접수 · 리플레이 투입 + 분류. 처리한 건수를 돌려준다 (--once 용)."""
    return ingest() + classify_step(batch, window)


def classify_step(batch: int, window: int) -> int:
    """①분류 한 배치. 대기 건수를 돌려준다.

    분류가 끝나면 심각도 스냅샷을 바로 남긴다. 계산은 결정적 함수라 LLM 비용이
    없고, 웹 관제 화면은 이 스냅샷을 실시간 구독으로 받는다.
    """
    from agents.classifier import run_once as classify

    pending = db.pending_count()
    if pending:
        classify(limit=batch)
        ranked = db.ranked(window)
        if ranked:
            db.save_severity(ranked, f"{window}min")
        issues.refresh(window)             # 분류가 끝난 즉시 카드에도 반영 (문구는 ④가 따로 씀)
    return pending


def doc_jobs(window: int) -> None:
    """웹의 '조치요청서 생성' 버튼 요청을 처리한다."""
    from agents import dispatcher

    for job in db.claim_doc_jobs():
        label = job["label"]
        try:
            item = next((r for r in db.ranked(window) if r["label"] == label), None)
            if item is None:
                raise ValueError("최근 창에 해당 유형 민원이 없습니다")
            with DISPATCH_LOCK:
                with db.connect() as conn:
                    before = conn.execute("SELECT MAX(id) m FROM action_request").fetchone()["m"] or 0
                res = dispatcher.run_for(label, item["score"], item["grade"], item["formula"], window)
                with db.connect() as conn:
                    row = conn.execute(
                        "SELECT MAX(id) m FROM action_request WHERE label=? AND id>?", (label, before)
                    ).fetchone()
            if not row or not row["m"]:
                raise RuntimeError(f"문서가 만들어지지 않았습니다: {(res or '')[:120]}")
            db.finish_doc_job(job["id"], row["m"])
            print(f"  ③조치   (웹 요청) {(res or '')[:120]}")
        except Exception as e:
            db.finish_doc_job(job["id"], None, error=str(e))
            print(f"  ③조치   (웹 요청 실패) {label}: {e}")


def _guarded(fn, *args) -> None:
    """한 번 실행. 예외는 찍고 로그에 남긴 뒤 삼킨다 — 스레드가 죽지 않게."""
    try:
        fn(*args)
    except Exception:
        traceback.print_exc()
        db.log_agent("worker", "error", output_summary=traceback.format_exc()[-200:])


def _loop(fn, interval: float, *args) -> None:
    while True:
        _guarded(fn, *args)
        time.sleep(interval)


def doc_loop(window: int, interval: float) -> None:
    """웹 요청 전용 스레드. Agent Path 와 따로 돌아 요청 후 바로 작성에 들어간다."""
    _loop(doc_jobs, interval, window)


ISSUE_INTERVAL = 5.0
PURGE_INTERVAL = 600.0          # 출처 해시(submit_rate)·운영자 코드 실패 기록은 접수·실패가 없어도 10분마다 지운다


def issue_loop(window: int) -> None:
    """관제 카드 갱신 스레드. 건수·마지막 시각·최신 민원·조치 그룹을 LLM 없이 바로 반영한다.

    조치 상태를 사람이 바꾸거나 시간이 흘러 '최근' 값이 바뀌는 것도 여기서 따라간다.
    값이 그대로면 쓰지 않으므로 화면이 매번 다시 그려지지 않는다.
    """
    last_purge = [0.0]

    def tick(w: int) -> None:
        issues.refresh(w)
        review.raise_stale_alerts()        # 안전 의심 확인 필요가 15분 넘게 방치되면 알림 1회 (시간 기반이라 여기서)
        if time.time() - last_purge[0] >= PURGE_INTERVAL:      # 24시간 지난 출처 해시·실패 기록 정리 (D5-33)
            last_purge[0] = time.time()
            from core import intake
            intake.purge_old()
    _loop(tick, ISSUE_INTERVAL, window)


def ingest_loop(interval: float) -> None:
    """접수 수거 전용 스레드. 분류·Agent Path 가 오래 걸려도 유입은 바로 뜬다."""
    def once() -> None:
        n = ingest()
        if n:
            prog = replay.progress()
            tail = (f" · 재생 {prog['cursor']}/{prog['total']} ({prog['sim_now']})"
                    if prog and prog["active"] else "")
            print(f"[worker] 접수 {n}건{tail}")
    _loop(once, interval)


def agent_path(window: int) -> None:
    """②감시 → ③조치 → ④통합. 마지막에 통합이 합친다.

    세 에이전트가 같은 창을 본다. 다르면 건수·점수가 서로 어긋난다.
    """
    from agents import dispatcher, monitor, supervisor

    out = monitor.run_once(window)
    if out:
        print(f"  ②감시   {out[:120]}")

    for item in dispatcher.pending_labels()[:2]:      # 한 주기에 최대 2건
        with DISPATCH_LOCK:
            # 락을 기다리는 사이 웹 요청으로 같은 유형 문서가 생겼을 수 있다
            if item["label"] not in {p["label"] for p in dispatcher.pending_labels()}:
                continue
            res = dispatcher.run_for(
                item["label"], item["score"], item["grade"], item["formula"], window
            )
        if res:
            print(f"  ③조치   {res[:120]}")

    out = supervisor.run_once(window)
    if out:
        print(f"  ④통합   {out[:160]}")

    # 에이전트가 일한 결과를 할 일 목록에 반영한다.
    # 내용이 그대로면 파일을 건드리지 않는다.
    from core import todo
    done, total, changed = todo.refresh()
    if changed:
        print(f"  할일     진행 {done}/{total} 갱신")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=3.0, help="Fast Path 주기(초)")
    ap.add_argument("--agent-interval", type=float, default=60.0, help="Agent Path 주기(초)")
    ap.add_argument("--batch", type=int, default=20, help="분류 배치 크기")
    ap.add_argument("--no-agents", action="store_true", help="①분류만 실행")
    ap.add_argument("--once", action="store_true", help="한 주기만")
    ap.add_argument("--window", type=int, default=None, help="심각도 창(분)")
    args = ap.parse_args()
    # 백그라운드로 띄워도 로그가 바로 보이게 (파이프·파일이면 기본이 블록 버퍼링)
    sys.stdout.reconfigure(line_buffering=True)
    if args.window is None:
        from core import config
        args.window = config.DEFAULT_WINDOW_MIN

    lock = None
    if not args.once:
        # 같은 DB 로 워커가 둘 뜨면 같은 대기 민원을 둘이 분류한다 (Agent Path 도 겹친다)
        from core import config as _cfg, procguard
        lock = procguard.acquire("worker", _cfg.DB_PATH)
        if lock is None:
            print("[worker] 같은 DB 로 이미 워커가 실행 중입니다. 중복 실행을 막았습니다.", file=sys.stderr)
            sys.exit(1)

    db.init_db()
    replay.ensure()
    print(f"[worker] 시작 · Fast {args.interval}s · Agent "
          f"{'off' if args.no_agents else f'{args.agent_interval}s'}")

    if args.once:
        def once() -> None:
            n = fast_path(args.batch, args.window)
            issues.refresh(args.window)
            if n:
                print(f"[worker] 처리 {n}건")
            if not args.no_agents:
                doc_jobs(args.window)
                if n:
                    print("[worker] Agent Path 실행")
                    agent_path(args.window)
        _guarded(once)
        return

    threading.Thread(target=issue_loop, args=(args.window,), name="issues", daemon=True).start()
    threading.Thread(target=ingest_loop, args=(args.interval,),
                     name="ingest", daemon=True).start()
    if not args.no_agents:
        threading.Thread(target=doc_loop, args=(args.window, args.interval),
                         name="doc_jobs", daemon=True).start()

    agents: threading.Thread | None = None
    last_agent = 0.0                     # 직전 Agent Path 가 끝난 시각
    processed_since_agent = 0

    def run_agents() -> None:
        nonlocal last_agent
        _guarded(agent_path, args.window)
        last_agent = time.time()

    while True:
        try:
            n = classify_step(args.batch, args.window)
            processed_since_agent += n
            if n:
                print(f"[worker] 분류 {n}건")

            idle = agents is None or not agents.is_alive()
            due = time.time() - last_agent >= args.agent_interval
            if not args.no_agents and idle and due and processed_since_agent:
                print("[worker] Agent Path 실행")
                processed_since_agent = 0
                agents = threading.Thread(target=run_agents, name="agents", daemon=True)
                agents.start()

        except KeyboardInterrupt:
            raise
        except Exception:
            traceback.print_exc()
            db.log_agent("worker", "error",
                         output_summary=traceback.format_exc()[-200:])

        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[worker] 종료")
