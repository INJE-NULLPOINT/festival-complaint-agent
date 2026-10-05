// 테스트 공통 준비 — Python tests/test_severity.py 의 _temp_db · _seed · _rows · _AdminCode 등을 옮긴 것.
//
// 약속 (server/README.md 규칙 + [참모] 제안, [서버] 답에 따라 여기만 고친다)
//   · 모듈은 server/core/<이름>.ts · server/agents/<이름>.ts · server/webapi.ts · server/cli.ts
//   · 함수·필드 이름은 Python 그대로 (snake_case). Python 키워드 인자는 마지막 인자 하나의 객체.
//   · dict 반환 = 같은 키의 plain object, 튜플 반환 = 배열.
//   · config 는 바꿀 수 있는 객체 `config` (테스트가 잠깐 바꿨다 되돌린다).
//   · db.connect() → conn.execute(sql, params) → cur.fetchone()/fetchall()/lastrowid.
//     (동기든 비동기든 괜찮게 전부 await 한다. pg 를 쓰면 비동기일 것이다.)
//
// 안전: 모든 테스트는 임시 SQLite 로만 돈다. 운영 Supabase 에 닿지 않도록 모듈을 불러오기 **전에**
// SUPABASE_DB_URL 을 빈 값으로 둔다 (Node 의 process.env 는 빈 값도 '있는 값'이라 dotenv 가 덮어쓰지 않는다).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_DB_URL = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_KEY = "";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "fa-test-")), "boot.db");   // 혹시 모를 기본 경로 대비
process.env.PYTHONIOENCODING = "utf-8";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER = resolve(HERE, "..");            // festival_agent/server
export const ROOT = resolve(SERVER, "..");            // festival_agent
export const SEED = join(ROOT, "seed", "dev_sample.csv");

/** 모듈을 불러온다. 아직 없으면 null (그 테스트는 건너뛴다 — [서버]가 모듈을 만들면 자동으로 돈다). */
export async function tryImport(rel: string): Promise<any | null> {
  try {
    return await import(pathToFileURL(join(SERVER, rel)).href);
  } catch (e: any) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && String(e.message).includes(rel.split("/").pop()!)) return null;
    throw e;                                                       // 모듈은 있는데 깨진 것은 숨기지 않는다
  }
}

/** 여러 모듈을 한 번에. 하나라도 없으면 null 과 빠진 이름. */
export async function need(t: any, ...rels: string[]): Promise<any[] | null> {
  const out: any[] = [];
  const missing: string[] = [];
  for (const r of rels) {
    const m = await tryImport(r);
    if (!m) missing.push(r);
    out.push(m);
  }
  if (missing.length) {
    t.skip(`아직 없는 모듈: ${missing.join(", ")}`);
    return null;
  }
  return out;
}

// ── 시각 (Python naive datetime.isoformat(timespec="seconds") 와 같은 모양, 로컬 시각) ──
const p2 = (n: number) => String(n).padStart(2, "0");
export function iso(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
export const minutes = (m: number) => m * 60_000;
export const ago = (base: Date, m: number) => new Date(base.getTime() - minutes(m));
export function nowSec(): Date {
  const d = new Date();
  d.setMilliseconds(0);
  return d;
}

// ── DB 접근 (Python 의 with db.connect() as conn: conn.execute(...) 모양) ──
export async function all(db: any, sql: string, params: any[] = []): Promise<any[]> {
  const conn = await db.connect();
  const cur = await conn.execute(sql, params);
  return await cur.fetchall();
}
export async function one(db: any, sql: string, params: any[] = []): Promise<any> {
  const conn = await db.connect();
  const cur = await conn.execute(sql, params);
  return await cur.fetchone();
}
/** 쓰기 한 문장 + commit. lastrowid 를 돌려준다. */
export async function run(db: any, sql: string, params: any[] = []): Promise<number> {
  const conn = await db.connect();
  const cur = await conn.execute(sql, params);
  return cur?.lastrowid;
}

/** _temp_db(): config.DB_PATH 를 임시 파일로 바꾸고 init_db() 한 뒤 fn(db) 를 돈다. 끝나면 되돌린다. */
export async function withTempDb<T>(fn: (db: any) => Promise<T>): Promise<T> {
  const cfg = await tryImport("core/config.ts");
  const db = await tryImport("core/db.ts");
  const config = cfg.config ?? cfg;
  const prev = config.DB_PATH;
  db.use_path(join(mkdtempSync(join(tmpdir(), "fa-db-")), "t.db"));   // [서버] db.use_path — Python 의 config.DB_PATH 바꾸기
  try {
    await db.init_db();
    return await fn(db);
  } finally {
    if (typeof db.close_all === "function") await db.close_all();       // Windows 임시 파일 잠금 풀기
    db.use_path(prev);
  }
}

/** _rows(spec, ref): [(라벨, 분 전, 감정, 안전여부)] → rank_labels 입력 행. */
export function rows(spec: Array<[string, number, number, boolean]>, ref: Date) {
  return spec.map(([label, m, s, sf]) => ({
    label, sentiment: s, is_safety: sf ? 1 : 0, posted_at: iso(ago(ref, m)), ingested_at: "", zone_id: 1,      // 같은 구역 (S-04 는 구역별로 센다)
  }));
}

/** _seed(db, items): [(구역id|null, 유형, 분 전, 감정, 안전여부, 문장)] 을 '분류 완료'로 넣는다. */
export async function seed(db: any, items: Array<[number | null, string, number, number, boolean, string]>, base?: Date) {
  base = base ?? nowSec();
  const ids: number[] = [];
  for (const [zone, label, m, senti, safe, text] of items) {
    const posted = iso(ago(base, m));
    const fid = await db.insert_feedback(zone, text, "test", posted);
    await run(db,
      "UPDATE classification SET label=?, sentiment=?, is_safety=?, confidence=0.9, " +
      "status='done', processed_at=?, agent_note='test' WHERE feedback_id=?",
      [label, senti, safe ? 1 : 0, await db.now(), fid]);
    ids.push(fid);
  }
  return ids;
}

export async function cards() {
  const issues = await tryImport("core/issues.ts");
  return await issues.build_cards();
}

/** _one_card: 검사용 카드 하나 (안전·즉시 또는 주차). */
export async function oneCard(db: any, label = "safety", zone = 4) {
  if (label === "parking") {
    await seed(db, ([[9, "주차장이 만차예요"], [6, "주차할 곳이 없어요"], [3, "주차장 나가는 데 오래 걸려요"]] as const)
      .map(([m, t]) => [zone, "parking", m, -0.5, false, t] as [number, string, number, number, boolean, string]));
  } else {
    await seed(db, ([[9, "유등터널 계단 조명이 꺼져 있어요"], [6, "계단 난간이 흔들려서 위험해요"], [3, "바닥이 미끄러워서 넘어졌어요"]] as const)
      .map(([m, t]) => [zone, "safety", m, -0.8, true, t] as [number, string, number, number, boolean, string]));
  }
  return (await cards()).find((c: any) => c.label === label);
}

/** _review_row: 분류 신뢰도가 낮아 review 가 된 민원 하나 (save_classification 경로). */
export async function reviewRow(db: any, text: string, o: { safety: boolean; suggested: string; conf?: number; zone?: number; ago_min?: number }) {
  const classifier = await tryImport("agents/classifier.ts");
  const fid = await db.insert_feedback(o.zone ?? 4, text, "test");
  await classifier.save_classification.fn(fid, o.suggested, -0.6, o.safety, o.conf ?? 0.2, "근거 약함");
  if (o.ago_min) {
    await run(db, "UPDATE feedback SET ingested_at=? WHERE id=?", [iso(ago(new Date(), o.ago_min)), fid]);
  }
  return fid;
}

export async function cls(db: any, fid: number) {
  return await one(db, "SELECT * FROM classification WHERE feedback_id=?", [fid]);
}

/** 환경변수를 잠깐 바꾼다 (Python 의 os.environ 바꿨다 되돌리기). */
export async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  process.env[key] = value;
  try { return await fn(); } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}
