"""대량 데이터 점검용 DB (D5-37) — 운영 festival.db 를 복사하고 민원 N건 · 조치할 일 카드 M장을 더한다.

    python tests/ui/make_big_db.py <복사본 경로> [민원 수=1000] [카드 수=30]

운영 DB 는 읽기만 한다 (sqlite backup). 더한 민원은 source='perf' (합성 배지에 잡히지 않는 별도 값) · 분류 완료 상태.
카드는 issue 표에 직접 넣는다 (워커가 없는 복사본에서 화면이 카드 30장을 그리는 비용을 재기 위해).
모든 문장은 속도 측정용으로 지어낸 것이다 — 실제 민원이 아니다.
"""
import json
import os
import random
import sqlite3
import sys
from datetime import datetime, timedelta

SRC = os.environ.get("DB_PATH") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "festival.db")
DST = sys.argv[1]
N = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
M = int(sys.argv[3]) if len(sys.argv) > 3 else 30
assert os.path.abspath(SRC) != os.path.abspath(DST), "원본과 같은 경로에는 만들 수 없습니다"

s = sqlite3.connect(SRC); d = sqlite3.connect(DST); s.backup(d); s.close()
d.row_factory = sqlite3.Row
c = d.cursor()
try:
    c.execute("DELETE FROM admin_attempt")
except sqlite3.Error:
    pass

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
