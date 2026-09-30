"""홈 — 실행 상태 확인용.

실행:
    streamlit run app.py          (화면)
    python worker.py              (분류 워커, 별도 터미널)
"""
import streamlit as st

from core import config, db

st.set_page_config(page_title="축제 민원 관제", page_icon="🏮", layout="wide")

db.init_db()

st.title("🏮 실시간 축제 민원 관제 에이전트")
st.caption(f"{config.FESTIVAL['name']} · {config.FESTIVAL['region']}")

st.markdown("""
왼쪽 사이드바에서 화면을 고르세요.

| 화면 | 용도 |
|---|---|
| **접수** | 방문객이 QR로 접속하는 민원 접수 폼 |
| **관제** | 실시간 대시보드 — 건수 순위 / 심각도 순위 / 에이전트 활동 로그 |
| **조치** | 부서별 조치요청서와 처리 상태 |
""")

c1, c2, c3 = st.columns(3)
counts = db.label_counts()
c1.metric("누적 접수", sum(counts.values()) + db.pending_count())
c2.metric("분류 완료", sum(counts.values()))
c3.metric("분류 대기", db.pending_count())

if db.pending_count() > 0:
    st.warning("분류 대기가 쌓여 있습니다. 별도 터미널에서 `python worker.py` 를 실행하세요.")

with st.expander("개발 진행 상황 (D1 기준)"):
    st.markdown("""
- ✅ **D1** 화면 3종 골격 · SQLite(WAL) 스키마 · **①분류 에이전트 루프 동작**
- ⬜ **D2** 접수 파이프라인 정리 · `agent_task` 큐
- ⬜ **D3** ②감시 에이전트 (`compute_severity` / `detect_spike` 는 구현 완료)
- ⬜ **D4** 실시간 대시보드 자동 갱신 · 알림
- ⬜ **D5** ③조치 에이전트 + DOCX · ④통합 에이전트 브리핑 · 리플레이 엔진
- ⬜ **D6** E2E 연결 (마지노선)
""")
