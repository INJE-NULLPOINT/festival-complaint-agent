"""화면 1 — 방문객 QR 접수 폼 (모바일).

구역별 QR이 이 화면의 `?zone=` 파라미터를 달고 들어온다.
이름·연락처를 받지 않는다. 구역과 민원 내용만 저장한다.
"""
import streamlit as st

from core import config, db, privacy

st.set_page_config(page_title="불편신고", page_icon="📝")

db.init_db()
zones = db.zones()
zone_names = [z["name"] for z in zones]

# QR에 박아 둘 구역 파라미터 (예: /1_접수?zone=유등터널)
preset = st.query_params.get("zone")
default_idx = zone_names.index(preset) if preset in zone_names else 0

st.title(f"🏮 {config.FESTIVAL['name']}")
st.subheader("불편신고")

with st.form("report", clear_on_submit=True):
    zone_name = st.selectbox("어디신가요?", zone_names, index=default_idx)
    text = st.text_area(
        "무엇이 불편하셨나요?",
        placeholder="예) 진입로에 불이 하나도 없어서 어두워서 넘어졌어요",
        height=120,
    )
    submitted = st.form_submit_button("제출하기", use_container_width=True, type="primary")

if submitted:
    if not privacy.has_content(text):
        st.error(privacy.NEED_MORE)
    else:
        zone_id = next(z["id"] for z in zones if z["name"] == zone_name)
        fid = db.insert_feedback(zone_id, text, source="qr")
        if fid is None:
            st.info("이미 접수된 내용입니다.")
        else:
            st.success("접수되었습니다. 감사합니다.")
            st.caption(f"접수번호 {fid} · 잠시 후 관제 화면에 반영됩니다.")

st.divider()
st.caption("이름과 연락처를 받지 않습니다. 구역 정보와 민원 내용만 저장됩니다.")

with st.expander("시연용 예시 문장"):
    st.code(
        "진입로에 불이 하나도 없어서 어두워서 넘어졌어요\n"
        "주차장에서 나가는 데 한 시간 걸렸습니다\n"
        "화장실이 너무 부족하고 줄이 깁니다\n"
        "어묵 한 그릇에 만원은 너무합니다\n"
        "등이 정말 예뻤어요 내년에 또 올게요",
        language="text",
    )
