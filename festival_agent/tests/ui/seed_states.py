"""테스트 DB 에만: 화면의 '상태' 장면을 만든다 (빈 화면 점검 D5-39).
  python tests/ui/seed_states.py <db> no-main    카드는 있는데 본 목록(main)이 없다 → '지금 바로 조치할 일은 없습니다'
  python tests/ui/seed_states.py <db> clear      카드를 모두 지운다 (장면이 끝나면 되돌려 다음 실행이 진짜 빈 상태에서 시작하게)
운영 DB 에는 쓰지 말 것. 카드 두 장(조치 중 · 조치 완료)만 넣는다."""
import datetime
import json
import sqlite3
import sys

db, mode = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)
fid = c.execute("SELECT id FROM festival LIMIT 1").fetchone()[0]
now = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

COLS = ["festival_id", "issue_key", "active", "updated_at", "label", "zone_id", "zone_name", "rank_no", "grp", "grade", "is_safety",
        "type_score", "conc", "rec", "card_score", "formula", "freq", "type_freq", "last_at", "same_zone_others", "recurred",
        "action_status", "action_request_id", "department", "contact", "signature", "latest_quotes", "title", "actions",
        "evidence_quotes", "needs_judgment", "text_source", "text_updated_at", "gen_signature", "gen_max_id", "gen_at", "fail_count"]


def row(no, grp, key, label, zone, grade, status, title):
    q = [{"id": 0, "text": "예시 민원", "posted_at": now}]
    return [fid, key, 1, now, label, None, zone, no, grp, grade, 0, 50.0, 1.0, 1.0, 50.0, "예시", 1, 1, now, 0, 0, status, None,
            "안전총괄과", "055-000-0005", f"{key}|{grade}|{status}", json.dumps(q, ensure_ascii=False), title,
            json.dumps([{"text": "현장 확인", "quote_id": 0, "source": "llm"}, {"text": "안내 표지 보강", "quote_id": 0, "source": "llm"}], ensure_ascii=False),
            json.dumps(q, ensure_ascii=False), 0, "llm", now, "", 0, now, 0]


if mode == "no-main":
    c.execute("DELETE FROM issue")
    for r in (row(1, "in_progress", "guide:1", "guide", "남강 수상무대", "mid", "in_progress", "수상무대 가는 길 표지판이 부족함"),
              row(2, "done", "restroom:1", "restroom", "진주교 남단 주차장", "low", "done", "화장실 대기 줄이 길고 위생이 나쁨")):
        c.execute(f"INSERT INTO issue ({','.join(COLS)}) VALUES ({','.join('?' * len(COLS))})", r)
elif mode == "clear":
    c.execute("DELETE FROM issue")
else:
    raise SystemExit(f"모르는 모드: {mode}")
c.commit()
print("ok", mode)
