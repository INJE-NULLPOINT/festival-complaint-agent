"""동시 접수 · 벽시계 지연 자동 측정 (D6-8).

방문객 접수를 동시에 N건(기본 20건, 3초 동안) 복사본 서버에 넣고 잰다.
  · 유실 0 — 받은 글이 접수함·민원에 모두 남았는가
  · 중복 0 — 같은 글이 두 번 저장되지 않았는가 (일부 방문객은 '두 번 누르기'처럼 같은 글을 곧바로 한 번 더 보낸다 → 합쳐져야 함)
  · 접수 → 관제 유입 — 접수를 보낸 때부터 민원(feedback)으로 옮겨져 관제 '실시간 유입'에 뜰 수 있게 되기까지 (중앙값 · 최대)
  · 접수 → 분류 완료 — 분류(classification.status)가 pending 을 벗어나기까지 (중앙값 · 최대)
  · 접수 → 화면에 알림 — 그 유입 뒤 첫 SSE 'change' 이벤트까지 (화면은 이 알림 뒤 0.5초 안에 다시 그린다)

안전
  · 운영 festival.db 는 읽기만 한다(sqlite backup). 복사본에 webapi 와 worker 를 별도 포트로 띄우고 끝나면 끈다.
  · 분류는 local 대역(LLM_BACKEND=local, LLM 호출 없음). --backend claude_code 는 옵션일 뿐 기본으로 돌리지 않는다 (비용·시간).
  · 방문객 N명은 X-Forwarded-For 로 서로 다른 출처(10.77.0.i)인 것처럼 보낸다 — 출처별 도배 방지(D5-33)에 한 사람으로 묶이지 않게.
    webapi 는 접속자가 루프백일 때만 이 헤더를 믿는다(D5-43) — 이 시험은 같은 PC 에서 보내므로 그 조건을 만족한다.
  · worker 는 --no-agents (분류·유입만; 조치 문구 생성 등 Agent Path 는 이 측정과 무관). 간격은 기본값(--interval 3초) 그대로다 — 벽시계 지연에 그 주기가 포함된다.

실행
    python tests/latency_check.py                      20건 · 3초 · local
    python tests/latency_check.py --n 50 --seconds 5
    python tests/latency_check.py --backend claude_code   (옵션 · 비용 발생 · 오래 걸림)
결과: tests/latency_report.md · 종료 코드 0 통과 / 1 실패(유실·중복·시간 초과)
"""
import argparse
import json
import os
import random
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = Path(__file__).resolve().parent / "latency_report.md"
PY = sys.executable


def free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def kill_tree(p: subprocess.Popen | None) -> None:
    if p and p.poll() is None:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
        else:
            p.kill()


