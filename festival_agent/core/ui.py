"""Streamlit 화면이 같이 쓰는 조각 (D5-35) — 운영자 코드 창, '지금 조치할 일' 카드, 확인 필요·지운 민원 패널.

웹(관제·조치)과 같은 데이터(issue 표·review·db.list_deleted)를 같은 규칙으로 보여 준다. 운영자 동작은 webapi 와
같은 모듈(core/admin.verify · core/review · db.set_feedback_deleted)을 부르므로 이 화면이 우회로가 되지 않는다.
세션 상태 키: admin_ok (페이지가 달라도 같은 브라우저 세션이면 유지).
"""
import json

import streamlit as st

from . import admin, config, db, issues, review

GRADE_ICON = {"immediate": "🔴", "high": "🟠", "mid": "🟡", "low": "🟢"}
GRADE_NAME = {"immediate": "즉시", "high": "높음", "mid": "보통", "low": "낮음"}
ACTION_NAME = {"none": "미요청", "requested": "요청", "in_progress": "조치중", "done": "완료", "superseded": "대체됨"}


def gate() -> bool:
    """운영자 코드를 확인한 세션이면 True. 지우기·확인 필요 처리·조치 상태 변경·요청서 생성·리플레이는 이때만 된다 (D5-31)."""
    if not config.ADMIN_CODE:
        st.sidebar.warning("운영자 코드가 설정되지 않았습니다 (.env 의 ADMIN_CODE).\n\n"
                           "지우기·확인 필요 처리·조치 상태 변경·요청서 생성·리플레이는 잠겨 있습니다.")
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
    st.sidebar.caption("지우기·확인 필요 처리·조치 상태 변경·요청서 생성·리플레이는 운영자 코드가 필요합니다.")
    return False


def _loads(s, default):
    try:
        v = json.loads(s or "")
        return v if isinstance(v, type(default)) else default
    except (ValueError, TypeError):
        return default


def _card(c: dict, big: bool = False) -> None:
    icon = GRADE_ICON.get(c["grade"], "")
    where = c["zone_name"] or config.ZONE_UNKNOWN
    head = (f"{icon} **{config.LABELS.get(c['label'], c['label'])} · {where}** — "
            f"{GRADE_NAME.get(c['grade'], c['grade'])} · {c['freq']}건 · 카드 점수 {c['card_score']}"
            + (" · ⚠ 안전 의심" if c["is_safety"] else ""))
    st.markdown(("#### " if big else "") + head)
    if c.get("title"):
        st.markdown(f"**{c['title']}**" + ("" if c.get("text_source") != "template" else "  \n<small>(자동 요약 대기 — 기본 문구)</small>"),
                    unsafe_allow_html=True)
    if c.get("needs_judgment"):
        st.warning("⚠ 운영자 판단 필요 — 중단·대피처럼 영향이 큰 조치가 포함돼 있습니다. AI 제안을 그대로 따르지 마세요.")
    acts = _loads(c.get("actions"), [])
    if acts:
        st.markdown("**해야 할 일**")
        for a in acts:
            st.markdown(f"- {a.get('text', '')}")
    meta = [f"담당 {c['department']} ({c['contact']})" if c.get("department") else "",
            f"조치 {ACTION_NAME.get(c.get('action_status') or 'none', c.get('action_status'))}",
            "요청서 이후 새 민원" if c.get("new_since_request") else "",
            f"마지막 민원 {(c.get('last_at') or '')[11:16]}" if c.get("last_at") else ""]
    st.caption(" · ".join(m for m in meta if m))
    with st.expander("판단 근거 · 최신 민원"):
        st.code(c.get("formula") or "", language="text")
        ev = _loads(c.get("evidence_quotes"), [])
        if ev:
            st.markdown("**근거로 인용한 민원**")
            for q in ev:
                st.caption(f"#{q.get('id')} {q.get('text', '')[:120]}")
        for q in _loads(c.get("latest_quotes"), []):
            st.caption(f"최신 · #{q.get('id')} {q.get('text', '')[:120]}")


def render_cards() -> None:
    """관제의 '지금 조치할 일' — 1위는 크게, 나머지는 줄, 조치 중·완료는 접는다."""
    cards = issues.list_active()
    st.subheader("지금 조치할 일")
    if not cards:
        st.caption("조치할 카드가 없습니다. 민원이 분류되면 여기에 '문제·위치·우선순위·해야 할 일'이 나옵니다.")
        return
    groups = {g: [c for c in cards if c["grp"] == g] for g in ("main", "more", "in_progress", "done")}
    judged = [c for c in groups["main"] + groups["more"] if c.get("needs_judgment")]
    if judged:
        st.warning(f"⚠ 운영자 판단이 필요한 조치 {len(judged)}건 — 카드의 경고를 먼저 확인하세요.")
    main = groups["main"]
    if main:
        _card(main[0], big=True)
        for c in main[1:]:
            st.divider()
            _card(c)
    else:
        st.caption("지금 새로 조치할 카드는 없습니다.")
    for g, title in (("more", "그 밖의 카드"), ("in_progress", "조치 중"), ("done", "조치 완료")):
        if groups[g]:
            with st.expander(f"{title} ({len(groups[g])})"):
                for c in groups[g]:
                    _card(c)
                    st.divider()


