"""점검용 DB — 운영 festival.db 를 복사해 (읽기만) 시험 내용을 넣는다.

    python make_mobile_db.py <dst>                       모바일 점검: 긴 민원·URL·부서명 등 극단 입력
    python make_mobile_db.py <dst> --big [민원수] [카드수]  속도 점검(D5-37): 민원 1,000건 · 카드 30장 규모
"""
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
# ── 대량 데이터 모드 (D5-37): python make_mobile_db.py <dst> --big [민원수=1000] [카드수=30] ──────────
# 민원 N건 · 조치할 일 카드 M장을 더한다 (source='perf' — 합성 배지에 잡히지 않는 별도 값, 분류 완료 상태).
# 카드는 issue 표에 직접 넣는다. 모든 문장은 속도 측정용으로 지어낸 것이다 — 실제 민원이 아니다.
if "--big" in sys.argv:
    import random
    from datetime import datetime, timedelta
    k = sys.argv.index("--big")
    N = int(sys.argv[k + 1]) if len(sys.argv) > k + 1 else 1000
    M = int(sys.argv[k + 2]) if len(sys.argv) > k + 2 else 30
    d.row_factory = sqlite3.Row
    c = d.cursor()
    rnd = random.Random(37)
    fid = c.execute("SELECT id FROM festival LIMIT 1").fetchone()[0]
    zones = [(r["id"], r["name"]) for r in c.execute("SELECT id, name FROM zone ORDER BY id")]
    labels = [r[0] for r in c.execute("SELECT DISTINCT label FROM classification WHERE label IS NOT NULL")] or ["safety", "crowd", "parking", "restroom", "price", "guide"]
    anchor = c.execute("SELECT MAX(posted_at) FROM feedback").fetchone()[0]
    anchor = datetime.fromisoformat(anchor) if anchor else datetime.now().replace(microsecond=0)
    PHRASE = {
        "safety": "계단 조명이 꺼져 있어 발을 헛디딜 뻔했어요", "crowd": "입구에 사람이 한꺼번에 몰려 밀리고 있어요",
        "parking": "주차장이 가득 차서 빙빙 돌고 있어요", "restroom": "화장실 줄이 너무 길어요", "price": "음식 가격이 너무 비싸요",
        "guide": "길 안내 표지판이 없어서 헤맸어요",
    }
    for i in range(N):
        zid, _ = zones[rnd.randrange(len(zones))]
        lab = labels[rnd.randrange(len(labels))]
        at = (anchor - timedelta(seconds=rnd.randrange(0, 3600))).isoformat(timespec="seconds")
        text = f"{PHRASE.get(lab, '불편해요')} (측정용 {i})"
        cur = c.execute("INSERT INTO feedback (festival_id, zone_id, source, raw_text, posted_at, ingested_at, hash) VALUES (?,?,?,?,?,?,?)",
                        (fid, zid, "perf", text, at, at, f"perf-{i}"))
        c.execute("INSERT INTO classification (feedback_id, label, sentiment, is_safety, confidence, status, processed_at) VALUES (?,?,?,?,?,?,?)",
                  (cur.lastrowid, lab, -0.5, int(lab == "safety"), 0.9, "done", at))

    # 카드: 기존 카드를 그대로 두고 M장이 될 때까지 더한다
    have = c.execute("SELECT COUNT(*) FROM issue WHERE active=1").fetchone()[0]
    groups = ["main"] * 3 + ["more"] * 10 + ["in_progress"] * 7 + ["done"] * 10
    grades = ["immediate", "high", "mid", "low"]
    now = anchor.isoformat(timespec="seconds")
    for k in range(max(0, M - have)):
        lab = labels[k % len(labels)]
        zid, zname = zones[k % len(zones)]
        g = groups[k % len(groups)]
        quotes = [{"id": 100000 + k * 3 + j, "text": f"{PHRASE.get(lab, '불편해요')} (카드 {k}-{j})", "posted_at": now} for j in range(3)]
        actions = [{"text": f"{zname} 현장 점검과 안내 인력 배치 {j + 1}", "quote_id": quotes[0]["id"], "source": "template"} for j in range(3)]
        c.execute("""INSERT INTO issue (festival_id, issue_key, active, updated_at, label, zone_id, zone_name, rank_no, grp, grade, is_safety,
                     type_score, conc, rec, card_score, formula, freq, type_freq, last_at, same_zone_others, recurred, new_since_request,
                     action_status, department, contact, signature, latest_quotes, title, actions, evidence_quotes, needs_judgment,
                     text_source, text_updated_at, gen_signature, gen_max_id, gen_at, fail_count)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (fid, f"perf:{k}", 1, now, lab, zid, zname, have + k + 1, g, grades[k % 4], int(lab == "safety"),
                   60.0 - k, 0.5, 1.0, 50.0 - k, f"측정용 카드 {k}", 3, 10, now, 0, 0, 0,
                   {"in_progress": "in_progress", "done": "done"}.get(g), "측정용 부서", "055-000-0000", f"perf|{k}",
                   json.dumps(quotes, ensure_ascii=False), f"{zname} {PHRASE.get(lab, '불편')} (측정용 카드 {k})",
                   json.dumps(actions, ensure_ascii=False), json.dumps(quotes, ensure_ascii=False), 0,
                   "template", now, f"perf|{k}", 0, now, 0))
    d.commit()
    print("ok 민원", c.execute("SELECT COUNT(*) FROM feedback").fetchone()[0], "카드", c.execute("SELECT COUNT(*) FROM issue WHERE active=1").fetchone()[0])
    sys.exit(0)

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
