// 시연 시드(배경 24건 + 예약 2건)를 실제 모델로 미리 분류해 seed/demo_classify_cache.json 에 저장한다 (D5-89).
// 시연 때 demo_scenario.ts --reset 이 이 파일을 시연 DB 의 classify_cache 에 넣어, 분류가 모델 호출 없이 바로 끝난다.
//
// 사용법 (모델 호출이 든다 — claude_code 는 `claude -p` 26건 안팎, 민원 10건씩 묶어 3회)
//     $env:LLM_BACKEND = "claude_code"; node server/scripts/precache_demo.ts
//     node server/scripts/precache_demo.ts --dry-run       호출 없이 대상 문장 수만 보기
//
// 안전: 임시 SQLite 에서만 분류한다 (운영·시연 DB 를 건드리지 않는다). LLM_BACKEND 가 local 이면 거부 — 규칙 결과를 '모델 결과'로 저장하지 않는다.
// 유형을 정하지 못해 '확인 필요'로 간 문장은 캐시에 넣지 않고 알린다 (시연에서 운영자 확인 장면이 되거나 다시 돌린다).
import "./_safe_env.ts";
process.env.MEMORY = "0";                                  // 서로 비슷한 문장끼리 '유사 사례 반영'으로 빠지지 않게 — 전부 모델이 본다
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../core/config.ts";
import * as db from "../core/db.ts";
import * as llm from "../core/llm.ts";
import * as classifier from "../agents/classifier.ts";
import { BACKGROUND, RESERVED } from "./demo_scenario.ts";
import { FILE, type CacheFile, type Entry } from "./_democache.ts";

const { values: a } = parseArgs({ options: { out: { type: "string", default: FILE }, "dry-run": { type: "boolean", default: false } }, allowPositionals: true, strict: false });
const targets: [string, string][] = [...BACKGROUND, ...RESERVED.map(([, zone, text]): [string, string] => [zone, text])];
console.log(`대상 ${targets.length}건 (배경 ${BACKGROUND.length} + 예약 ${RESERVED.length}) · 백엔드 ${llm.backend()} · 모델 ${config.MODEL}`);
if (a["dry-run"]) process.exit(0);
if (llm.is_local()) { console.error("거부: LLM_BACKEND 가 local 입니다. claude_code 또는 anthropic 으로 실행하세요."); process.exit(2); }

config.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "precache-")), "p.db");
config.SUPABASE_DB_URL = "";
await db.init_db();
const zone_id = new Map((await db.zones()).map((z) => [z.name as string, z.id as number]));
for (const [zone, text] of targets) await db.insert_feedback(zone_id.get(zone)!, text, "demo");

for (let round = 1; round <= 8 && (await db.pending_count()) > 0; round++) {
  console.log(`분류 ${round}회차 (대기 ${await db.pending_count()}건)`);
  await classifier.run_once(20);
}

const conn = await db.connect();
const rows = (await conn.execute(
  `SELECT f.raw_text, c.status, c.label, c.sentiment, c.is_safety, c.confidence, c.suggested_label
   FROM feedback f JOIN classification c ON c.feedback_id=f.id ORDER BY f.id`)).fetchall();
const entries: Entry[] = [];
const left: string[] = [];
for (const r of rows) {
  if (r.status === "done") entries.push({ text: r.raw_text, label: r.label, sentiment: Number(r.sentiment), is_safety: Boolean(r.is_safety), confidence: Number(r.confidence) });
  else left.push(`[${r.status}] ${String(r.raw_text).slice(0, 40)}${r.suggested_label ? ` (제안 ${r.suggested_label})` : ""}`);
}
const out: CacheFile = { backend: llm.backend(), model: config.MODEL, created_at: db.now(), entries };
mkdirSync(path.dirname(a.out as string), { recursive: true });
writeFileSync(a.out as string, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`저장 ${entries.length}/${targets.length}건 → ${a.out}`);
for (const l of left) console.log(`  캐시 제외 ${l}`);
await db.close_all();
process.exit(left.length ? 1 : 0);
