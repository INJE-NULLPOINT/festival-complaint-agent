"""모바일 점검용 DB — 운영 festival.db 를 복사하고 극단적인 내용을 넣는다. 운영 DB 는 읽기만 한다."""
import json, os, sqlite3, sys

# 원본은 DB_PATH 환경변수, 없으면 festival_agent/festival.db. 원본은 읽기만 한다 (sqlite backup).
SRC = os.environ.get("DB_PATH") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "festival.db")
DST = sys.argv[1]
assert os.path.abspath(SRC) != os.path.abspath(DST), "원본과 같은 경로에는 만들 수 없습니다"
s = sqlite3.connect(SRC); d = sqlite3.connect(DST); s.backup(d); s.close()
c = d.cursor()
# 운영 DB 의 틀린 운영자 코드 시도 기록(admin_attempt)을 지운다 — 복사본이 '이미 잠긴 채' 시작하면 (최근 10분에 5번 틀림)
# 점검이 모두 '시도가 너무 많습니다' 로 깨진다. 복사본에만 적용된다.
try:
    c.execute("DELETE FROM admin_attempt")
except sqlite3.Error:
    pass   # 예전 스키마
now = "2026-09-29T23:10:00"
fid = c.execute("SELECT id FROM festival LIMIT 1").fetchone()[0]

LONG_WORD = "진주남강유등축제" * 12                      # 띄어쓰기 없는 긴 단어
URL = "https://www.example.com/festival/2026/jinju/namgang-yudeung/complaints?ref=qr&zone=%EC%9C%A0%EB%93%B1%ED%84%B0%EB%84%90"
TEXT500 = ("유등터널 입구에서 사람들이 한꺼번에 몰려서 밀리고 넘어질 뻔했습니다. " * 20)[:480] + " " + URL
for text, label in [(TEXT500, "crowd"), (LONG_WORD, "guide"), (URL, "guide")]:
    cur = c.execute("INSERT INTO feedback (festival_id, zone_id, source, raw_text, posted_at, ingested_at, hash) "
                    "VALUES (?,?,?,?,?,?,?)", (fid, 4, "qr", text, now, now, f"mob-{hash(text)}"))
    c.execute("INSERT INTO classification (feedback_id, label, sentiment, is_safety, confidence, status, processed_at) "
              "VALUES (?,?,?,?,?,?,?)", (cur.lastrowid, label, -0.7, 0, 0.9, "done", now))

DEPT = "진주시 문화관광체육국 축제운영지원단 현장안전관리팀 (055-000-0000 · 내선 12345)"
doc = {
    "festival": "제76회 개천예술제 · 2026 진주남강유등축제", "department": DEPT, "created_at": "2026-09-29 23:10",
    "festival_info": "2026.10.01 ~ 2026.10.15 · 경상남도 진주시 남강로 일원 · " + URL,
    "label": "crowd", "label_ko": "혼잡", "count": 12, "score": 100.0, "grade": "immediate", "grade_ko": "즉시",
    "formula": "(0.500000×60 + 0.833333×40) × 안전2.0 × 급증1.5 × 미조치1.2 = 100.0 (상한) · " + LONG_WORD[:40],
    "quotes": [{"raw_text": TEXT500, "zone": "소망등 달기 구역 (남강 둔치 동쪽 끝 임시 무대 뒤편)", "time": "23:09"},
               {"raw_text": LONG_WORD, "zone": "유등터널", "time": "23:08"},
               {"raw_text": URL, "zone": "유등터널", "time": "23:07"}],
    "suggestions": ["유등터널 입구에 안전요원 4명을 추가 배치하고 한 방향 통행으로 유도한다 · " + LONG_WORD[:30],
                    "혼잡 안내 방송을 5분 간격으로 한다", URL],
}
# DOCX 버튼 주소: output/ 에 실제 있는 파일을 가리킨다. 가짜 주소를 넣으면 DOCX 내려받기 점검이
# 404 를 '화면 문제' 로 오해한다. (파일이 하나도 없으면 주소를 비운다 = DOCX 버튼 없음)
import urllib.parse
out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "output")
docx = sorted(f for f in os.listdir(out_dir) if f.endswith(".docx")) if os.path.isdir(out_dir) else []
doc_url = "/api/docs/" + urllib.parse.quote(docx[0]) if docx else None
c.execute("INSERT INTO action_request (festival_id, label, department, count, doc_path, status, created_at, doc_url, doc_json) "
          "VALUES (?,?,?,?,?,?,?,?,?)",
          (fid, "crowd", DEPT, 12, "", "requested", now, doc_url,
           json.dumps(doc, ensure_ascii=False)))
# 관제 카드: 서버는 issue 표에 '저장된' 카드를 그대로 준다. 워커가 없는 복사본에서는 이 표가 복사한 그 순간으로 굳는다.
# 운영 상태에 따라 '지금 조치할 일(main)' 카드가 하나도 없을 수 있어(전부 조치 중·완료), 그러면 1위 카드 점검이
# 통째로 빠진다 → 복사본에서만 1위 카드를 main 으로 돌려 놓는다 (운영 DB 는 건드리지 않는다).
try:
    top = c.execute("SELECT id FROM issue WHERE active=1 ORDER BY rank_no LIMIT 1").fetchone()
    has_main = c.execute("SELECT COUNT(*) FROM issue WHERE active=1 AND grp='main'").fetchone()[0]
    if top and not has_main:
        c.execute("UPDATE issue SET grp='main' WHERE id=?", (top[0],))
except sqlite3.Error:
    pass   # issue 표가 없는 예전 스키마
c.execute("INSERT INTO alert (festival_id, label, kind, detail, created_at, acked) VALUES (?,?,?,?,?,0)",
          (fid, "crowd", "immediate", "[혼잡] " + TEXT500, now))
c.execute("INSERT INTO briefing (festival_id, top_label, text, rationale, created_at) VALUES (?,?,?,?,?)",
          (fid, "crowd", "지금 최우선은 유등터널 혼잡 대응입니다. " + LONG_WORD + " " + URL + " 안전요원을 바로 보내 주세요.",
           "근거: " + URL, now))
d.commit()
print("ok", c.execute("SELECT COUNT(*) FROM feedback").fetchone()[0])
