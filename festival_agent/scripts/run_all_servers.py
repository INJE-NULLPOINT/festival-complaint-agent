"""서버 일괄 실행 + 감시 (D5-34) — webapi · worker · vite 를 분리 프로세스로 띄우고, 죽으면 다시 띄운다.

사용법
    python scripts/run_all_servers.py                 webapi(8765) + worker + vite 개발 서버(5173)
    python scripts/run_all_servers.py --phone         vite 대신 폰 확인용 빌드본 서버(npm run phone, 4173)
    python scripts/run_all_servers.py --only webapi worker     일부만
    python scripts/run_all_servers.py --dry-run       명령만 출력
    python scripts/run_all_servers.py --backup-now    DB 를 지금 백업하고 끝

- 로그: output/logs/<이름>.log (1MB 넘으면 .log.1 로 넘김). 이 스크립트 자신의 기록은 supervisor.log.
- 죽으면 2·4·8…최대 60초 간격으로 다시 띄운다. 60초 넘게 살아 있으면 간격을 처음으로 되돌린다.
- 이 스크립트가 두 번 뜨지 않는다 (PID 잠금). 이미 해당 포트가 쓰이고 있으면 그 서버는 건드리지 않고 넘어간다.
- festival.db(또는 DB_PATH)를 30분마다 backup/auto_*.db 로 복사하고 최근 12개만 남긴다 (backup/ 은 git 제외).
- 끄려면 Ctrl+C — 자식 프로세스도 같이 끈다.
"""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import procguard  # noqa: E402

LOG_DIR = ROOT / "output" / "logs"
LOG_MAX = 1_000_000
BACKUP_EVERY = 30 * 60
BACKUP_KEEP = 12
BACKOFF_MAX = 60
STABLE_AFTER = 60


def log_line(msg: str) -> None:
    line = f"[{datetime.now():%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_DIR / "supervisor.log", "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


class Managed:
    """감시할 프로세스 1개."""

    def __init__(self, name: str, cmd: list[str], cwd: Path, port: int | None = None, env: dict | None = None):
        self.name, self.cmd, self.cwd, self.port = name, cmd, cwd, port
        self.env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1", **(env or {})}
        self.proc: subprocess.Popen | None = None
        self.log = None
        self.started = 0.0
        self.restarts = 0
        self.delay = 2.0
        self.next_try = 0.0
        self.skipped = False

    @property
    def log_path(self) -> Path:
        return LOG_DIR / f"{self.name}.log"

    def _open_log(self) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        p = self.log_path
        if p.exists() and p.stat().st_size > LOG_MAX:
            try:
                os.replace(p, str(p) + ".1")
            except OSError:
                pass
        self.log = open(p, "a", encoding="utf-8", errors="replace")
        self.log.write(f"\n===== {datetime.now():%Y-%m-%d %H:%M:%S} 시작: {' '.join(self.cmd)}\n")
        self.log.flush()

    def start(self) -> None:
        if self.port and port_in_use(self.port):
            if not self.skipped:
                log_line(f"{self.name}: 포트 {self.port} 이 이미 쓰이고 있어 새로 띄우지 않습니다 (다른 서버를 그대로 씁니다)")
            self.skipped = True
            return
        self.skipped = False
        self._open_log()
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
        self.proc = subprocess.Popen(self.cmd, cwd=str(self.cwd), env=self.env, stdout=self.log,
                                     stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags)
        self.started = time.time()
        log_line(f"{self.name}: 시작 (pid {self.proc.pid}) → {self.log_path}")

    def check(self, now: float | None = None) -> str:
        """한 번 점검한다. 'ok' | 'restarted' | 'waiting' | 'skipped' 를 돌려준다."""
        now = now or time.time()
        if self.proc is None:
            if now < self.next_try:
                return "waiting"
            self.start()
            return "skipped" if self.skipped else "restarted"
        code = self.proc.poll()
        if code is None:
            if now - self.started >= STABLE_AFTER:
                self.delay = 2.0
            return "ok"
        ran = now - self.started
        if self.log:
            self.log.write(f"===== 종료 코드 {code} ({ran:.0f}초 실행)\n")
            self.log.close()
            self.log = None
        self.restarts += 1
        if ran >= STABLE_AFTER:
            self.delay = 2.0
        log_line(f"{self.name}: 종료됨 (코드 {code}, {ran:.0f}초 실행) → {self.delay:.0f}초 뒤 다시 시작 (누적 {self.restarts}회)")
        self.proc = None
        self.next_try = now + self.delay
        self.delay = min(self.delay * 2, BACKOFF_MAX)
        return "waiting"

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                if sys.platform == "win32":
                    subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"], capture_output=True)
                else:
                    self.proc.terminate()
                self.proc.wait(timeout=10)
            except Exception:
                pass
        if self.log:
            self.log.close()
            self.log = None


