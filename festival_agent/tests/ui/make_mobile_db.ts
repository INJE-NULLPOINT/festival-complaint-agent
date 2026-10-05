// 점검용 DB — 운영 festival.db 를 복사해 (읽기만) 시험 내용을 넣는다.
//
//     node tests/ui/make_mobile_db.ts <dst>                       모바일 점검: 긴 민원·URL·부서명 등 극단 입력
//     node tests/ui/make_mobile_db.ts <dst> --big [민원수] [카드수]  속도 점검(D5-37): 민원 1,000건 · 카드 30장 규모
//
// 원본은 DB_PATH 환경변수, 없으면 festival_agent/festival.db. 원본은 읽기 전용으로 열어 VACUUM INTO 로 복사한다 (원본은 바뀌지 않는다).
// 시험용 docx 는 복사본 옆 docs/ 에 만든다 (운영 output/ 은 건드리지 않는다).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const BASE = path.resolve(import.meta.dirname, "..", "..");
const SRC = process.env.DB_PATH || path.join(BASE, "festival.db");
const DST = process.argv[2];
if (!DST) { console.error("사용: node tests/ui/make_mobile_db.ts <dst> [--big [민원수] [카드수]]"); process.exit(2); }
if (path.resolve(SRC) === path.resolve(DST)) throw new Error("원본과 같은 경로에는 만들 수 없습니다");
const bigAt = process.argv.indexOf("--big");

// 복사 (원본은 읽기만)
fs.rmSync(DST, { force: true });
const src = new DatabaseSync(SRC, { readOnly: true });
src.exec(`VACUUM INTO '${path.resolve(DST).replace(/'/g, "''")}'`);
src.close();

const d = new DatabaseSync(DST);
d.exec("PRAGMA busy_timeout=10000");
type Row = Record<string, any>;
const all = (sql: string, ...p: any[]): Row[] => d.prepare(sql).all(...p) as Row[];
const get = (sql: string, ...p: any[]): Row | undefined => d.prepare(sql).get(...p) as Row | undefined;
const run = (sql: string, ...p: any[]) => d.prepare(sql).run(...p);
const insert = (sql: string, ...p: any[]): number => Number(run(sql, ...p).lastInsertRowid);
const count = (sql: string): number => Number(Object.values(get(sql)!)[0]);
const tryExec = (fn: () => void) => { try { fn(); } catch { /* 예전 스키마 */ } };

// 복사본에는 워커가 없다 — 운영 DB 의 옛 worker_status 시각이 그대로 오면 화면이 '에이전트 멈춤'으로 바뀐다(D5-86). 먼 미래 시각으로 둬 멈춤 표시를 막는다.
// (멈춤 표시 자체는 admin_flow 가 dev_feed 응답을 바꿔서 따로 본다)
tryExec(() => run("UPDATE worker_status SET last_at = '2099-01-01T00:00:00'"));

const iso = (dt: Date) => dt.toISOString().slice(0, 19);                     // 'YYYY-MM-DDTHH:MM:SS' (UTC 기준 그대로 — 시험용 시각)
const localIso = (s: string) => new Date(s + "Z");                           // 시각 문자열을 시간대 없이 다룬다 (더하고 빼기만 한다)