def q(db: str, sql: str, params: tuple = ()) -> list[tuple]:
    c = sqlite3.connect(db, timeout=10)
    try:
        return c.execute(sql, params).fetchall()
    finally:
        c.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="동시 접수 · 벽시계 지연 측정")
    ap.add_argument("--n", type=int, default=20, help="방문객 수(서로 다른 글)")
    ap.add_argument("--seconds", type=float, default=3.0, help="접수를 이 시간에 걸쳐 흩뿌린다")
    ap.add_argument("--double", type=int, default=5, help="그중 '두 번 누르기'(같은 글을 곧바로 한 번 더) 하는 방문객 수")
    ap.add_argument("--backend", choices=["local", "claude_code"], default="local", help="분류 백엔드 (기본 local — claude_code 는 옵션)")
    ap.add_argument("--timeout", type=float, default=120.0, help="분류까지 기다리는 최대 시간(초)")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="latency-"))
    db = str(tmp / "latency.db")
    kids: list[subprocess.Popen] = []
    rows_out: list[dict] = []
    notes: list[str] = []
    ok = True
    try:
        # ── 복사본 DB (운영 DB 는 읽기만) ──
        src = os.environ.get("DB_PATH") or str(ROOT / "festival.db")
        s = sqlite3.connect(f"file:{src}?mode=ro", uri=True); d = sqlite3.connect(db); s.backup(d)
        for t in ("admin_attempt", "submit_rate"):
            try: d.execute(f"DELETE FROM {t}")
            except sqlite3.Error: pass
        d.commit(); d.close(); s.close()

        env = {**os.environ, "DB_PATH": db, "LLM_BACKEND": args.backend, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1",
               "SUPABASE_DB_URL": "", "SUPABASE_URL": "", "SUPABASE_SERVICE_KEY": ""}
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        api = subprocess.Popen([PY, "webapi.py", "--port", str(port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); kids.append(api)
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/api/zones", timeout=2).read(); break
            except Exception:
                time.sleep(0.3)
        else:
            raise RuntimeError("webapi 가 뜨지 않음")
        worker = subprocess.Popen([PY, "worker.py", "--no-agents"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); kids.append(worker)

        # 시작 전에 밀려 있는 것(복사본에 남은 대기 분류·접수함)을 먼저 비운다 — 그 대기열이 측정에 섞이지 않게
        def backlog() -> int:
            return q(db, "SELECT (SELECT COUNT(*) FROM classification WHERE status='pending') + (SELECT COUNT(*) FROM feedback_inbox WHERE feedback_id IS NULL)")[0][0]
        b0 = backlog(); t_dr = time.time()
        while backlog() > 0 and time.time() - t_dr < 90:
            time.sleep(0.5)
        if backlog() > 0:
            notes.append(f"시작 전 대기열 {b0}건이 90초 안에 안 비워져 측정에 섞였을 수 있음")
        elif b0:
            notes.append(f"시작 전 대기열 {b0}건을 먼저 비운 뒤 측정")

        zones = [r[0] for r in q(db, "SELECT id FROM zone ORDER BY id")]
        rnd = random.Random(68)
        N = args.n
        texts = [f"동시 접수 측정 {i:02d}: {['계단 조명이 꺼져 있어요', '입구가 너무 혼잡해요', '주차장이 가득 찼어요', '화장실 줄이 길어요'][i % 4]} ({i}번 방문객)" for i in range(N)]
        offsets = sorted(rnd.uniform(0, args.seconds) for _ in range(N))
        doubles = set(rnd.sample(range(N), min(args.double, N)))
        max_inbox = q(db, "SELECT COALESCE(MAX(id),0) FROM feedback_inbox")[0][0]
        max_fb = q(db, "SELECT COALESCE(MAX(id),0) FROM feedback")[0][0]

        # ── SSE 'change' 이벤트 시각 기록 ──
        changes: list[float] = []
        stop_sse = threading.Event()

        def sse() -> None:
            try:
                r = urllib.request.urlopen(base + "/api/events", timeout=5)
                ev = b""
                while not stop_sse.is_set():
                    line = r.readline()
                    if line.startswith(b"event: change"):
                        changes.append(time.time())
                    if not line:
                        break
            except Exception:
                pass
        threading.Thread(target=sse, daemon=True).start()
        time.sleep(1.5)

        # ── 접수: 방문객 N명이 offsets 에 맞춰 동시에 ──
        results: list[dict | None] = [None] * N
        extra: list[dict] = []
        lock = threading.Lock()

        def post(i: int, dup: bool = False) -> dict:
            body = json.dumps({"p_zone_id": zones[i % len(zones)], "p_text": texts[i]}).encode()
            req = urllib.request.Request(base + "/api/rpc/submit_feedback", data=body, method="POST",
                                         headers={"Content-Type": "application/json", "X-Forwarded-For": f"10.77.0.{i + 1}"})
            t_send = time.time()
            try:
                r = urllib.request.urlopen(req, timeout=30)
                out = {"i": i, "status": r.status, "receipt": json.loads(r.read()).get("data"), "t_send": t_send, "t_ack": time.time(), "dup": dup}
            except urllib.error.HTTPError as e:
                out = {"i": i, "status": e.code, "receipt": None, "t_send": t_send, "t_ack": time.time(), "dup": dup, "err": e.read().decode("utf-8", "replace")[:120]}
            except Exception as e:
                out = {"i": i, "status": 0, "receipt": None, "t_send": t_send, "t_ack": time.time(), "dup": dup, "err": str(e)[:120]}
            return out

        def visitor(i: int) -> None:
            time.sleep(max(0, t_start + offsets[i] - time.time()))
            results[i] = post(i)
            if i in doubles:                       # 두 번 누르기: 응답을 기다리지 않고 곧바로 한 번 더 (다른 스레드로)
                pass

        t_start = time.time() + 0.3
        threads = []
        for i in range(N):
            threads.append(threading.Thread(target=visitor, args=(i,)))
        # 두 번 누르기는 같은 순간에 두 요청을 동시에 보낸다
        def double_tap(i: int) -> None:
            time.sleep(max(0, t_start + offsets[i] - time.time()))
            r = post(i, dup=True)
            with lock: extra.append(r)
        for i in doubles:
            threads.append(threading.Thread(target=double_tap, args=(i,)))
        for t in threads: t.start()
        for t in threads: t.join()

        # ── 지켜보기: 유입(feedback_id 채워짐) · 분류 완료(status != pending) ──
        t_feed: dict[int, float] = {}
        t_cls: dict[int, float] = {}
        receipts = {r["i"]: r["receipt"] for r in results if r and r["status"] == 200 and r["receipt"]}
        deadline = time.time() + args.timeout
        while time.time() < deadline and len(t_cls) < len(receipts):
            ids = tuple(receipts.values())
            if ids:
                marks = ",".join("?" for _ in ids)
                for rid, fid, st in q(db, f"SELECT i.id, i.feedback_id, c.status FROM feedback_inbox i LEFT JOIN classification c ON c.feedback_id = i.feedback_id WHERE i.id IN ({marks})", ids):
                    now = time.time()
                    if fid is not None and rid not in t_feed:
                        t_feed[rid] = now
                    if fid is not None and st is not None and st != "pending" and rid not in t_cls:
                        t_cls[rid] = now
            time.sleep(0.05)
        time.sleep(1.5)
        stop_sse.set()

        # ── 집계 ──
        accepted = [r for r in results if r and r["status"] == 200]
        failed_posts = [r for r in results if not r or r["status"] != 200]
        dup_ok = [r for r in extra if r["status"] == 200]
        inbox_rows = q(db, "SELECT id, text, feedback_id FROM feedback_inbox WHERE id > ?", (max_inbox,))
        # 접수함의 text 는 유입 뒤 NULL 이 되므로 민원 원문으로 센다
        fb_texts = [r[0] for r in q(db, "SELECT raw_text FROM feedback WHERE id > ? AND raw_text LIKE '동시 접수 측정 %'", (max_fb,))]
        kept = {i: sum(1 for t in fb_texts if t == texts[i]) for i in range(N)}
        lost = [i for i in range(N) if kept[i] == 0]
        dups = [i for i in range(N) if kept[i] > 1]
        same_receipt = all(r["receipt"] == results[r["i"]]["receipt"] for r in dup_ok if results[r["i"]] and results[r["i"]]["receipt"])
        new_inbox = len(inbox_rows)

        def lat(m: dict[int, float]) -> list[float]:
            return [m[r["receipt"]] - r["t_send"] for r in accepted if r["receipt"] in m]
        feed_l, cls_l = lat(t_feed), lat(t_cls)
        ack_l = [r["t_ack"] - r["t_send"] for r in accepted]
        sse_l = []
        for r in accepted:
            tf = t_feed.get(r["receipt"])
            if tf is not None:
                nxt = next((c for c in changes if c >= tf), None)
                if nxt is not None:
                    sse_l.append(nxt - r["t_send"])

        def stat(v: list[float]) -> tuple[str, str]:
            return (f"{statistics.median(v):.2f}초", f"{max(v):.2f}초") if v else ("측정 못함", "측정 못함")

        checks = [
            (f"접수 {N}건 모두 성공 응답", len(accepted) == N, f"성공 {len(accepted)}/{N}" + (f" · 실패 {[(r or {}).get('status') for r in failed_posts]}" if failed_posts else "")),
            ("유실 0", not lost and len(t_cls) == len(receipts), f"남지 않은 글 {len(lost)}건 · 분류까지 끝난 {len(t_cls)}/{len(receipts)}"),
            ("중복 0 (같은 글이 두 번 저장되지 않음)", not dups and new_inbox == N, f"두 번 이상 저장된 글 {len(dups)}건 · 접수함 새 행 {new_inbox}건 (기대 {N})"),
            (f"두 번 누르기 {len(doubles)}건은 합쳐져 성공 응답 · 같은 접수번호", len(dup_ok) == len(doubles) and same_receipt, f"성공 {len(dup_ok)}/{len(doubles)} · 같은 번호 {same_receipt}"),
        ]
        ok = all(c[1] for c in checks)

        md = [
            "# 동시 접수 · 벽시계 지연 측정 (D6-8)", "",
            f"- 수행 {datetime.now():%Y-%m-%d %H:%M} · 방문객 {N}명이 {args.seconds:g}초에 걸쳐 동시 접수 (그중 {len(doubles)}명은 같은 글을 곧바로 한 번 더 = 두 번 누르기)",
            f"- 분류 백엔드 `{args.backend}`" + (" (local 대역 — LLM 호출 없음)" if args.backend == "local" else " (옵션 실측 — 비용 발생)") + " · worker `--no-agents` 기본 주기(3초) · 운영 DB 복사본 · 별도 포트",
            f"- 방문객마다 다른 출처(X-Forwarded-For 10.77.0.i)로 보냄 — 출처별 도배 방지에 묶이지 않게", "",
            "## 결과", "", "| 항목 | 판정 | 내용 |", "|---|---|---|",
        ]
        for name, good, detail in checks:
            md.append(f"| {name} | {'✅ 통과' if good else '❌ 실패'} | {detail} |")
        md += ["", "## 지연 (접수를 보낸 때부터, 벽시계)", "", "| 구간 | 중앙값 | 최대 | 표본 |", "|---|---|---|---|"]
        for label, v in (("접수 응답(접수번호 받기까지)", ack_l), ("접수 → 관제 유입 (민원으로 옮겨져 유입에 뜰 수 있음)", feed_l),
                         ("접수 → 화면에 알림 (첫 SSE change)", sse_l), ("접수 → 분류 완료", cls_l)):
            m_, x_ = stat(v)
            md.append(f"| {label} | {m_} | {x_} | {len(v)}건 |")
        md += ["", "## 해석", "",
               "- 접수 응답은 webapi 가 접수함에 넣는 시간뿐이다. 유입·분류 시간의 대부분은 worker 의 주기(기본 3초 간격으로 수거·분류)다.",
               "- '화면에 알림'은 서버가 변화를 알리는 시각이다. 실제 화면은 그 뒤 0.5초 안에 다시 그린다(main.ts 의 모음 시간).",
               "- local 분류는 규칙 대역이라 빠르다. 실제 LLM 분류(claude_code · API)의 시간은 이 표에 없다 — `--backend claude_code` 로 따로 재야 한다."]
        if notes:
            md += ["", "## 참고", ""] + [f"- {n}" for n in notes]
        md.append("")
        REPORT.write_text("\n".join(md), encoding="utf-8")
        for name, good, detail in checks:
            print(f"{'✓' if good else '✗'} {name}  — {detail}")
        for label, v in (("접수→관제 유입", feed_l), ("접수→화면 알림", sse_l), ("접수→분류 완료", cls_l)):
            m_, x_ = stat(v)
            print(f"측정 {label}: 중앙값 {m_} · 최대 {x_} ({len(v)}건)")
        print(f"→ {REPORT}")
        return 0 if ok else 1
    finally:
        for k in kids:
            kill_tree(k)
        time.sleep(1.2)
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
