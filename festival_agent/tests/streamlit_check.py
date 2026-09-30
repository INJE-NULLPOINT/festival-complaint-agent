"""Streamlit 화면 헤드리스 점검 — 사람이 브라우저로 돌기 전 자동 확인 (할일 D5-4).

streamlit.testing.v1.AppTest 로 app.py · pages/1~3 을 실제로 실행한다.
festival.db 를 임시 파일로 복사해서 돌리므로 운영 DB 는 건드리지 않는다.

  1. 네 화면 모두 예외 0
  2. 접수 폼으로 민원 1건 제출 → feedback 에 pending 으로 들어감
  3. ①분류 에이전트 1회 (선택한 백엔드) → 분류 반영
  4. 관제: 건수·심각도 순위 표, 백엔드 표시, 실시간 유입에 방금 민원과 유형
  5. 조치: 처리현황에 superseded 없음, '요청서 생성' → doc_job 큐 (작성은 워커)

실행
    python tests/streamlit_check.py                       # claude_code (모델 호출 1~2회)
    python tests/streamlit_check.py --backend local       # 비용 없이 구조만
결과: tests/streamlit_check.md
"""
import argparse
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = Path(__file__).resolve().parent / "streamlit_check.md"
PAGES = ["app.py", "pages/1_접수.py", "pages/2_관제.py", "pages/3_조치.py"]
TEXT = "유등 터널 출구 계단에 조명이 꺼져 있어서 발을 헛디뎠어요"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["claude_code", "local", "anthropic"],
                    default="claude_code")
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="st_check_")
    src = sqlite3.connect(ROOT / "festival.db")
    dst = sqlite3.connect(Path(tmp) / "festival.db")
    src.backup(dst)
    src.close()
    dst.close()
    os.environ["DB_PATH"] = str(Path(tmp) / "festival.db")   # core 를 불러오기 전에
    os.environ["LLM_BACKEND"] = args.backend
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))

    from streamlit.testing.v1 import AppTest
    from core import config, db, llm

    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, bool(ok), detail))
        print(f"  {'✓' if ok else '✗'} {name}  {detail}")

    def page(path: str) -> AppTest:
        return AppTest.from_file(str(ROOT / path), default_timeout=120)

    # 1. 네 화면 예외 0
    for p in PAGES:
        at = page(p).run()
        check(f"{p} 실행 예외 0", not at.exception,
              "; ".join(e.message[:120] for e in at.exception))

    # 2. 접수 폼 제출
    at = page("pages/1_접수.py").run()
    zone = at.selectbox[0].value
    at.text_area[0].input(TEXT)
    at.button[0].click().run()
    with db.connect() as conn:
        fb = conn.execute(
            "SELECT f.id, c.status FROM feedback f JOIN classification c ON c.feedback_id=f.id "
            "WHERE f.raw_text LIKE ? ORDER BY f.id DESC LIMIT 1", ("%발을 헛디뎠어요%",)
        ).fetchone()
    check("접수 폼 제출 → 성공 안내", any("접수되었습니다" in s.value for s in at.success),
          f"구역 {zone}")
    check("feedback 에 pending 적재", fb is not None and fb["status"] == "pending",
          f"feedback #{fb['id'] if fb else '-'}")

    # 3. ①분류 1회 (워커의 메인 스레드가 하는 일)
    from agents.classifier import run_once as classify
    t0 = time.time()
    classify(limit=5)
    took = time.time() - t0
    with db.connect() as conn:
        row = conn.execute(
            "SELECT label, is_safety, confidence, status FROM classification WHERE feedback_id=?",
            (fb["id"],)).fetchone() if fb else None
    label = row["label"] if row else None
    check("①분류 반영", row is not None and row["status"] == "done",
          f"{args.backend} · {took:.1f}초 · {label} · 안전 {row['is_safety'] if row else '-'}")

    # 4. 관제
    at = page("pages/2_관제.py").run()
    heads = [h.value for h in at.subheader]
    check("관제: 건수·심각도 순위 표", any(h.startswith("건수 순위") for h in heads)
          and "심각도 순위" in heads and len(at.dataframe) >= 2, f"표 {len(at.dataframe)}개")
    side = " ".join(x.value for x in (*at.sidebar.info, *at.sidebar.warning, *at.sidebar.success))
    check("관제: 사이드바 백엔드 표시", f"**{llm.backend()}**" in side, llm.backend())
    feed = " ".join(m.value for m in at.markdown)
    ko = config.LABELS.get(label, "")
    check("관제: 실시간 유입에 방금 민원·유형", "발을 헛디뎠어요" in feed and ko and ko in feed, ko)

    # 5. 조치 — 관리 동작은 운영자 코드가 있어야 한다 (D5-31). 이 점검 안에서만 쓰는 임시 코드를 설정한다.
    check_code = "check-only-temp-code"
    config.ADMIN_CODE = check_code
    at = page("pages/3_조치.py").run()
    check("조치: 코드 입력 전에는 관리 동작이 잠김",
          not [b for b in at.button if b.label in ("요청서 생성", "▶ 시작")] and len(at.radio) == 0,
          "요청서 생성·상태 변경·리플레이 버튼 없음")
    at.sidebar.text_input[0].input(check_code).run()
    [b for b in at.sidebar.button if b.label == "확인"][0].click().run()
    with db.connect() as conn:
        shown = conn.execute(
            "SELECT COUNT(*) n FROM action_request WHERE status != 'superseded'").fetchone()["n"]
        superseded = conn.execute(
            "SELECT COUNT(*) n FROM action_request WHERE status = 'superseded'").fetchone()["n"]
    check("조치: 처리현황에 superseded 제외", len(at.radio) == shown,
          f"상태 선택 {len(at.radio)}개 = 열린·완료 {shown}건 (대체됨 {superseded}건 숨김)")
    gen = [b for b in at.button if b.label == "요청서 생성"]
    if gen:
        target = gen[0].key.removeprefix("gen_")
        gen[0].click().run()
        jobs = db.doc_job_states()
        ok = jobs.get(target, {}).get("status") == "queued"
        check("조치: '요청서 생성' → doc_job 큐", ok and not at.exception,
              f"{target} → {jobs.get(target, {}).get('status')} · 작성은 워커 doc_jobs 스레드")
        waiting = [c.value for c in at.caption if "대기 중" in c.value or "작성 중" in c.value]
        check("조치: 대기 상태 표시", bool(waiting), waiting[0] if waiting else "")
    else:
        check("조치: '요청서 생성' 버튼", True, "모든 대상 유형에 요청서가 있어 버튼 없음 (정상)")

    shutil.rmtree(tmp, ignore_errors=True)

    passed = sum(ok for _, ok, _ in results)
    lines = [
        "# Streamlit 화면 헤드리스 점검 (D5-4)",
        "",
        f"- 수행 {datetime.now():%Y-%m-%d %H:%M} · 백엔드 `{args.backend}` · 모델 `{config.MODEL}`",
        "- 도구 `streamlit.testing.v1.AppTest` · festival.db 임시 복사본에서 실행 (운영 DB 미변경)",
        f"- 결과 **{passed}/{len(results)} 통과**",
        "",
        "| # | 항목 | 결과 | 비고 |",
        "|---|---|---|---|",
        *[f"| {i} | {n} | {'통과' if ok else '**실패**'} | {d.replace('|', '/')} |"
          for i, (n, ok, d) in enumerate(results, 1)],
        "",
        "## 한계",
        "",
        "- 자동 갱신(5초 fragment)·다운로드 버튼 동작·레이아웃은 헤드리스로 보지 못한다. "
        "최종 확인은 사람이 브라우저로 1바퀴 (`streamlit run app.py` + `python worker.py`).",
        "- 요청서 작성 자체는 워커가 한다. 여기서는 큐 적재까지만 본다.",
        "",
    ]
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n{passed}/{len(results)} 통과 → {REPORT}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
