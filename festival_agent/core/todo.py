"""할 일 목록을 시스템 상태에서 자동 갱신한다.

두 종류의 항목이 있다.

  auto    시스템을 직접 들여다보고 판정한다. 파일 존재, DB 기록, 환경변수 등.
          사람이 체크를 바꿔도 다음 갱신 때 증거대로 되돌아간다.
  manual  사람이 직접 체크한다. 갱신해도 체크 상태와 메모가 보존된다.

worker.py 가 Agent Path 를 한 바퀴 돌 때마다 이 파일을 다시 그린다.
`python cli.py todo --watch` 로 파일을 편집하는 즉시 반영되게 볼 수도 있다.
"""
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

from . import config, db

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT.parent                      # "ai 대회" 폴더
TODO_PATH = PROJECT / "할일.md"
STATE_PATH = ROOT / ".todo_state.json"     # 최초 달성 시각. DB 초기화에도 남는다

DONE_RE = re.compile(r"^- \[(x| )\]\s+`([A-Z0-9\-]+)`\s+(.*)$")


@dataclass
class Task:
    id: str
    title: str
    phase: str
    check: Callable[[], tuple[bool, str]] | None = None   # (완료여부, 증거)
    note: str = ""

    @property
    def auto(self) -> bool:
        return self.check is not None


# ── 판정 함수들 ───────────────────────────────────────────────────

def _env_has(key: str) -> tuple[bool, str]:
    if os.getenv(key):
        return True, "환경변수 설정됨"
    envf = ROOT / ".env"
    # \s 는 줄바꿈까지 먹어서 빈 값 다음 줄의 주석을 값으로 오인했다 — 같은 줄의 공백만 허용
    if envf.exists() and re.search(rf"^{key}[ \t]*=[ \t]*[^\s#]", envf.read_text(encoding="utf-8"), re.M):
        return True, ".env 에 설정됨"
    return False, "미설정"


def _file(path: Path, label: str = "") -> tuple[bool, str]:
    if path.exists():
        kb = path.stat().st_size / 1024
        return True, f"{label or path.name} ({kb:.1f}KB)"
    return False, f"{path.name} 없음"


def _anthropic_ran() -> tuple[bool, str]:
    """실제 모델로 에이전트가 돈 흔적이 있는가.

    실제 API 를 부를 때마다 llm.py 가 action='api_call' 행을 남긴다.
    local 대역·캐시 적중은 이 행을 남기지 않는다.
    """
    with db.connect() as conn:
        row = conn.execute(
            """SELECT COUNT(*) c FROM agent_log
               WHERE action='api_call'
                 AND agent IN ('classifier','monitor','dispatcher','supervisor')"""
        ).fetchone()
    n = row["c"]
    return (n > 0, f"실제 모델 API 호출 {n}회" if n else "local 대역 기록만 있음")


def _accuracy_measured() -> tuple[bool, str]:
    p = ROOT / "tests" / "accuracy_report.md"
    if not p.exists():
        return False, "accuracy_report.md 없음"
    text = p.read_text(encoding="utf-8")
    m = re.search(r"(?m)^## anthropic\s*$[\s\S]*?\*\*정확도 ([\d.]+%)", text)
    if m:
        return True, f"실제 모델 정확도 {m.group(1)}"
    m = re.search(r"\*\*정확도 ([\d.]+%)", text)
    return False, f"local 대역만 측정됨 ({m.group(1) if m else '?'}) — --backend anthropic 필요"


def _scenarios_live() -> tuple[bool, str]:
    p = ROOT / "tests" / "testcase_report.md"
    if not p.exists():
        return False, "리포트 없음"
    t = p.read_text(encoding="utf-8")
    live = "--live" in t and "실제 LLM 호출" in t
    b = re.search(r"(?m)^- 백엔드: (\S+)", t)
    be = b.group(1) if b else "?"
    passed = re.search(r"\*\*(\d+)/(\d+) 통과\*\*", t)
    score = f"{passed.group(1)}/{passed.group(2)} 통과" if passed else "결과 미상"
    if not live:
        return False, f"구조 검증 모드 {score}"
    # 제출 검증은 API(anthropic) 만 인정. claude_code 는 참고값.
    if be != "anthropic":
        return False, f"live {score} (백엔드 {be} — 참고값, anthropic 필요)"
    return True, f"live 모드 {score}"


