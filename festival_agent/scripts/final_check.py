"""제출 직전 회귀 검사 (D8) — 한 번에 돌리고 한 장의 표로 남긴다.

순서
  1. 단위 테스트            tests/test_severity.py
  2. 시나리오 5종           tests/test_scenarios.py        (구조 모드, LLM 호출 없음)
  3. Streamlit 헤드리스     tests/streamlit_check.py --backend local
  4. 웹 타입 검사           web: tsc --noEmit
  5. 화면·서버 전체 점검    tests/ui/run_all.mjs — 방문객·관리자·연결 끊김·대량 데이터 속도·보안·모바일 5폭,
                            그리고 빌드 + 빌드본 최신 문법 0 + JS 실패 안내 + 빌드본 화면 (별도 포트·DB 복사본·임시 dist; web/dist 는 안 건드림)
  6. 제외 확인 (D8-3)       git ls-files 에 .env · *.db · output/ · node_modules · 실제 키가 없어야 한다

안전
  - 운영 DB(festival.db)는 쓰지 않는다. 시험들은 저마다 복사본으로 돈다 (run_all 은 자체 포트·임시 폴더).
  - claude_code/anthropic 실측은 하지 않는다: LLM_BACKEND=local 로 고정. API 키는 자식 프로세스 환경에서 뺀다.
  - 시험이 덮어쓰는 제출용 기록(testcase_report.md · streamlit_check.md)은 실행 전 내용을 저장했다가 끝에 되돌린다.
    (제출용 기록이 회귀 검사 때문에 바뀌지 않게. 이번 실행 결과는 tests/final_check.md 에만 남는다.)
  - 키 검사 결과에는 파일 경로와 줄 번호만 적고, 키 값은 출력하지 않는다.

실행
    python scripts/final_check.py                 전체
    python scripts/final_check.py --skip=ui       화면 점검 빼고 (약 6분 절약)
    python scripts/final_check.py --only=exclude  제외 확인만
종료 코드: 0 전부 통과 · 1 실패 있음
"""
import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # festival_agent
WEB = ROOT / "web"
REPORT = ROOT / "tests" / "final_check.md"
NPX = "npx.cmd" if os.name == "nt" else "npx"
NODE = "node"

# 시험이 덮어쓰는 기록 — 끝에 되돌린다
PRESERVE = [ROOT / "tests" / "testcase_report.md", ROOT / "tests" / "streamlit_check.md"]

KEY_ENV = ["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SUPABASE_KEY"]


def child_env(**extra) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in KEY_ENV}
    env.update({"LLM_BACKEND": "local", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
    env.pop("DB_PATH", None)          # 운영 DB 경로를 물려주지 않는다 (시험이 각자 복사본을 만든다)
    env.update(extra)
    return env


def run(cmd: list[str], cwd: Path, timeout: int, env: dict | None = None) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env or child_env(), capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"")
        out = out.decode("utf-8", "replace") if isinstance(out, bytes) else out
        return 124, out + f"\n(시간 초과 {timeout}초)"
    except FileNotFoundError as e:
        return 127, f"실행 파일을 찾지 못함: {e}"


def last(out: str, n: int = 1) -> str:
    lines = [l.strip() for l in out.strip().splitlines() if l.strip()]
    return " / ".join(lines[-n:]) if lines else "(출력 없음)"


def find(out: str, pattern: str) -> str | None:
    m = re.findall(pattern, out)
    return m[-1] if m else None


# ── 각 단계: (통과 여부, 요약 한 줄) 을 돌려준다 ─────────────────────────────
def step_unit():
    rc, out = run([sys.executable, "tests/test_severity.py"], ROOT, 300)
    m = find(out, r"(\d+)개 통과")                # 끝의 '63개 통과' 줄 (Streamlit 경고 같은 잡음 줄은 요약으로 쓰지 않는다)
    if rc == 0 and m:
        return True, f"{m}개 통과"
    fails = [l.strip() for l in out.splitlines() if l.strip().startswith(("✗", "FAIL", "Traceback", "AssertionError"))]
    return False, " / ".join(fails[:3]) or last(out, 2)


def step_scenarios():
    rc, out = run([sys.executable, "tests/test_scenarios.py"], ROOT, 600)
    m = find(out, r"(\d+)\s*/\s*(\d+)\s*통과")
    return rc == 0, (f"{m[0]}/{m[1]} 통과 · 구조 모드" if m else last(out))


def step_streamlit():
    rc, out = run([sys.executable, "tests/streamlit_check.py", "--backend", "local"], ROOT, 900)
    m = find(out, r"(\d+)\s*/\s*(\d+)")
    return rc == 0, (f"{m[0]}/{m[1]} 통과 · local" if m else last(out))


def step_tsc():
    rc, out = run([NPX, "tsc", "--noEmit"], WEB, 300)
    return rc == 0, "오류 0" if rc == 0 else last(out, 3)


def step_ui():
    rc, out = run([NODE, "tests/ui/run_all.mjs"], ROOT, 1800)
    m = find(out, r"결과: (.+?) →")
    return rc == 0, (m or last(out, 2))


def git(*args: str) -> tuple[int, str]:
    return run(["git", *args], ROOT, 120)


def step_exclude():
    rc, top = git("rev-parse", "--show-toplevel")
    if rc != 0:
        return False, "git 저장소가 아님: " + last(top)
    top = Path(top.strip())
    rc, out = run(["git", "ls-files", "-z"], top, 120)        # 저장소 맨 위에서: 경로가 전부 top 기준이 된다
    if rc != 0:
        return False, "git ls-files 실패: " + last(out)
    files = [f for f in out.split("\0") if f]
    bad: list[str] = []
    for f in files:
        parts = f.split("/")
        name = parts[-1]
        if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
            bad.append(f"{f} (환경 파일)")
        elif re.search(r"\.db(-wal|-shm)?$", name):
            bad.append(f"{f} (DB 파일)")
        elif "output" in parts[:-1]:
            bad.append(f"{f} (output/)")
        elif "node_modules" in parts[:-1]:
            bad.append(f"{f} (node_modules)")
    # 키 패턴: 내용에서 찾는다. 값은 적지 않고 경로:줄 만 남긴다.
    ant = re.compile(rb"sk-ant-[A-Za-z0-9_\-]{20,}")
    jwt = re.compile(rb"eyJ[A-Za-z0-9_\-]{10,}\.(eyJ[A-Za-z0-9_\-]{10,})\.[A-Za-z0-9_\-]{10,}")
    scanned = 0
    for f in files:
        p = top / f
        try:
            if not p.is_file() or p.stat().st_size > 5_000_000:
                continue
            data = p.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:2048]:
            continue          # 이진 파일
        scanned += 1
        for i, line in enumerate(data.split(b"\n"), 1):
            if ant.search(line):
                bad.append(f"{f}:{i} (sk-ant- 키 형태)")
            for m in jwt.finditer(line):
                try:
                    pad = m.group(1) + b"=" * (-len(m.group(1)) % 4)
                    role = json.loads(base64.urlsafe_b64decode(pad)).get("role")
                except Exception:
                    role = None
                if role == "service_role":
                    bad.append(f"{f}:{i} (service_role JWT)")
    if bad:
        return False, f"{len(bad)}건: " + "; ".join(bad[:8]) + (" …" if len(bad) > 8 else "")
    return True, f"추적 파일 {len(files)}개 · 내용 검사 {scanned}개 — .env·*.db·output/·node_modules·실제 키 없음"


