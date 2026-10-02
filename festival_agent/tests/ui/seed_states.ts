// 테스트 DB 에만: 화면의 '상태' 장면을 만든다 (빈 화면 점검 D5-39).
//   node tests/ui/seed_states.ts <db> no-main    카드는 있는데 본 목록(main)이 없다 → '지금 바로 조치할 일은 없습니다'
//   node tests/ui/seed_states.ts <db> clear      카드를 모두 지운다 (장면이 끝나면 되돌려 다음 실행이 진짜 빈 상태에서 시작하게)
// 운영 DB 에는 쓰지 말 것. 카드 두 장(조치 중 · 조치 완료)만 넣는다.
import { DatabaseSync } from "node:sqlite";

const [db, mode] = process.argv.slice(2);
if (!db || !mode) {
  console.error("사용: node tests/ui/seed_states.ts <db> <no-main|clear>");
  process.exit(2);
}
const c = new DatabaseSync(db);
const fid = (c.prepare("SELECT id FROM festival LIMIT 1").get() as { id: number }).id;
const p2 = (n: number): string => String(n).padStart(2, "0");
const d = new Date();
const now = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

const COLS = ["festival_id", "issue_key", "active", "updated_at", "label", "zone_id", "zone_name", "rank_no", "grp", "grade", "is_safety",
  "type_score", "conc", "rec", "card_score", "formula", "freq", "type_freq", "last_at", "same_zone_others", "recurred",
  "action_status", "action_request_id", "department", "contact", "signature", "latest_quotes", "title", "actions",
  "evidence_quotes", "needs_judgment", "text_source", "text_updated_at", "gen_signature", "gen_max_id", "gen_at", "fail_count"];

function row(no: number, grp: string, key: string, label: string, zone: string, grade: string, status: string, title: string): (string | number | null)[] {
  const q = JSON.stringify([{ id: 0, text: "예시 민원", posted_at: now }]);
  return [fid, key, 1, now, label, null, zone, no, grp, grade, 0, 50.0, 1.0, 1.0, 50.0, "예시", 1, 1, now, 0, 0, status, null,
    "안전총괄과", "055-000-0005", `${key}|${grade}|${status}`, q, title,
    JSON.stringify([{ text: "현장 확인", quote_id: 0, source: "llm" }, { text: "안내 표지 보강", quote_id: 0, source: "llm" }]),
    q, 0, "llm", now, "", 0, now, 0];
}

if (mode === "no-main") {
  c.exec("DELETE FROM issue");
  const ins = c.prepare(`INSERT INTO issue (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`);
  for (const r of [
    row(1, "in_progress", "guide:1", "guide", "남강 수상무대", "mid", "in_progress", "수상무대 가는 길 표지판이 부족함"),
    row(2, "done", "restroom:1", "restroom", "진주교 남단 주차장", "low", "done", "화장실 대기 줄이 길고 위생이 나쁨"),
  ]) ins.run(...r);
} else if (mode === "clear") {
  c.exec("DELETE FROM issue");
} else {
  console.error(`모르는 모드: ${mode}`);
  process.exit(1);
}
c.close();
console.log("ok", mode);
