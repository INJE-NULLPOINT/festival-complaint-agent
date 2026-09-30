"""화면 2 — 실시간 관제 대시보드.

핵심: **건수 순위와 심각도 순위를 나란히** 둔다.
조명 9건이 주차 52건을 제치고 올라가는 장면이 이 과제의 결론이다.

화면은 상태를 들고 있지 않는다. 전부 DB에서 다시 읽는다.
(자동 갱신이 반복돼도 깨지지 않는 이유)
"""
import pandas as pd
import streamlit as st

from core import config, db, llm, replay, review, ui

st.set_page_config(page_title="관제", page_icon="📊", layout="wide")

db.init_db()
replay.ensure()

GRADE_ICON = {"immediate": "🔴", "high": "🟠", "mid": "🟡", "low": "🟢"}

st.title("📊 실시간 관제")
window = st.sidebar.slider("심각도 윈도우(분)", 15, 1440, config.DEFAULT_WINDOW_MIN, step=15)
st.sidebar.caption("자동 갱신 5초")

if llm.is_local():
    st.sidebar.warning(
        "백엔드 **local**\n\n규칙 기반 대역으로 동작 중입니다. 제출본이 아닙니다."
    )
elif llm.is_cli():
    st.sidebar.info(
        f"백엔드 **claude_code**\n\n{config.MODEL} · Claude Code CLI 경유 (개발용 실제 모델)"
    )
else:
    st.sidebar.success(f"백엔드 **anthropic**\n\n{config.MODEL}")

_p = replay.progress()
if _p and _p["active"]:
    st.sidebar.divider()
    st.sidebar.markdown(f"⏯ **리플레이 {_p['speed']:.0f}배속**")
    st.sidebar.progress(min(_p["cursor"] / max(_p["total"], 1), 1.0),
                        text=f"{_p['cursor']}/{_p['total']} · {_p['sim_now']}")


@st.fragment(run_every="5s")
def board() -> None:
    # 건수 순위와 심각도 순위는 같은 창(사이드바)을 본다 — 다른 모집단 비교 금지
    total = db.label_counts()
    counts = db.label_counts(window)
    rows = db.window_rows(window)
    ranked = db.ranked(window)

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("누적 접수", sum(total.values()) + db.pending_count())
    c2.metric(f"최근 {window}분", len(rows))
    c3.metric("분류 대기", db.pending_count())
    if db.review_count():
        _rs = db.review_safety_count()
        st.caption(f"확인 필요 {db.review_count()}건"
                   + (f" (안전 의심 {_rs}건 — 먼저 확인)" if _rs else "")
                   + " — 신뢰도가 낮거나 내용이 없어 유형을 정하지 않았습니다. 순위·알림에는 들어가지 않습니다.")
    c4.metric("최고 등급", GRADE_ICON.get(ranked[0]["grade"], "—") + " " + ranked[0]["grade"] if ranked else "—")

    # ── ④통합 에이전트 브리핑 ──────────────────────────────────
    with db.connect() as conn:
        brief = conn.execute(
            "SELECT * FROM briefing ORDER BY id DESC LIMIT 1"
        ).fetchone()
        alerts = conn.execute(
            "SELECT * FROM alert WHERE acked=0 ORDER BY id DESC LIMIT 5"
        ).fetchall()

    if brief:
        st.info(f"🤖 **통합 에이전트 브리핑** · {brief['created_at']}\n\n{brief['text']}")
        if brief["rationale"]:
            st.caption(f"판단 근거: {brief['rationale']}")
    else:
        st.caption("🤖 통합 에이전트 브리핑 — 워커가 Agent Path를 돌리면 표시됩니다.")

    # ── 알림 (②감시 에이전트가 올린 것) ────────────────────────
    KIND = {"spike": "급증", "safety_threshold": "안전 임계",
            "grade_up": "등급 상승", "review_safety_stale": "확인 필요 방치"}
    for a in alerts:
        st.warning(
            f"🚨 **{KIND.get(a['kind'], a['kind'])}** · "
            f"{config.LABELS.get(a['label'], a['label'])} · {a['created_at'][11:19]}\n\n"
            f"{a['detail']}"
        )

    # ── 관제 '지금 조치할 일' 카드 (D5-29) — 웹 관제와 같은 issue 표 ─────────────
    ui.render_cards()
    st.divider()

    left, right = st.columns([3, 2])

    with left:
        a, b = st.columns(2)
        with a:
            st.subheader(f"건수 순위 (최근 {window}분)")
            if counts:
                st.dataframe(
                    pd.DataFrame(
                        [{"유형": config.LABELS.get(k, k), "건수": v} for k, v in counts.items()]
                    ),
                    hide_index=True, use_container_width=True,
                )
            else:
                st.caption("아직 분류된 민원이 없습니다.")

        with b:
            st.subheader("심각도 순위")
            if ranked:
                st.dataframe(
                    pd.DataFrame([{
                        "": GRADE_ICON.get(r["grade"], ""),
                        "유형": config.LABELS.get(r["label"], r["label"]),
                        "점수": r["score"],
                        "건수": r["freq"],
                    } for r in ranked]),
                    hide_index=True, use_container_width=True,
                )
            else:
                st.caption("계산할 데이터가 없습니다.")

        # ★ 판정 근거 — LLM이 지어낸 점수가 아님을 보여주는 자리
        if ranked:
            st.subheader("판정 근거")
            for r in ranked[:3]:
                with st.expander(
                    f"{GRADE_ICON.get(r['grade'],'')} {config.LABELS.get(r['label'], r['label'])} · {r['score']}점"
                ):
                    st.code(r["formula"], language="text")
                    if r["spike"]["spiked"]:
                        st.warning(
                            f"급증 감지 — 최근 {config.SPIKE_WINDOW_MIN}분 유입률 "
                            f"{r['spike']['rate']}/분, 기준 {r['spike']['baseline']}/분 "
                            f"({r['spike']['multiplier']}배)"
                        )

    with right:
        if db.review_count():
            with st.expander(f"확인 필요 {db.review_count()}건 — 처리는 '조치' 화면(운영자 코드)에서"):
                for it in review.items(10):
                    st.caption(("🚨 " if it["is_safety"] else "") + f"#{it['id']} {it['zone']} · {it['raw_text'][:80]}")
        st.subheader("실시간 유입")
        for f in db.recent_feedback(8):
            label = ("확인 필요" if f["status"] == "review"
                     else "유형 없음" if f["status"] == "dismissed"
                     else config.LABELS.get(f["label"], "분류중…") if f["label"] else "분류중…")
            st.markdown(
                f"`{(f['ingested_at'] or '')[11:19]}` **{label}** · {f['zone'] or config.ZONE_UNKNOWN}  \n"
                f"<span style='color:gray;font-size:0.85em'>{f['raw_text'][:60]}</span>",
                unsafe_allow_html=True,
            )

        st.subheader("⚡ 에이전트 활동 로그")
        logs = db.recent_logs(12)
        if logs:
            for g in logs:
                st.text(f"{g['created_at'][11:19]} {g['agent']:<10} {g['action']}")
        else:
            st.caption("아직 활동이 없습니다. `python worker.py` 를 실행하세요.")


board()