def build(args) -> list[Managed]:
    py = sys.executable
    node = shutil.which("node") or "node"
    web = ROOT / "web"
    items = {
        "webapi": Managed("webapi", [py, "webapi.py", "--host", args.host, "--port", str(args.port)], ROOT, port=args.port),
        "worker": Managed("worker", [py, "worker.py"], ROOT),
    }
    if args.phone:
        items["vite"] = Managed("vite", [node, "scripts/phone.mjs"], web, port=4173)
    else:
        items["vite"] = Managed("vite", [node, str(web / "node_modules" / "vite" / "bin" / "vite.js")], web, port=5173)
    return [items[n] for n in ("webapi", "worker", "vite") if n in args.only]


def backup_loop(stop: threading.Event) -> None:
    while not stop.wait(BACKUP_EVERY):
        try:
            p = procguard.backup_db(keep=BACKUP_KEEP)
            log_line(f"DB 백업: {p.name} (자동 백업은 최근 {BACKUP_KEEP}개만 보관)")
        except Exception as exc:          # 백업 실패가 서버를 멈추면 안 된다
            log_line(f"DB 백업 실패: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", nargs="+", choices=["webapi", "worker", "vite"], default=["webapi", "worker", "vite"])
    ap.add_argument("--phone", action="store_true", help="vite 개발 서버 대신 폰용 빌드본 서버")
    ap.add_argument("--host", default="127.0.0.1", help="webapi 주소")
    ap.add_argument("--port", type=int, default=8765, help="webapi 포트")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--backup-now", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

    if args.backup_now:
        p = procguard.backup_db(keep=BACKUP_KEEP)
        print(f"백업했습니다: {p}")
        return 0
    servers = build(args)
    if args.dry_run:
        for s in servers:
            print(f"{s.name:7s} cwd={s.cwd.relative_to(ROOT) if s.cwd != ROOT else '.'}  {' '.join(s.cmd)}")
        print(f"로그 {LOG_DIR} · DB 백업 {BACKUP_EVERY // 60}분마다 → {procguard.BACKUP_DIR} (최근 {BACKUP_KEEP}개)")
        return 0

    from core import config
    lock = procguard.acquire("run_all_servers", config.DB_PATH)
    if lock is None:
        print("이미 run_all_servers 가 실행 중입니다 (같은 DB). 중복 실행을 막았습니다.", file=sys.stderr)
        return 1
    stop = threading.Event()
    try:
        log_line(f"감시 시작: {', '.join(s.name for s in servers)} · DB {config.DB_PATH}")
        try:
            log_line(f"시작 전 DB 백업: {procguard.backup_db(keep=BACKUP_KEEP).name}")
        except Exception as exc:
            log_line(f"시작 전 DB 백업 실패: {exc}")
        threading.Thread(target=backup_loop, args=(stop,), daemon=True).start()
        while True:
            for s in servers:
                s.check()
            time.sleep(2)
    except KeyboardInterrupt:
        log_line("Ctrl+C — 자식 프로세스를 끕니다")
        return 0
    finally:
        stop.set()
        for s in servers:
            s.stop()
        procguard.release(lock)


if __name__ == "__main__":
    sys.exit(main())