export const withLocalBackend = <T>(fn: () => Promise<T>) => withEnv("LLM_BACKEND", "local", fn);

/** config 의 값 몇 개를 잠깐 바꾼다. */
export async function withConfig<T>(patch: Record<string, any>, fn: () => Promise<T>): Promise<T> {
  const cfg = await tryImport("core/config.ts");
  const config = cfg.config ?? cfg;
  const prev: Record<string, any> = {};
  for (const k of Object.keys(patch)) { prev[k] = config[k]; config[k] = patch[k]; }
  try { return await fn(); } finally { Object.assign(config, prev); }
}

/** Python round(x, n) — 은행가 반올림(짝수 쪽). 기대값 비교를 Python 과 같게 하려고 쓴다. */
export function pyround(x: number, n = 0): number {
  const f = 10 ** n;
  const v = x * f;
  const r = Math.round(v);
  const diff = Math.abs(v - Math.trunc(v));
  if (Math.abs(diff - 0.5) < 1e-9) {                              // 정확히 .5 → 짝수 쪽
    const lo = Math.floor(v);
    return (lo % 2 === 0 ? lo : lo + 1) / f;
  }
  return r / f;
}

/** 간단한 CSV 읽기 (따옴표·쉼표·줄바꿈 처리, BOM 제거). Python csv.DictReader 대용. */
export function parseCsv(text: string): Record<string, string>[] {
  text = text.replace(/^﻿/, "");
  const out: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  const [head, ...body] = out;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

export function csvLine(cells: string[]): string {
  return cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");
}

/** DOCX 본문 글자 (python-docx 의 paragraphs + tables 대용). zip 을 직접 풀어 word/document.xml 의 w:t 를 모은다. */
export async function docxText(path: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { inflateRawSync } = await import("node:zlib");
  const buf = readFileSync(path);
  // 끝의 End of Central Directory 에서 중앙 디렉터리를 찾는다
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    if (name === "word/document.xml") {
      const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
      const start = local + 30 + lnlen + lxlen;
      const data = buf.subarray(start, start + csize);
      const xml = (method === 0 ? data : inflateRawSync(data)).toString("utf8");
      // 문단(w:p)마다 줄을 나누고 글자(w:t)를 잇는다
      return xml.split(/<\/w:p>/).map((p) =>
        [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""))
        .join("\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    off += 46 + nlen + xlen + clen;
  }
  throw new Error(`word/document.xml 없음: ${path}`);
}

/** Python 의 try: f() except X as e: assert ... else: raise 를 옮긴 것. 던져진 오류를 돌려준다. */
export async function rejects(fn: () => any, check?: (e: any) => void): Promise<any> {
  try {
    await fn();
  } catch (e) {
    check?.(e);
    return e;
  }
  throw new Error("오류가 나야 하는데 통과함");
}

/** stdout 으로 찍힌 글자를 모은다 (cli.show_feedback 등). console.log 와 process.stdout.write 둘 다. */
export async function captureStdout(fn: () => any): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  (process.stdout as any).write = (s: any) => { chunks.push(String(s)); return true; };
  console.log = (...a: any[]) => { chunks.push(a.map(String).join(" ") + "\n"); };
  try { await fn(); } finally {
    (process.stdout as any).write = origWrite;
    console.log = origLog;
  }
  return chunks.join("");
}

export async function sha256hex(s: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s, "utf8").digest("hex");
}
