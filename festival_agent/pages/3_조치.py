"""화면 3 — 부서별 조치요청서 · 처리 상태 · 리플레이 제어.

상태(status)는 장식이 아니다. 미조치 30분 경과가 S-06 가중으로 심각도
계산에 되먹임되고, ④통합 에이전트의 우선순위 조정에도 쓰인다.
"""
from pathlib import Path

import streamlit as st

from core import admin, config, db, replay

st.set_page_config(page_title="조치", page_icon="📄", layout="wide")

db.init_db()
replay.ensure()

STATUS = {"requested": "요청", "in_progress": "조치중", "done": "완료"}
GRADE_ICON = {"immediate": "🔴", "high": "🟠", "mid": "🟡", "low": "🟢"}

st.title("📄 부서별 조치요청서")


def gate() -> bool:
    """운영자 코드를 확인한 세션이면 True. 조치 상태 변경·요청서 생성·리플레이 조작은 이때만 된다 (D5-31).

    webapi 와 같은 규칙(core/admin.verify)이라 이 화면이 우회로가 되지 않는다.
    코드가 설정돼 있지 않으면(ADMIN_CODE 비어 있음) 이 동작들은 전부 잠긴다. 조회·DOCX 내려받기는 그대로다.
    """
    if not config.ADMIN_CODE:
        st.sidebar.warning("운영자 코드가 설정되지 않았습니다 (.env 의 ADMIN_CODE).\n\n"
                           "조치 상태 변경·요청서 생성·리플레이는 잠겨 있습니다.")
        return False
    if st.session_state.get("admin_ok"):
        if st.sidebar.button("운영자 잠금"):
            st.session_state["admin_ok"] = False
            st.rerun()
        st.sidebar.success("운영자 모드")
        return True
    code = st.sidebar.text_input("운영자 코드", type="password", key="admin_code_input")
    if st.sidebar.button("확인"):
        try:
            admin.verify(code)
        except admin.AdminError as e:
            st.sidebar.error(str(e))
        else:
            st.session_state["admin_ok"] = True
            st.rerun()
    st.sidebar.caption("조치 상태 변경·요청서 생성·리플레이는 운영자 코드가 필요합니다.")
    return False


admin_ok = gate()

ranked = db.ranked()

# ── 조치 대상 ─────────────────────────────────────────────────────
st.subheader("조치 대상")
if not ranked:
    st.caption("분류된 민원이 없습니다.")

with db.connect() as conn:
    has_action = {
        r["label"] for r in conn.execute(
            f"SELECT DISTINCT label FROM action_request WHERE {db.OPEN_ACTION_SQL}"
        ).fetchall()
    }

jobs = db.doc_job_states()

for r in ranked[:5]:
    dept, contact = config.DEPARTMENT_MAP.get(r["label"], ("미지정", "-"))
    c1, c2 = st.columns([4, 1])
    c1.markdown(
        f"{GRADE_ICON.get(r['grade'],'')} **{config.LABELS.get(r['label'], r['label'])}** "
        f"· {r['freq']}건 · 심각도 {r['score']} → **{dept}** ({contact})"
    )
    c1.caption(r["formula"])

    # 작성은 워커의 doc_jobs 스레드가 한다 (웹과 같은 큐). 여기서 직접 부르면
    # 워커의 ③조치와 락을 공유하지 못해 같은 유형 문서가 겹칠 수 있다.
    job = jobs.get(r["label"])
    if job and job["status"] in ("queued", "running"):
        c2.caption("작성 중…" if job["status"] == "running" else "대기 중 (worker 필요)")
    elif r["label"] in has_action:
        c2.caption("요청서 있음")
    elif not admin_ok:
        c2.caption("운영자 코드 필요")
    elif c2.button("요청서 생성", key=f"gen_{r['label']}", type="primary"):
        db.request_doc_job(r["label"])
        st.rerun()
    if job and job["status"] == "failed":
        c1.caption(f"⚠ 직전 생성 실패: {job['error'] or ''}")

st.divider()

# ── 처리 현황 ─────────────────────────────────────────────────────
st.subheader("처리 현황")

actions = db.open_actions()
if not actions:
    st.caption("생성된 조치요청서가 없습니다.")

for a in actions:
    c1, c2, c3 = st.columns([3, 2, 1])
    c1.markdown(
        f"**{a['department']}** — {config.LABELS.get(a['label'], a['label'])} "
        f"({a['count']}건)"
    )
    c1.caption(a["created_at"])

    current = list(STATUS).index(a["status"]) if a["status"] in STATUS else 0
    if not admin_ok:
        c2.markdown(f"상태: **{STATUS.get(a['status'], a['status'])}**")
        new = a["status"]
    else:
        new = c2.radio(
            "상태", list(STATUS), index=current, key=f"st_{a['id']}",
            format_func=lambda s: STATUS[s], horizontal=True, label_visibility="collapsed",
        )
    if new != a["status"]:
        with db.connect() as conn:
            conn.execute(
                "UPDATE action_request SET status=?, closed_at=? WHERE id=?",
                (new, db.now() if new == "done" else None, a["id"]),
            )
            conn.commit()
        st.rerun()

    path = Path(a["doc_path"]) if a["doc_path"] else None
    if path and path.exists():
        c3.download_button(
            "DOCX", path.read_bytes(), file_name=path.name,
            key=f"dl_{a['id']}", use_container_width=True,
        )
    else:
        c3.caption("파일 없음")

st.caption(
    f"미조치 {config.PENDING_MINUTES}분 경과 시 심각도 ×{config.W_PENDING} 가중 (S-06). "
    "조치 상태가 다음 판정과 ④통합 에이전트의 우선순위에 되먹임됩니다."
)

st.divider()

# ── 리플레이 ──────────────────────────────────────────────────────
st.subheader("⏯ 리플레이")
st.caption(
    "과거 민원을 타임스탬프 순서대로 배속 재생합니다. "
    "실시간 시스템을 3분 영상에 담기 위한 기능이자, 개발 중 검증 수단입니다."
)

prog = replay.progress()
seed_dir = Path(__file__).resolve().parent.parent / "seed"
seeds = sorted(p.name for p in seed_dir.glob("*.csv")) if seed_dir.exists() else []

c1, c2, c3 = st.columns([2, 1, 1])
if not seeds:
    c1.warning("seed/*.csv 가 없습니다. `python scripts/make_dev_seed.py` 를 먼저 실행하세요.")
else:
    chosen = c1.selectbox("시드 파일", seeds)
    speed = c2.selectbox("속도", [10, 30, 60, 120, 300], index=2,
                         format_func=lambda x: f"{x}배속")

    if not admin_ok:
        c3.caption("운영자 코드 필요")
    elif prog and prog["active"]:
        c3.button("■ 정지", use_container_width=True,
                  on_click=replay.stop, key="stop")
    elif c3.button("▶ 시작", use_container_width=True, type="primary"):
        info = replay.start(seed_dir / chosen, speed=float(speed))
        st.success(f"재생 시작 — {info['total']}건, {info['speed']}배속")
        st.rerun()

if prog and prog["total"]:
    st.progress(min(prog["cursor"] / prog["total"], 1.0),
                text=f"{prog['cursor']}/{prog['total']}건 · "
                     f"{'재생 중 · 시뮬레이션 ' + prog['sim_now'] if prog['active'] else '정지'}")

if "dev_sample.csv" in seeds:
    st.caption(
        "⚠ `dev_sample.csv` 는 **개발용 합성 데이터**입니다. "
        "제출용 시드는 공개 리뷰를 직접 수집·정제한 것으로 교체하세요."
    )