def _blanks(path: Path, label: str) -> tuple[bool, str]:
    """〔 〕 빈칸이 남아 있는지."""
    if not path.exists():
        return False, f"{label} 없음"
    n = path.read_text(encoding="utf-8").count("〔")
    return (n == 0, "빈칸 없음" if n == 0 else f"빈칸 {n}곳 남음")


REAL_SEED_MIN = 100


def _real_seed() -> tuple[bool, str]:
    """실제 수집 시드: seed/ 의 CSV 중 출처 URL 이 채워진 행이 100개 이상인 파일.

    CSV 가 있기만 하면 통과로 보면 빈 템플릿·합성 파일에도 체크가 붙는다.
    수집·정제 도구: scripts/clean_reviews.py (템플릿은 scripts/templates/).
    """
    import csv

    best = ("", -1)
    for p in sorted((ROOT / "seed").glob("*.csv")) if (ROOT / "seed").exists() else []:
        if p.name == "dev_sample.csv":
            continue
        with p.open(encoding="utf-8-sig", newline="") as f:
            n = sum(1 for r in csv.DictReader(f)
                    if (r.get("text") or "").strip() and (r.get("source_url") or "").strip())
        if n > best[1]:
            best = (p.name, n)
    if best[1] >= REAL_SEED_MIN:
        return True, f"실제 시드 {best[0]} (출처 있는 행 {best[1]})"
    if best[0]:
        return False, f"{best[0]} 출처 있는 행 {best[1]}/{REAL_SEED_MIN}"
    return False, "dev_sample.csv(합성) 만 있음"


def _docx_made() -> tuple[bool, str]:
    n = len(list((ROOT / "output").glob("*.docx"))) if (ROOT / "output").exists() else 0
    return (n > 0, f"조치요청서 {n}건 생성됨" if n else "생성 이력 없음")


def _backend_is_anthropic() -> tuple[bool, str]:
    from . import llm
    b = llm.backend()
    return (b == "anthropic", f"현재 백엔드 {b}")


def _e2e_done() -> tuple[bool, str]:
    """접수→분류→심각도→조치→브리핑이 실제로 한 번 관통했는가."""
    with db.connect() as conn:
        cls = conn.execute(
            "SELECT COUNT(*) c FROM classification WHERE status='done'").fetchone()["c"]
        sev = conn.execute("SELECT COUNT(*) c FROM severity").fetchone()["c"]
        act = conn.execute("SELECT COUNT(*) c FROM action_request").fetchone()["c"]
        brf = conn.execute("SELECT COUNT(*) c FROM briefing").fetchone()["c"]
    ok = cls and sev and act and brf
    return bool(ok), f"분류 {cls} · 심각도 {sev} · 조치 {act} · 브리핑 {brf}"


def _web_doc_done() -> tuple[bool, str]:
    """웹 '조치요청서 생성' 버튼 요청이 워커를 거쳐 미리보기까지 만들어졌는가."""
    try:
        with db.connect() as conn:
            n = conn.execute(
                """SELECT COUNT(*) c FROM doc_job j JOIN action_request a
                   ON a.id = j.action_request_id
                   WHERE j.status='done' AND a.doc_json IS NOT NULL""").fetchone()["c"]
    except Exception:
        return False, "doc_job 테이블 없음 (worker.py 한 번 실행)"
    return (n > 0, f"웹 요청 조치요청서 {n}건" if n else "웹 요청 이력 없음")


def _web_env_has(*keys: str) -> bool:
    envf = ROOT / "web" / ".env"
    text = envf.read_text(encoding="utf-8") if envf.exists() else ""
    return all(re.search(rf"^{k}\s*=\s*\S", text, re.M) for k in keys)


def _supabase_linked() -> tuple[bool, str]:
    """워커(.env)와 웹(web/.env) 둘 다 Supabase 를 가리키는가.

    webapi.py 는 지우지 않는다. 키가 있으면 웹이 알아서 Supabase 로 붙고
    local 대역은 쓰이지 않는다 (web/src/data.ts).
    """
    worker = _env_has("SUPABASE_DB_URL")[0]
    web = _web_env_has("VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY")
    ok = worker and web
    return ok, (f"워커 {'Supabase' if worker else 'SQLite'} · "
                f"웹 {'Supabase' if web else 'local 대역'}")


