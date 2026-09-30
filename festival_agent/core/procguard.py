"""프로세스 중복 실행 방지(PID 잠금 파일)와 SQLite 안전 백업.

- acquire(name, key)  같은 name·key 로 이미 살아 있는 프로세스가 있으면 None, 없으면 잠금 파일 경로를 돌려준다.
                      죽은 프로세스가 남긴 잠금은 자동으로 치운다. 종료 때 release() (못 불러도 다음 실행이 stale 로 판단).
- backup_db()         SQLite 온라인 백업 API 로 일관된 사본을 만들고 오래된 자동 백업을 지운다. 원본은 읽기만 한다.
"""
import hashlib
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from . import config

LOCK_DIR = config.BASE_DIR / "output" / "locks"
BACKUP_DIR = config.BASE_DIR / "backup"
AUTO_PREFIX = "auto_"          # 자동 백업만 지운다 (손으로 만든 festival_*_before_reset.db 등은 건드리지 않는다)


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(0x1000, False, pid)        # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(k32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259   # STILL_ACTIVE
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def lock_path(name: str, key: str = "") -> Path:
    tag = hashlib.sha1(str(key).encode("utf-8")).hexdigest()[:8] if key else "main"
    return LOCK_DIR / f"{name}_{tag}.lock"


def acquire(name: str, key: str = "", pid: int | None = None) -> Path | None:
    """잠금을 잡는다. 이미 살아 있는 소유자가 있으면 None."""
    path = lock_path(name, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    me = pid or os.getpid()
    for _ in range(2):
        try:
            with open(path, "x", encoding="utf-8") as f:          # 원자적 생성
                f.write(str(me))
            return path
        except FileExistsError:
            try:
                owner = int(path.read_text(encoding="utf-8").strip() or 0)
            except (ValueError, OSError):
                owner = 0
            if owner and owner != me and pid_alive(owner):
                return None
            try:
                path.unlink()                                      # 죽은 프로세스의 잠금
            except OSError:
                return None
    return None


def release(path: Path | None) -> None:
    if path:
        try:
            path.unlink()
        except OSError:
            pass


def backup_db(keep: int = 12, src: str | None = None, dest_dir: Path | None = None) -> Path:
    """DB 를 backup/auto_YYYYmmdd_HHMMSS.db 로 복사하고 자동 백업은 최근 keep 개만 남긴다.

    sqlite3 의 backup API 를 쓰므로 쓰는 도중에도 일관된 사본이 나온다. 끝나면 원본의 WAL 을 비운다(체크포인트).
    """
    src = src or config.DB_PATH
    dest_dir = Path(dest_dir or BACKUP_DIR)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{AUTO_PREFIX}{datetime.now():%Y%m%d_%H%M%S_%f}.db"       # 이름에 시각이 들어 있어 이름순 = 시간순
    while dest.exists():
        dest = dest.with_name(dest.stem + "_x.db")
    s = sqlite3.connect(src, timeout=10)
    try:
        d = sqlite3.connect(str(dest))
        try:
            s.backup(d)
        finally:
            d.close()
        try:
            s.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass
    finally:
        s.close()
    old = sorted(dest_dir.glob(f"{AUTO_PREFIX}*.db"), key=lambda p: p.name, reverse=True)
    for p in old[max(keep, 1):]:
        try:
            p.unlink()
        except OSError:
            pass
    return dest