def review_panel(admin_ok: bool, key: str = "rv") -> None:
    """확인 필요 목록 (안전 의심 먼저·오래된 것 먼저). 운영자 모드면 유형 지정 · 유형 없음으로 닫기 · 지우기."""
    items = review.items(20)
    st.subheader(f"확인 필요 {db.review_count()}건" + (f" (안전 의심 {db.review_safety_count()}건 — 먼저)" if db.review_safety_count() else ""))
    st.caption("신뢰도가 낮거나 내용이 없어 유형을 정하지 않은 민원입니다. 순위·카드·알림에는 들어가지 않습니다.")
    if not items:
        st.caption("지금 확인할 민원이 없습니다.")
        return
    for it in items:
        safe = "🚨 " if it["is_safety"] else ""
        st.markdown(f"{safe}**#{it['id']}** · {it['zone']} · {(it['ingested_at'] or '')[11:16]}  \n{it['raw_text'][:160]}")
        sug = config.LABELS.get(it["suggested_label"], "없음") if it["suggested_label"] else "없음"
        st.caption(f"모델 제안: {sug}" + (f" · 신뢰도 {it['confidence']}" if it["confidence"] is not None else ""))
        if not admin_ok:
            continue
        c1, c2, c3, c4 = st.columns([2, 1, 1, 1])
        opts = list(config.LABELS)
        idx = opts.index(it["suggested_label"]) if it["suggested_label"] in opts else 0
        label = c1.selectbox("유형", opts, index=idx, key=f"{key}_l{it['id']}", label_visibility="collapsed",
                             format_func=lambda k: config.LABELS[k])
        if c2.button("유형 지정", key=f"{key}_r{it['id']}", type="primary"):
            _act(lambda: review.resolve(it["id"], label), "유형을 지정했습니다")
        if c3.button("유형 없음", key=f"{key}_d{it['id']}"):
            _act(lambda: review.dismiss(it["id"]), "유형 없음으로 닫았습니다")
        if c4.button("지우기", key=f"{key}_x{it['id']}"):
            _act(lambda: db.set_feedback_deleted(it["id"], True), "지웠습니다 (아래 '지운 민원'에서 되돌릴 수 있습니다)")
        st.divider()


def _act(fn, done_msg: str) -> None:
    try:
        fn()
    except (KeyError, ValueError) as e:                       # 이미 처리됨 · 없는 민원
        st.session_state["flash"] = ("error", str(e.args[0] if e.args else e))
    else:
        st.session_state["flash"] = ("success", done_msg)
    st.rerun()


def flash() -> None:
    kind, msg = st.session_state.pop("flash", (None, None))
    if kind:
        (st.error if kind == "error" else st.success)(msg)


def deleted_panel(admin_ok: bool) -> None:
    """지운 민원 (최근 50건) — 운영자가 되돌린다."""
    rows = db.list_deleted(50)
    with st.expander(f"지운 민원 ({db.deleted_count()})"):
        if not rows:
            st.caption("지운 민원이 없습니다.")
        for r in rows:
            c1, c2 = st.columns([5, 1])
            c1.markdown(f"**#{r['id']}** · {r['zone']} · 지운 시각 {(r['deleted_at'] or '')[11:16]}  \n{r['raw_text'][:120]}")
            if admin_ok and c2.button("되돌리기", key=f"rs_{r['id']}"):
                _act(lambda rid=r["id"]: db.set_feedback_deleted(rid, False), "되돌렸습니다")
        if rows and not admin_ok:
            st.caption("되돌리려면 운영자 코드가 필요합니다.")


def recent_delete_panel(admin_ok: bool, limit: int = 8) -> None:
    """최근 유입 중 지울 민원 고르기 (장난·개인정보 노출). 운영자 모드에서만 버튼이 보인다."""
    if not admin_ok:
        return
    with st.expander("민원 지우기 (최근 유입)"):
        for f in db.recent_feedback(limit):
            c1, c2 = st.columns([5, 1])
            c1.markdown(f"**#{f['id']}** · {f['zone']}  \n{f['raw_text'][:100]}")
            if c2.button("지우기", key=f"del_{f['id']}"):
                _act(lambda fid=f["id"]: db.set_feedback_deleted(fid, True), "지웠습니다")