def _stand_in_removed() -> tuple[bool, str]:
    """Supabase 키가 연결돼 local 대역이 비활성인가."""
    ok, ev = _supabase_linked()
    return ok, ("local 대역 비활성 · " if ok else "") + ev


def _no_stand_in() -> tuple[bool, str]:
    """제출본에 local 대역이 쓰이지 않는가 (LLM · 웹 둘 다)."""
    from . import llm
    b = llm.backend()
    linked, ev = _supabase_linked()
    return b == "anthropic" and linked, f"LLM {b} · {ev}"


def _user_validation() -> tuple[bool, str]:
    return _blanks(PROJECT / "제출_준비" / "실사용자_검증_확인서.md", "확인서")


def _submission_file(name: str) -> Callable[[], tuple[bool, str]]:
    return lambda: _file(PROJECT / "제출_준비" / name)


# ── 항목 정의 ─────────────────────────────────────────────────────

TASKS: list[Task] = [
    # D5 안정화
    Task("D5-1", "`.env` 에 ANTHROPIC_API_KEY 설정", "D5 오류수정·안정화",
         lambda: _env_has("ANTHROPIC_API_KEY")),
    Task("D5-2", "실제 모델로 에이전트 한 바퀴 (`cli.py cycle`)", "D5 오류수정·안정화",
         _anthropic_ran,
         note="지금까지 검증은 전부 규칙 기반 대역입니다. 제출본은 실제 모델이어야 합니다."),
    Task("D5-3", "역할 프롬프트 4종 튜닝 (실제 출력 보고 조정)", "D5 오류수정·안정화"),
    Task("D5-4", "Streamlit 화면을 실제 모델 백엔드로 끝까지 조작", "D5 오류수정·안정화"),
    Task("D5-5", "TourAPI 키 발급 (Tool 4점 보강)", "D5 오류수정·안정화",
         lambda: _env_has("TOURAPI_KEY"),
         note="없어도 동작하지만 외부 API 연동 근거가 약해집니다."),
    Task("D5-6", "Supabase 이전 (SQLite→Postgres)", "D5 오류수정·안정화",
         lambda: _env_has("SUPABASE_DB_URL"),
         note="없으면 local 대역(SQLite + webapi.py)으로 동작합니다. 전환 절차는 README '웹 앱' 절."),
    Task("D5-7", "웹 앱 기초 UI (TS 단일 페이지: 접수·관제·조치)", "D5 오류수정·안정화",
         lambda: _file(ROOT / "web" / "src" / "main.ts")),
    Task("D5-8", "웹에서 심각도 기반 조치요청서 생성·미리보기 확인", "D5 오류수정·안정화",
         _web_doc_done,
         note="실시간 용도라 화면은 단순하게 유지합니다."),
    Task("D5-9", "Supabase 키 연결 시 local 대역 비활성", "D5 오류수정·안정화",
         _stand_in_removed,
         note="web/.env 에 URL·anon 키를 넣으면 웹은 자동으로 Supabase 로 붙습니다. webapi.py 는 남겨 둡니다."),
    Task("D5-10", "Supabase 로컬 대역 완성 (DOCX 서빙 · 공용 쿼리 · RPC 검증 일치)",
         "D5 오류수정·안정화"),
    Task("D5-11", "todo 판정 수정 (webapi.py 삭제 대신 Supabase 키 설정 여부)",
         "D5 오류수정·안정화"),
    Task("D5-12", "Supabase 전환 절차 문서화 (README · .env.example)", "D5 오류수정·안정화"),
    Task("D5-13", "모델 ID claude-opus-5 → claude-opus-5-5 전환", "D5 오류수정·안정화"),
    Task("D5-14", "Claude Code CLI 백엔드(LLM_BACKEND=claude_code)", "D5 오류수정·안정화"),
    Task("D5-15", "웹 화면 가독성 개선", "D5 오류수정·안정화"),
    Task("D5-16", "실시간 테스트 결함 수정", "D5 오류수정·안정화"),
    Task("D5-17", "통합 에이전트 조치상태 오판 수정", "D5 오류수정·안정화"),
    Task("D5-18", "휴대폰 사용 시 화면 깨짐 점검", "D5 오류수정·안정화"),
    Task("D5-19", "에이전트 실행 중 새 민원 접수·분류 지연", "D5 오류수정·안정화"),
    Task("D5-21", "분류 기준 조정 (혼잡↔안전 경계)", "D5 오류수정·안정화"),
    Task("D5-20", "방문객 앱 디자인 적용 (Stitch 3화면 · 디자인_화면내용정리.md)", "D5 오류수정·안정화"),

    Task("D5-23", "관리자 화면(관제·조치) 흑백 디자인 — 방문객 앱과 같은 톤", "D5 오류수정·안정화"),

    Task("D5-24", "방문객 접수: 119 박스 제거 · 접수 완료를 모달로", "D5 오류수정·안정화"),

    Task("D5-25", "내용 없는 민원(\"...\") 접수·오분류·거짓 즉시 알림", "D5 오류수정·안정화"),
    Task("D5-26", "유형 아이콘 · 전체 애니메이션", "D5 오류수정·안정화"),

    Task("D5-27", "구형 폰 브라우저에서 화면이 안 뜸 (JS 미실행)", "D5 오류수정·안정화"),

    Task("D5-28", "민원 신청(방문객) 페이지 둥근 디자인", "D5 오류수정·안정화"),

    Task("D5-29", "관제를 '조치할 일' 중심으로 — 문제·위치·우선순위·해야 할 일", "D5 오류수정·안정화"),

    Task("D5-30", "관제 민원 지우기 버튼 (숨김·되돌리기)", "D5 오류수정·안정화"),

    Task("D5-31", "관리자 기능 보호 — 방문객이 지우기·상태변경·요청서 호출 못 하게", "D5 오류수정·안정화"),

    Task("D5-32", "확인 필요 민원 처리 (유형 지정·닫기·지우기)", "D5 오류수정·안정화"),

    Task("D5-33", "접수 도배 방지 (같은 기기·구역 연속 접수 제한)", "D5 오류수정·안정화"),
    Task("D5-34", "서버·워커 멈춤 대비 — 자동 재시작·DB 손상 대비 백업", "D5 오류수정·안정화"),
    Task("D5-35", "Streamlit 화면에 조치할 일 카드·확인 필요 반영", "D5 오류수정·안정화"),
    Task("D5-36", "연결 끊김·서버 다운 시 화면 표시와 자동 재연결", "D5 오류수정·안정화"),
    Task("D5-37", "대량 데이터(민원 1,000건) 화면·API 속도", "D5 오류수정·안정화"),
    Task("D5-38", "접근성 점검 (키보드·스크린리더·대비)", "D5 오류수정·안정화"),
    Task("D5-39", "빈 화면·오류 화면 문구와 모양 다듬기", "D5 오류수정·안정화"),
    Task("D5-40", "보안·입력 점검 (webapi 입력 크기·CORS·오류 노출)", "D5 오류수정·안정화"),

    Task("D5-41", "사용설명서 2종 최신화 (카드·지우기·확인 필요·배지·운영자 코드)", "D5 오류수정·안정화"),
    Task("D5-42", "지운 민원 목록·복구 (5초 토스트 뒤에도 되돌리기)", "D5 오류수정·안정화"),

    Task("D5-43", "출처 판정 위조 방지 (X-Forwarded-For 는 믿는 프록시가 붙인 마지막 값만)", "D5 오류수정·안정화"),

    # D6 테스트·검증
    Task("D6-1", "Test Case 5종 `--live` 수행", "D6 테스트·검증", _scenarios_live,
         note="현재 리포트는 구조 검증 모드 결과입니다."),
    Task("D6-2", "분류 정확도 측정 스크립트 작성", "D6 테스트·검증",
         lambda: _file(ROOT / "scripts" / "measure_accuracy.py")),
    Task("D6-3", "정확도 측정 실행 (대역 vs 실제 모델)", "D6 테스트·검증",
         _accuracy_measured,
         note="신청서에 적은 '85% 이상' 목표의 근거가 됩니다."),
    Task("D6-4", "실사용자 3명 검증 (+1점 가점)", "D6 테스트·검증", _user_validation,
         note="QR 접수폼은 일반인이 바로 쓸 수 있어 동기 3명이면 충족됩니다."),
    Task("D6-5", "민원 1건 처리 원가 실측 (agent_log 토큰 기록)", "D6 테스트·검증",
         lambda: _file(PROJECT / "제출_준비" / "원가측정.md"),
         note="비즈니스 모델 10점의 핵심 숫자입니다."),
    Task("D6-6", "실제 수집 리뷰로 시드 교체", "D6 테스트·검증", _real_seed,
         note="dev_sample.csv 는 합성 데이터입니다. 실제 수집분으로 제출해야 합니다."),

    Task("D6-7", "테스트 공백 메우기 — 감시·알림 규칙, 요청서 내용 검증", "D6 테스트·검증"),
    Task("D6-8", "동시 접수·벽시계 지연 자동 측정", "D6 테스트·검증"),
    # D7 제출물
    Task("D7-1", "시연영상 3분", "D7 제출물",
         lambda: _file(PROJECT / "제출_준비" / "시연영상.mp4"),
         note="1:30~2:00 역전 구간이 핵심. cli.py watch 또는 관제 화면 사용."),
    Task("D7-2", "개발완료보고서 A4 5p", "D7 제출물",
         _submission_file("개발완료보고서.md")),
    Task("D7-3", "기술설명서 1p", "D7 제출물",
         _submission_file("기술설명서.md"),
         note="설계 문서 말미에 대응표가 있습니다."),
    Task("D7-4", "발표자료 10장", "D7 제출물",
         _submission_file("발표자료.md"),
         note="본선 6분 구성: 문제30초/Agent1분/구조1분/시연2분30초/성과30초/발전계획30초"),
    Task("D7-5", "비즈니스 모델 빈칸 채우기 (10점)", "D7 제출물",
         lambda: _blanks(PROJECT / "제출_준비" / "비즈니스모델.md", "비즈니스모델"),
         note="단가·시장규모. 근거 없는 숫자는 쓰지 말 것."),
    Task("D7-6", "별지2 출처·AI 활용 신고서", "D7 제출물",
         _submission_file("출처신고서.md")),
    Task("D7-7", "소스 저장소 정리 (접근 권한·비밀키 제거)", "D7 제출물"),

    # D8 최종 제출
    Task("D8-1", "회귀 테스트 (단위 10건 + 시나리오 5건 + Streamlit 13항목)", "D8 최종 제출"),
    Task("D8-2", "백엔드가 anthropic 인지 확인", "D8 최종 제출", _backend_is_anthropic),
    Task("D8-3", "`.env` · `web/.env` · `festival.db` 제출물에서 제외 확인", "D8 최종 제출"),
    Task("D8-4", "구글폼 제출 (10/6 낮 12시 마감)", "D8 최종 제출"),
    Task("D8-5", "제출본에 local 대역 없음 (LLM · 웹)", "D8 최종 제출", _no_stand_in),
]