// ── 대량 데이터 모드 (D5-37) ─────────────────────────────────────────
// 민원 N건 · 조치할 일 카드 M장을 더한다 (source='perf' — 합성 배지에 잡히지 않는 별도 값, 분류 완료 상태).
// 카드는 issue 표에 직접 넣는다. 모든 문장은 속도 측정용으로 지어낸 것이다 — 실제 민원이 아니다.
if (bigAt >= 0) {
  const N = Number(process.argv[bigAt + 1]) || 1000;
  const M = Number(process.argv[bigAt + 2]) || 30;
  let seed = 37;                                                              // mulberry32 — 같은 입력이면 같은 DB
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rint = (n: number) => Math.floor(rnd() * n);
  const fid = get("SELECT id FROM festival LIMIT 1")!.id;
  const zones = all("SELECT id, name FROM zone ORDER BY id");
  const labels = all("SELECT DISTINCT label FROM classification WHERE label IS NOT NULL").map((r) => r.label);
  if (!labels.length) labels.push("safety", "crowd", "parking", "restroom", "price", "guide");
  const latest = get("SELECT MAX(posted_at) m FROM feedback")?.m;
  const anchor = latest ? localIso(String(latest)) : new Date(Math.floor(Date.now() / 1000) * 1000);
  const PHRASE: Record<string, string> = {
    safety: "계단 조명이 꺼져 있어 발을 헛디딜 뻔했어요", crowd: "입구에 사람이 한꺼번에 몰려 밀리고 있어요",
    parking: "주차장이 가득 차서 빙빙 돌고 있어요", restroom: "화장실 줄이 너무 길어요", price: "음식 가격이 너무 비싸요",
    guide: "길 안내 표지판이 없어서 헤맸어요",
  };
  d.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    const zid = zones[rint(zones.length)].id;
    const lab = labels[rint(labels.length)];
    const at = iso(new Date(anchor.getTime() - rint(3600) * 1000));
    const text = `${PHRASE[lab] ?? "불편해요"} (측정용 ${i})`;
    const fbid = insert("INSERT INTO feedback (festival_id, zone_id, source, raw_text, posted_at, ingested_at, hash) VALUES (?,?,?,?,?,?,?)", fid, zid, "perf", text, at, at, `perf-${i}`);
    run("INSERT INTO classification (feedback_id, label, sentiment, is_safety, confidence, status, processed_at) VALUES (?,?,?,?,?,?,?)", fbid, lab, -0.5, lab === "safety" ? 1 : 0, 0.9, "done", at);
  }
  // 카드: 기존 카드를 그대로 두고 M장이 될 때까지 더한다
  const have = count("SELECT COUNT(*) FROM issue WHERE active=1");
  const groups = [...Array(3).fill("main"), ...Array(10).fill("more"), ...Array(7).fill("in_progress"), ...Array(10).fill("done")];
  const grades = ["immediate", "high", "mid", "low"];
  const now = iso(anchor);
  for (let k = 0; k < Math.max(0, M - have); k++) {
    const lab = labels[k % labels.length];
    const z = zones[k % zones.length];
    const g = groups[k % groups.length];
    const quotes = [0, 1, 2].map((j) => ({ id: 100000 + k * 3 + j, text: `${PHRASE[lab] ?? "불편해요"} (카드 ${k}-${j})`, posted_at: now }));
    const actions = [0, 1, 2].map((j) => ({ text: `${z.name} 현장 점검과 안내 인력 배치 ${j + 1}`, quote_id: quotes[0].id, source: "template" }));
    run(`INSERT INTO issue (festival_id, issue_key, active, updated_at, label, zone_id, zone_name, rank_no, grp, grade, is_safety,
         type_score, conc, rec, card_score, formula, freq, type_freq, last_at, same_zone_others, recurred, new_since_request,
         action_status, department, contact, signature, latest_quotes, title, actions, evidence_quotes, needs_judgment,
         text_source, text_updated_at, gen_signature, gen_max_id, gen_at, fail_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      fid, `perf:${k}`, 1, now, lab, z.id, z.name, have + k + 1, g, grades[k % 4], lab === "safety" ? 1 : 0,
      60.0 - k, 0.5, 1.0, 50.0 - k, `측정용 카드 ${k}`, 3, 10, now, 0, 0, 0,
      g === "in_progress" || g === "done" ? g : null, "측정용 부서", "055-000-0000", `perf|${k}`,
      JSON.stringify(quotes), `${z.name} ${PHRASE[lab] ?? "불편"} (측정용 카드 ${k})`,
      JSON.stringify(actions), JSON.stringify(quotes), 0,
      "template", now, `perf|${k}`, 0, now, 0);
  }
  d.exec("COMMIT");
  console.log("ok 민원", count("SELECT COUNT(*) FROM feedback"), "카드", count("SELECT COUNT(*) FROM issue WHERE active=1"));
  d.close();
  process.exit(0);
}

// ── 테스트 전용 docx ─────────────────────────────────────────────────
// 복사본 옆 docs/ 폴더에 요청서 1건을 local 규칙(LLM 없음, 조치요청서 생성 도구를 직접 호출)으로 실제 만든다.
// 운영 output/ 은 건드리지 않는다. 시험용 webapi 는 환경변수 DOCS_DIR=<이 폴더> 로 이 파일을 내준다 ('DOCX 내려받기' 점검이 건너뛰지 않고 실제로 돌게).
const DOCS = path.join(path.dirname(path.resolve(DST)), "docs");
d.close();                                     // 조치요청서 도구가 같은 파일을 열 수 있게 잠깐 닫는다
try {
  fs.mkdirSync(DOCS, { recursive: true });
  Object.assign(process.env, { DB_PATH: path.resolve(DST), LLM_BACKEND: "local", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", SUPABASE_DB_URL: "" });
  // 서버 모듈은 변수 경로로 불러온다 — 이 시험 도구의 타입 검사가 서버 코드까지 따라 들어가 서버 설정(strict)과 다른 기준으로 다시 검사하지 않게.
  // (서버 코드는 server/tsconfig.json 으로 따로 검사한다.) 쓰는 것은 아래 두 모양뿐이다.
  const dispatcherPath = "../../server/agents/dispatcher.ts", dbPath = "../../server/core/db.ts";
  const dispatcher = (await import(dispatcherPath)) as { paths: { OUT_DIR: string }; generate_doc: { fn: (...args: unknown[]) => Promise<unknown> } };
  const dbmod = (await import(dbPath)) as { close_all: () => Promise<void> };
  dispatcher.paths.OUT_DIR = DOCS;
  await dispatcher.generate_doc.fn("safety", "시험용 안전관리과", 3, "immediate",
    [{ raw_text: "시험용 민원: 계단 조명이 꺼져 있어요", zone: "유등터널", ingested_at: "2026-09-30T10:00:00" }],
    ["시험용 조치: 현장 점검과 안내 인력 배치"]);
  await dbmod.close_all();
} catch (e) {      // 생성에 실패해도 DB 는 그대로 쓸 수 있다 — 'DOCX 내려받기' 점검만 건너뜀으로 돈다
  console.error("경고: 시험용 docx 를 만들지 못함 —", (e as Error).name, (e as Error).message);
}

const c = new DatabaseSync(DST);
c.exec("PRAGMA busy_timeout=10000");
const call = { all: (sql: string, ...p: any[]) => c.prepare(sql).all(...p) as Row[], get: (sql: string, ...p: any[]) => c.prepare(sql).get(...p) as Row | undefined,
  run: (sql: string, ...p: any[]) => c.prepare(sql).run(...p) };
const cinsert = (sql: string, ...p: any[]) => Number(call.run(sql, ...p).lastInsertRowid);

// 복사본의 조치요청서 링크를 이 PC 에 실제로 있는 파일로만 남긴다 — 운영 DB 의 doc_url 은 Supabase 저장소 주소이거나 지워진 옛 docx 를 가리킬 수 있어
// 'DOCX 링크가 실제 파일' 점검이 남의 저장소·없는 파일에 기대게 된다. 테스트 전용 docs/ 에 있는 파일만 남기고 나머지는 링크를 비운다(버튼 없음).
const pyQuote = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
try {
  for (const r of call.all("SELECT id, doc_path FROM action_request")) {
    const name = r.doc_path ? path.basename(String(r.doc_path).replace(/\\/g, "/")) : "";
    const ok = !!name && fs.existsSync(path.join(DOCS, name));
    call.run("UPDATE action_request SET doc_url=?, doc_path=? WHERE id=?", ok ? "/api/docs/" + pyQuote(name) : null, ok ? r.doc_path : "", r.id);
  }
} catch { /* 예전 스키마 */ }

const now = "2026-09-29T23:10:00";
const fid = call.get("SELECT id FROM festival LIMIT 1")!.id;

const LONG_WORD = "진주남강유등축제".repeat(12);                                   // 띄어쓰기 없는 긴 단어
const URL_ = "https://www.example.com/festival/2026/jinju/namgang-yudeung/complaints?ref=qr&zone=%EC%9C%A0%EB%93%B1%ED%84%B0%EB%84%90";
const TEXT500 = "유등터널 입구에서 사람들이 한꺼번에 몰려서 밀리고 넘어질 뻔했습니다. ".repeat(20).slice(0, 480) + " " + URL_;
const short = (t: string) => createHash("sha1").update(t).digest("hex").slice(0, 12);
for (const [text, label] of [[TEXT500, "crowd"], [LONG_WORD, "guide"], [URL_, "guide"]] as const) {
  const id = cinsert("INSERT INTO feedback (festival_id, zone_id, source, raw_text, posted_at, ingested_at, hash) VALUES (?,?,?,?,?,?,?)", fid, 4, "qr", text, now, now, `mob-${short(text)}`);
  call.run("INSERT INTO classification (feedback_id, label, sentiment, is_safety, confidence, status, processed_at) VALUES (?,?,?,?,?,?,?)", id, label, -0.7, 0, 0.9, "done", now);
}

const DEPT = "진주시 문화관광체육국 축제운영지원단 현장안전관리팀 (055-000-0000 · 내선 12345)";
const doc = {
  festival: "제76회 개천예술제 · 2026 진주남강유등축제", department: DEPT, created_at: "2026-09-29 23:10",
  festival_info: "2026.10.01 ~ 2026.10.15 · 경상남도 진주시 남강로 일원 · " + URL_,
  label: "crowd", label_ko: "혼잡", count: 12, grade: "immediate", grade_ko: "즉시",
  basis: "안전·혼잡은 건수가 적어도 먼저 봅니다. 최근 구간에 급증이 있고 아직 조치가 없어 즉시 조치 등급입니다 · " + LONG_WORD.slice(0, 40),
  quotes: [{ raw_text: TEXT500, zone: "소망등 달기 구역 (남강 둔치 동쪽 끝 임시 무대 뒤편)", time: "23:09" },
    { raw_text: LONG_WORD, zone: "유등터널", time: "23:08" },
    { raw_text: URL_, zone: "유등터널", time: "23:07" }],
  suggestions: ["유등터널 입구에 안전요원 4명을 추가 배치하고 한 방향 통행으로 유도한다 · " + LONG_WORD.slice(0, 30), "혼잡 안내 방송을 5분 간격으로 한다", URL_],
};
// DOCX 버튼 주소: 테스트 전용 docs/ 에 실제 있는 파일을 가리킨다. 가짜 주소를 넣으면 DOCX 내려받기 점검이 404 를 '화면 문제' 로 오해한다.
// (파일이 하나도 없으면 주소를 비운다 = DOCX 버튼 없음)
const docx = fs.existsSync(DOCS) ? fs.readdirSync(DOCS).filter((f) => f.endsWith(".docx")).sort() : [];
const doc_url = docx.length ? "/api/docs/" + pyQuote(docx[0]) : null;
cinsert("INSERT INTO action_request (festival_id, label, department, count, doc_path, status, created_at, doc_url, doc_json) VALUES (?,?,?,?,?,?,?,?,?)",
  fid, "crowd", DEPT, 12, "", "requested", now, doc_url, JSON.stringify(doc));
// 관제 카드: 서버는 issue 표에 '저장된' 카드를 그대로 준다. 워커가 없는 복사본에서는 이 표가 복사한 그 순간으로 굳는다.
// 운영 상태에 따라 '지금 조치할 일(main)' 카드가 하나도 없을 수 있어(전부 조치 중·완료), 그러면 1위 카드 점검이 통째로 빠진다 →
// 복사본에서만 1위 카드를 main 으로 돌려 놓는다 (운영 DB 는 건드리지 않는다).
try {
  const top = call.get("SELECT id FROM issue WHERE active=1 ORDER BY rank_no LIMIT 1");
  const hasMain = Number(Object.values(call.get("SELECT COUNT(*) FROM issue WHERE active=1 AND grp='main'")!)[0]);
  if (top && !hasMain) call.run("UPDATE issue SET grp='main' WHERE id=?", top.id);
} catch { /* issue 표가 없는 예전 스키마 */ }
call.run("INSERT INTO alert (festival_id, label, kind, detail, created_at, acked) VALUES (?,?,?,?,?,0)", fid, "crowd", "immediate", "[혼잡] " + TEXT500, now);
call.run("INSERT INTO briefing (festival_id, top_label, text, rationale, created_at) VALUES (?,?,?,?,?)",
  fid, "crowd", "지금 최우선은 유등터널 혼잡 대응입니다. " + LONG_WORD + " " + URL_ + " 안전요원을 바로 보내 주세요.", "근거: " + URL_, now);
console.log("ok", Number(Object.values(call.get("SELECT COUNT(*) FROM feedback")!)[0]));
c.close();