STEPS = [
    ("unit", "단위 테스트 (test_severity)", step_unit),
    ("scenarios", "시나리오 5종 (test_scenarios, 구조 모드)", step_scenarios),
    ("streamlit", "Streamlit 헤드리스 (streamlit_check, local)", step_streamlit),
    ("tsc", "웹 타입 검사 (tsc)", step_tsc),
    ("ui", "화면·서버 전체 점검 (run_all: 방문객·관리자·연결 끊김·속도·보안·모바일·빌드본 문법 0·JS 실패 안내)", step_ui),
    ("exclude", "제외 확인 (D8-3)", step_exclude),
]


def main() -> int:
    for stream in (sys.stdout, sys.stderr):              # Windows 콘솔(cp949)에서 ✓ · — 같은 글자로 죽지 않게
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="제출 직전 회귀 검사")
    ap.add_argument("--only", default="", help="쉼표로 구분한 단계만: " + ",".join(s[0] for s in STEPS))
    ap.add_argument("--skip", default="", help="뺄 단계")
    args = ap.parse_args()
    only = {x for x in args.only.split(",") if x}
    skip = {x for x in args.skip.split(",") if x}
    unknown = (only | skip) - {s[0] for s in STEPS}
    if unknown:
        print("알 수 없는 단계:", ", ".join(sorted(unknown)), file=sys.stderr)
        return 2

    saved = {p: p.read_bytes() for p in PRESERVE if p.exists()}
    rows = []
    t_all = time.time()
    try:
        for key, title, fn in STEPS:
            if (only and key not in only) or key in skip:
                rows.append((title, "건너뜀", "-", "선택에서 제외"))
                continue
            print(f"[final_check] {title} …", flush=True)
            t0 = time.time()
            try:
                ok, note = fn()
            except Exception as e:          # 한 단계가 터져도 나머지는 계속
                ok, note = False, f"검사 중 예외: {type(e).__name__}: {e}"
            sec = time.time() - t0
            rows.append((title, "통과" if ok else "실패", f"{sec:.0f}초", note))
            print(f"[final_check]   → {'통과' if ok else '실패'} ({sec:.0f}초) {note}", flush=True)
    finally:
        for p, b in saved.items():
            try:
                p.write_bytes(b)
            except OSError:
                pass

    fails = [r for r in rows if r[1] == "실패"]
    ran = [r for r in rows if r[1] != "건너뜀"]
    head = "**전부 통과**" if not fails and ran else (f"**실패 {len(fails)}건**" if fails else "실행한 단계 없음")
    md = [
        "# 제출 직전 회귀 검사 (D8)", "",
        f"- 수행 {datetime.now():%Y-%m-%d %H:%M} · 총 {time.time() - t_all:.0f}초 · 결과 {head}",
        "- 모드: LLM_BACKEND=local (claude_code·API 실측 없음) · 운영 DB 미사용 (시험별 복사본·별도 포트)",
        "- 제출용 기록(testcase_report.md · streamlit_check.md)은 실행 전 내용으로 되돌림 (화면 점검 상세는 tests/ui/report.md)", "",
        "| # | 항목 | 결과 | 시간 | 내용 |", "|---|---|---|---|---|",
    ]
    for i, (title, verdict, sec, note) in enumerate(rows, 1):
        mark = {"통과": "✅ 통과", "실패": "❌ 실패", "건너뜀": "○ 건너뜀"}[verdict]
        md.append(f"| {i} | {title} | {mark} | {sec} | {note.replace('|', '/')} |")
    md.append("")
    REPORT.write_text("\n".join(md), encoding="utf-8")
    print(f"\n[final_check] {head} → {REPORT}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