# 이미 끝난 것도 남겨 둔다. 되돌아갈 수 있기 때문이다.
DONE_TASKS: list[Task] = [
    Task("E2E", "접수→분류→심각도→조치→브리핑 관통", "완료 (자동 확인)", _e2e_done),
    Task("DOCX", "조치요청서 DOCX 생성", "완료 (자동 확인)", _docx_made),
]

# 끝나서 진행현황.md 로 옮긴 항목. 할 일 목록에는 그리지 않고 완료로만 센다.
# auto 항목은 판정이 다시 실패하면(되돌아가면) 목록에 다시 나타난다.
ARCHIVED: set[str] = {
    "E2E", "DOCX", "D5-3", "D5-7", "D5-8", "D5-10", "D5-11", "D5-12", "D5-13",
    "D5-15", "D5-16", "D5-17", "D5-19", "D5-20", "D5-21", "D5-23", "D5-24", "D5-25", "D5-26", "D5-27", "D5-28", "D5-29", "D5-30", "D5-32", "D5-35", "D5-36", "D5-43", "D6-2",
}

# AI 가 할 수 있는 일은 끝났고 키나 사람만 남은 항목. 한 줄로 모아 '대기' 절에 그린다.
# 판정(auto)이 통과하면 자동으로 완료 처리된다. 준비된 것은 진행현황.md 에 있다.
WAITING: dict[str, str] = {
    "D5-1": "키 — ANTHROPIC_API_KEY 를 .env 에",
    "D5-2": "키 — API 키 후 `cli.py cycle` (claude_code 로는 통과)",
    "D5-4": "사람 — 브라우저로 Streamlit 1바퀴 (헤드리스 13/13 통과)",
    "D5-5": "키 — TourAPI 발급",
    "D5-6": "키 — Supabase (전환 절차 README '웹 앱')",
    "D5-9": "키 — Supabase",
    "D5-14": "사람 — 웹 브라우저 1바퀴 (구현·검증 끝)",
    "D5-18": "사람 — 실제 폰 확인 http://192.168.0.24:4173/?v=qr (구형 브라우저용 빌드, 5폭 30/30 통과)",
    "D6-1": "키 — API 로 `--live` (claude_code 5/5 통과)",
    "D6-3": "키 — API 로 재측정 (claude_code 100%)",
    "D6-4": "사람 — 3명 (QR·확인서 준비: 제출_준비/qr/)",
    "D6-5": "키 — API 로 실측 (참고값 제출_준비/원가측정_참고.md)",
    "D5-31": "사람 — festival_agent/.env 에 ADMIN_CODE= 직접 입력(구현·검증 끝: 코드 없음·틀림 거부, 5회 잠금, 방문객 접수 통과)",
    "D6-6": "사람 — 실제 리뷰 수집 (가이드: 제출_준비/실제리뷰_수집가이드.md)",
}


# ── 파싱 · 렌더링 ─────────────────────────────────────────────────

def _load_state() -> dict[str, str]:
    import json
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def _save_state(state: dict[str, str]) -> None:
    import json
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2),
                          encoding="utf-8")


def parse_existing(path: Path = TODO_PATH) -> dict[str, tuple[bool, list[str]]]:
    """기존 파일에서 체크 상태와 사람이 쓴 메모를 읽어온다."""
    if not path.exists():
        return {}
    state: dict[str, tuple[bool, list[str]]] = {}
    current: str | None = None
    for line in path.read_text(encoding="utf-8").split("\n"):
        m = DONE_RE.match(line)
        if m:
            current = m.group(2)
            state[current] = (m.group(1) == "x", [])
        elif current and line.startswith("      > "):      # 사람이 쓴 메모
            state[current][1].append(line[8:])
        elif line.strip() == "" or line.startswith("#"):
            current = None
    return state


def _titles(path: Path) -> dict[str, str]:
    """기존 파일의 항목 제목. TASKS 에 없는 항목을 보존할 때 쓴다."""
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").split("\n"):
        m = DONE_RE.match(line)
        if m:
            out[m.group(2)] = m.group(3)
    return out


def render(path: Path = TODO_PATH) -> str:
    prev = parse_existing(path)
    state = _load_state()
    state_dirty = False
    now = datetime.now()

    lines = [
        "# 할 일",
        "",
        "제4회 경남 AI·SW 경진대회 · 실시간 축제 민원 관제 AI Agent",
        "",
        f"자동 갱신: {now.strftime('%Y-%m-%d %H:%M:%S')} · "
        f"제출 마감 2026-10-06(수) 12:00 (D-{(datetime(2026,10,6) - now).days})",
        "",
        "`auto` 항목은 시스템을 직접 확인해 표시합니다. 체크를 바꿔도 다음 갱신 때",
        "증거대로 돌아갑니다. 그 외 항목은 직접 체크하시면 그대로 보존됩니다.",
        "항목 아래 `      > 메모` 형식으로 쓴 줄도 보존됩니다.",
        "",
    ]

    groups: dict[str, list[Task]] = {}
    for t in DONE_TASKS + TASKS:
        groups.setdefault(t.phase, []).append(t)

    total = done_n = archived_n = 0
    body: list[str] = []
    waiting: list[str] = []
    for phase, tasks in groups.items():
        section: list[str] = []
        for t in tasks:
            if t.id in ARCHIVED and (not t.auto or t.check()[0]):
                total += 1
                done_n += 1
                archived_n += 1
                continue
            if t.auto:
                ok, evidence = t.check()
                if ok and t.id not in state:
                    state[t.id] = now.strftime("%Y-%m-%d %H:%M")
                    state_dirty = True
                elif not ok and t.id in state:
                    # 한 번 달성했는데 지금은 아니다. DB 초기화 등으로 증거가
                    # 사라진 경우다. 지금 상태를 정직하게 보여주되 이력은 남긴다.
                    evidence = f"{evidence} (이전 달성 {state[t.id][5:10]})"
                tag = f"  `auto` {evidence}"
            else:
                ok = prev.get(t.id, (False, []))[0]
                tag = ""
            if t.id in WAITING:
                total += 1
                if ok:                     # 키·사람이 채워 통과하면 끝난 것으로
                    done_n += 1
                    archived_n += 1
                else:
                    waiting.append(f"- [ ] `{t.id}` {t.title} — {WAITING[t.id]}")
                    # 대기 항목에도 준비·설계 메모가 붙는다. 지우지 않는다.
                    waiting += [f"      > {m}" for m in prev.get(t.id, (False, []))[1]]
                continue
            total += 1
            done_n += bool(ok)
            section.append(f"- [{'x' if ok else ' '}] `{t.id}` {t.title}{tag}")
            if t.note:
                section.append(f"      {t.note}")
            for memo in prev.get(t.id, (False, []))[1]:
                section.append(f"      > {memo}")
        if section:
            body += [f"## {phase}", ""] + section + [""]

    # 파일에는 있는데 TASKS 에 없는 항목. 사람이 새로 적었거나, 이 파일을 그리는
    # 프로세스가 옛 TASKS 를 들고 있는 경우다. 지우지 않고 그대로 옮겨 둔다.
    known = {t.id for t in DONE_TASKS + TASKS}
    titles = _titles(path)
    orphans: list[str] = []
    for tid, (ok, memos) in prev.items():
        if tid in known:
            continue
        orphans.append(f"- [{'x' if ok else ' '}] `{tid}` {titles.get(tid, '')}".rstrip())
        orphans += [f"      > {m}" for m in memos]
    if orphans:
        body += ["## 목록에 없는 항목 (core/todo.py TASKS 에 등록하면 제자리로 갑니다)", ""] + orphans + [""]

    if state_dirty:
        _save_state(state)

    bar = "█" * round(done_n / total * 24) if total else ""
    lines += [f"진행 {done_n}/{total}  `{bar:<24}`", ""]
    if archived_n:
        lines += [f"끝난 {archived_n}개는 `진행현황.md` 로 옮겼습니다.", ""]
    if waiting:
        lines += ["## 대기 — 키나 사람이 있어야 끝남 (AI 작업은 끝남)", ""] + waiting + [""]
    lines += body
    lines += [
        "## 갱신 방법",
        "",
        "```bash",
        "python cli.py todo             # 지금 상태로 다시 그리기",
        "python cli.py todo --watch     # 파일을 고칠 때마다 자동 반영",
        "python worker.py               # 에이전트가 한 바퀴 돌 때마다 자동 갱신",
        "```",
        "",
    ]
    return "\n".join(lines)


def _comparable(text: str) -> str:
    """비교용으로 타임스탬프 줄을 뺀다.

    그 줄은 매번 달라지므로 넣고 비교하면 항상 '변경됨'이 된다.
    """
    return "\n".join(l for l in text.split("\n") if not l.startswith("자동 갱신:"))


def refresh(path: Path = TODO_PATH) -> tuple[int, int, bool]:
    """파일을 다시 그린다. (완료, 전체, 기록여부) 를 돌려준다.

    내용이 그대로면 쓰지 않는다. 워커가 주기마다 호출해도 mtime 이 흔들리지
    않아야 --watch 가 자기 쓰기를 변경으로 오인하지 않는다.

    테스트·측정 스크립트는 임시 DB(DB_PATH)를 쓴다. 그 상태로 할일.md 를 그리면
    '웹 요청 이력 없음' 같은 거짓 판정이 운영 목록에 들어가므로, 운영 DB 가
    아니면 기본 파일에는 쓰지 않는다.
    """
    if path == TODO_PATH and not config.SUPABASE_DB_URL and \
            Path(config.DB_PATH).resolve() != (ROOT / "festival.db").resolve():
        return 0, 0, False
    text = render(path)
    changed = True
    if path.exists():
        changed = _comparable(path.read_text(encoding="utf-8")) != _comparable(text)
    if changed:
        path.write_text(text, encoding="utf-8")

    m = re.search(r"진행 (\d+)/(\d+)", text)
    done, total = (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    return done, total, changed
