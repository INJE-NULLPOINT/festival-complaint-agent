// DB 접근 계층. SQLite(node:sqlite, 로컬) 또는 Supabase Postgres(pg). (core/db.py 와 1:1)
//
// 설계 원칙: 화면은 상태를 들고 있지 않는다. 모든 상태는 여기에만 있다.
// 백엔드 선택: config.SUPABASE_DB_URL 이 있으면 Postgres, 없으면 SQLite(config.DB_PATH). 호출할 때마다 config 를 읽는다.
// SQL 은 SQLite 문법으로 한 벌만 쓰고, Postgres 에서는 _translate() 가 바꿔 준다.
// Postgres 스키마는 supabase/schema.sql 이 관리한다.
//
// Python 과 다른 점(동작은 같다): 모든 DB 함수가 async 이다 (pg 가 비동기라서).
//   Python `with connect() as conn:` → `const conn = await connect()`. 연결은 닫지 않는다(경로별로 재사용, 풀).
//   커밋은 문장마다 즉시 된다(autocommit).
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { config } from "./config.ts";
import { fromisoformat, isoformat, minutes, plus } from "./datetime.ts";
import { KeyError } from "./errors.ts";
import * as privacy from "./privacy.ts";
import * as severity from "./severity.ts";

export type Row = Record<string, any>;
export type Params = readonly unknown[];

export interface Cursor {
  rows: Row[];
  lastrowid: number | null;
  rowcount: number;
  fetchone(): Row | undefined;
  fetchall(): Row[];
}
export interface Conn {
  execute(sql: string, params?: Params): Promise<Cursor>;
  executescript(script: string): Promise<void>;
}

export const SCHEMA = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS festival (
  id INTEGER PRIMARY KEY, name TEXT, region TEXT,
  start_date TEXT, end_date TEXT
);

CREATE TABLE IF NOT EXISTS zone (
  id INTEGER PRIMARY KEY, festival_id INTEGER, name TEXT UNIQUE,
  hidden INTEGER DEFAULT 0       -- 1 = 방문객 구역 선택에서 숨김 (민원이 달려 있어 지우지 않는다, D5-90)
);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY,
  festival_id INTEGER,
  zone_id     INTEGER,       -- NULL = 구역 미상 (config.ZONE_UNKNOWN)
  source      TEXT,          -- qr | replay | staff
  raw_text    TEXT,
  posted_at   TEXT,          -- 리플레이는 원본 시각
  ingested_at TEXT,          -- 실제 수신 시각 (실시간 증명)
  hash        TEXT UNIQUE,
  deleted_at  TEXT,          -- NULL = 살아 있음, 값 = 운영자가 지움(숨김·되돌리기 가능)
  dup_count   INTEGER DEFAULT 0   -- 같은 글을 2분 안에 또 보내 합쳐진 횟수 (D5-33 ①)
);

CREATE TABLE IF NOT EXISTS classification (
  feedback_id  INTEGER PRIMARY KEY REFERENCES feedback(id),
  label        TEXT,
  sentiment    REAL,
  is_safety    INTEGER,
  confidence   REAL,
  status       TEXT DEFAULT 'pending',   -- pending | done | review(운영자 확인, 유형 없음) | dismissed(유형 없음으로 닫음) | failed
  processed_at TEXT,
  agent_note   TEXT,
  suggested_label TEXT,                  -- review 일 때 모델이 제안한 유형 (문자열 파싱 대신 열로 저장)
  reviewed_at  TEXT,                     -- 운영자가 처리한 시각
  review_action TEXT,                    -- label(유형 지정) | dismissed(유형 없음으로 닫음)
  decided_by   TEXT                      -- 'operator' = 운영자가 처리 (measure_accuracy 가 모델 정답으로 치지 않음)
);

CREATE TABLE IF NOT EXISTS severity (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  label TEXT, "window" TEXT, as_of TEXT,
  freq INTEGER, avg_sentiment REAL,
  base_score REAL, safety_w REAL, spike_w REAL, pending_w REAL,
  score REAL, grade TEXT, formula TEXT,
  spike_mult REAL, safety_freq INTEGER      -- 개발자 보기용 내부값 (급증 배수 · 안전(is_safety) 민원 수, D5-62)
);

CREATE TABLE IF NOT EXISTS alert (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  label TEXT, kind TEXT,      -- spike | safety_threshold | grade_up
  detail TEXT, created_at TEXT, acked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS department_map (
  label TEXT PRIMARY KEY, department TEXT, contact TEXT
);

CREATE TABLE IF NOT EXISTS action_request (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  label TEXT, department TEXT, count INTEGER,
  doc_path TEXT, status TEXT DEFAULT 'requested',
  created_at TEXT, closed_at TEXT,
  doc_url TEXT, doc_json TEXT
);

-- 웹 접수폼이 넣는 곳. 워커가 마스킹 후 feedback 으로 옮긴다.
CREATE TABLE IF NOT EXISTS feedback_inbox (
  id INTEGER PRIMARY KEY, zone_id INTEGER, text TEXT, created_at TEXT,
  feedback_id INTEGER,
  dup_count INTEGER DEFAULT 0     -- 합쳐진 횟수 (D5-33 ①)
);

-- 출처별 폭주 제한용 (D5-33 ②). 출처 = 접속 주소의 하루짜리 해시(원문 IP 아님), 24시간 뒤 삭제, 민원 행과 연결하지 않는다.
CREATE TABLE IF NOT EXISTS submit_rate (
  id INTEGER PRIMARY KEY, src TEXT, at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rate_src_at ON submit_rate(src, at);

-- 웹의 '조치요청서 생성' 버튼이 넣는 곳. 워커가 처리한다.
CREATE TABLE IF NOT EXISTS doc_job (
  id INTEGER PRIMARY KEY, label TEXT,
  status TEXT DEFAULT 'queued',            -- queued | running | done | failed
  action_request_id INTEGER, error TEXT,
  created_at TEXT, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_task (
  id INTEGER PRIMARY KEY, agent TEXT, payload TEXT,
  state TEXT DEFAULT 'queued',
  created_at TEXT, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_log (
  id INTEGER PRIMARY KEY,
  agent TEXT, action TEXT,
  input_summary TEXT, output_summary TEXT, reasoning TEXT,
  latency_ms INTEGER, created_at TEXT,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS briefing (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  top_label TEXT, text TEXT, rationale TEXT, created_at TEXT,
  top_issue_key TEXT, issue_sig TEXT
);

-- 관제 '지금 조치할 일' 카드 한 장 = 한 행 (유형×구역). 계산 열은 core/issues.refresh() 가,
-- 문장 열(title·actions·evidence_quotes)은 ④통합 에이전트가 쓴다. JSON 열은 문자열이다.
CREATE TABLE IF NOT EXISTS issue (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  issue_key TEXT UNIQUE, active INTEGER DEFAULT 1, updated_at TEXT,
  label TEXT, zone_id INTEGER, zone_name TEXT,           -- zone_id NULL = 구역 미상
  rank_no INTEGER, grp TEXT,                              -- main | more | in_progress | done
  grade TEXT, is_safety INTEGER DEFAULT 0, type_score REAL, conc REAL, rec REAL,
  card_score REAL, formula TEXT, freq INTEGER, type_freq INTEGER, last_at TEXT,
  same_zone_others INTEGER DEFAULT 0, recurred INTEGER DEFAULT 0, new_since_request INTEGER DEFAULT 0,
  action_status TEXT, action_request_id INTEGER, department TEXT, contact TEXT,
  signature TEXT, latest_quotes TEXT,                     -- 최신 민원 (매 주기 갱신)
  title TEXT, actions TEXT, evidence_quotes TEXT,         -- 문구와 그 근거 (문구를 다시 쓸 때만 바뀜)
  needs_judgment INTEGER DEFAULT 0,                       -- 고위험 표현 포함 → 운영자 판단 필요
  text_source TEXT DEFAULT 'template',                    -- llm | local | template
  text_updated_at TEXT, gen_signature TEXT, gen_max_id INTEGER DEFAULT 0,
  gen_at TEXT, fail_count INTEGER DEFAULT 0
);

-- 운영자 코드를 틀린 시도 기록 (core/admin.ts). 10분에 5번 넘게 틀리면 그 창 동안 거부한다.
CREATE TABLE IF NOT EXISTS admin_attempt (
  id INTEGER PRIMARY KEY, at TEXT,
  src TEXT DEFAULT ''          -- 출처 해시(접속 주소 + 하루 비밀값, core/source_id.ts). 원문 IP 는 저장하지 않는다
);

CREATE TABLE IF NOT EXISTS classify_cache (
  hash TEXT PRIMARY KEY, result TEXT
);

-- 워커 상태 (개발자 보기, D5-62): 루프마다 한 줄. name = ingest|classify|doc_jobs|agents|issues, '_backend' 는 LLM 백엔드(note).
CREATE TABLE IF NOT EXISTS worker_status (
  name TEXT PRIMARY KEY, last_at TEXT, took_ms INTEGER, ok INTEGER DEFAULT 1, note TEXT
);

CREATE INDEX IF NOT EXISTS idx_cls_status ON classification(status);
CREATE INDEX IF NOT EXISTS idx_fb_ingested ON feedback(ingested_at);
`;

export function now(): string {
  return isoformat(new Date());
}

// 운영자가 지운(숨긴) 민원을 모든 집계에서 빼는 공통 조건. feedback 을 f 로 조인한 쿼리에 붙인다.
export const LIVE_FEEDBACK_SQL = "f.deleted_at IS NULL";

export function is_pg(): boolean {
  return Boolean(config.SUPABASE_DB_URL);
}

// ── Postgres 어댑터 ──
// id 자동 증가 컬럼이 있는 테이블. INSERT 에 RETURNING id 를 붙여 lastrowid 를 흉내 낸다.
const _ID_TABLES = new Set(["festival", "zone", "feedback", "severity", "alert", "action_request",
  "agent_task", "agent_log", "briefing", "feedback_inbox", "doc_job", "replay_state", "issue", "admin_attempt"]);
// INSERT OR REPLACE 의 충돌 기준 컬럼
const _UPSERT_KEY: Record<string, string> = { department_map: "label", classify_cache: "hash", festival_info: "content_id", worker_status: "name" };
const _INSERT_RE = /^\s*INSERT\s+(OR\s+(IGNORE|REPLACE)\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/is;

/** SQLite 문법 → Postgres. [변환된 SQL, RETURNING id 를 붙였는지] */
export function _translate(sql: string): [string, boolean] {
  let returning = false;
  const m = _INSERT_RE.exec(sql);
  if (m) {
    const mode = (m[2] ?? "").toUpperCase();
    const table = m[3].toLowerCase();
    const cols = m[4].split(",").map((c) => c.trim());
    sql = sql.replace(_INSERT_RE, (_all, _a, _b, t, c) => `INSERT INTO ${t} (${c})`);
    sql = sql.trimEnd().replace(/;+$/, "").trimEnd();
    if (mode === "IGNORE") {
      sql += " ON CONFLICT DO NOTHING";
    } else if (mode === "REPLACE") {
      const key = _UPSERT_KEY[table];
      const sets = cols.filter((c) => c !== key).map((c) => `${c}=EXCLUDED.${c}`).join(", ");
      sql += ` ON CONFLICT (${key}) DO UPDATE SET ${sets}`;
    }
    if (_ID_TABLES.has(table) && !sql.toUpperCase().includes("RETURNING")) {
      sql += " RETURNING id";
      returning = true;
    }
  }
  sql = sql.replace(/\browid\b/g, "ctid");
  let n = 0;
  sql = sql.replace(/\?/g, () => `$${++n}`);        // ? → $1, $2 …
  return [sql, returning];
}

function makeCursor(rows: Row[], lastrowid: number | null, rowcount: number): Cursor {
  return { rows, lastrowid, rowcount, fetchone: () => rows[0], fetchall: () => rows };
}

const _norm = (v: unknown): any => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);

// ── SQLite ──
const _sqlite = new Map<string, DatabaseSync>();

function sqliteHandle(path: string): DatabaseSync {
  let db = _sqlite.get(path);
  if (!db) {
    db = new DatabaseSync(path, { timeout: 10000 });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    // 전원·블루스크린 대비: FULL 은 커밋마다 디스크에 쓴 뒤 끝난다(WAL 에서 NORMAL 은 마지막 몇 건을 잃을 수 있다).
    db.exec("PRAGMA synchronous=FULL");
    db.exec("PRAGMA wal_autocheckpoint=1000");
    _sqlite.set(path, db);
  }
  return db;
}

class SqliteConn implements Conn {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {      // parameter property 는 Node 의 타입 제거로 못 지운다
    this.db = db;
  }

  async execute(sql: string, params: Params = []): Promise<Cursor> {
    const stmt = this.db.prepare(sql);
    const args = params.map(_norm);
    if (/^\s*(select|pragma|with)\b/i.test(sql)) {
      const rows = stmt.all(...args) as Row[];
      return makeCursor(rows.map((r) => ({ ...r })), null, rows.length);
    }
    const r = stmt.run(...args);
    return makeCursor([], Number(r.lastInsertRowid), Number(r.changes));
  }

  async executescript(script: string): Promise<void> {
    this.db.exec(script);
  }

}

// ── Postgres ──
let _pool: pg.Pool | null = null;
let _poolUrl = "";

/** 풀과 같은 접속 설정 (백업·복원이 전용 연결을 따로 열 때 쓴다). URL 은 밖으로 찍지 않는다. */
export function pg_client_config(): pg.ClientConfig {
  pg.types.setTypeParser(20, (v) => Number(v));            // bigint(COUNT 등) → number
  const url = config.SUPABASE_DB_URL;
  const local = /@(localhost|127\.0\.0\.1)/.test(url);
  return { connectionString: url, connectionTimeoutMillis: 10000, ssl: local ? undefined : { rejectUnauthorized: false } };
}

function pgPool(): pg.Pool {
  const url = config.SUPABASE_DB_URL;
  if (!_pool || _poolUrl !== url) {
    _pool = new pg.Pool({ ...pg_client_config(), max: 5 });
    _poolUrl = url;
  }
  return _pool;
}

class PgConn implements Conn {
  async execute(sql: string, params: Params = []): Promise<Cursor> {
    const [q, returning] = _translate(sql);
    const res = await pgPool().query(q, params.length ? params.map(_norm) : undefined);
    const rows = (res.rows ?? []) as Row[];
    return makeCursor(rows, returning && rows[0] ? Number(rows[0].id) : null, res.rowCount ?? 0);
  }

  async executescript(_script: string): Promise<void> {}     // Postgres 스키마는 supabase/schema.sql 로 관리한다
}

const _pgConn = new PgConn();

export async function connect(): Promise<Conn> {
  if (is_pg()) return _pgConn;
  return new SqliteConn(sqliteHandle(config.DB_PATH));
}

/** 같은 트랜잭션처럼 묶고 싶을 때 (SQLite 전용 BEGIN IMMEDIATE, pg 는 그냥 실행). 실패하면 되돌린다. */
export async function transaction<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
  const conn = await connect();
  if (is_pg()) return fn(conn);
  const raw = sqliteHandle(config.DB_PATH);
  raw.exec("BEGIN IMMEDIATE");
  try {
    const out = await fn(conn);
    raw.exec("COMMIT");
    return out;
  } catch (e) {
    raw.exec("ROLLBACK");
    throw e;
  }
}

/** 테스트용: 이 경로의 DB 를 쓰게 한다 (Python 테스트가 config.DB_PATH 를 바꾸던 것). */
export function use_path(p: string): void {
  config.DB_PATH = p;
}

/** 테스트 뒤 정리용: 열린 SQLite 핸들·pg 풀을 모두 닫는다 (Windows 에서 임시 파일 삭제가 되도록). */
export async function close_all(): Promise<void> {
  for (const db of _sqlite.values()) {
    try { db.close(); } catch { /* 이미 닫힘 */ }
  }
  _sqlite.clear();
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export function is_unique_error(e: unknown): boolean {
  const x = e as { code?: string; errcode?: number; message?: string };
  return x?.code === "23505" || x?.errcode === 2067 || x?.errcode === 1555 || /UNIQUE constraint failed/i.test(x?.message ?? "");
}

async function _migrate_sqlite(conn: Conn): Promise<void> {
  const cols = async (t: string): Promise<Set<string>> =>
    new Set((await conn.execute(`PRAGMA table_info(${t})`)).rows.map((r) => r.name as string));
  let have = await cols("action_request");
  for (const col of ["doc_url", "doc_json"]) {
    if (!have.has(col)) await conn.execute(`ALTER TABLE action_request ADD COLUMN ${col} TEXT`);
  }
  for (const tbl of ["feedback", "feedback_inbox"]) {
    const c = await cols(tbl);
    if (c.size && !c.has("dup_count")) await conn.execute(`ALTER TABLE ${tbl} ADD COLUMN dup_count INTEGER DEFAULT 0`);
  }
  have = await cols("admin_attempt");
  if (have.size && !have.has("src")) await conn.execute("ALTER TABLE admin_attempt ADD COLUMN src TEXT DEFAULT ''");
  have = await cols("classification");
  for (const col of ["suggested_label", "reviewed_at", "review_action", "decided_by"]) {
    if (!have.has(col)) await conn.execute(`ALTER TABLE classification ADD COLUMN ${col} TEXT`);
  }
  have = await cols("feedback");
  if (!have.has("deleted_at")) await conn.execute("ALTER TABLE feedback ADD COLUMN deleted_at TEXT");
  have = await cols("issue");
  if (have.size && !have.has("new_since_request")) await conn.execute("ALTER TABLE issue ADD COLUMN new_since_request INTEGER DEFAULT 0");
  have = await cols("briefing");
  for (const col of ["top_issue_key", "issue_sig"]) {
    if (!have.has(col)) await conn.execute(`ALTER TABLE briefing ADD COLUMN ${col} TEXT`);
  }
  have = await cols("zone");
  if (have.size && !have.has("hidden")) await conn.execute("ALTER TABLE zone ADD COLUMN hidden INTEGER DEFAULT 0");
  have = await cols("severity");
  if (!have.has("spike_mult")) await conn.execute("ALTER TABLE severity ADD COLUMN spike_mult REAL");
  if (!have.has("safety_freq")) await conn.execute("ALTER TABLE severity ADD COLUMN safety_freq INTEGER");
  have = await cols("agent_log");
  for (const col of ["input_tokens", "output_tokens", "cache_read_tokens"]) {
    if (!have.has(col)) await conn.execute(`ALTER TABLE agent_log ADD COLUMN ${col} INTEGER DEFAULT 0`);
  }
}

// feedback 조회 속도용 인덱스 (D5-37). 열이 생긴 뒤(마이그레이션 뒤)에 만든다.
export const INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_fb_posted ON feedback(posted_at)",
  "CREATE INDEX IF NOT EXISTS idx_fb_src_posted ON feedback(source, posted_at)",
  "CREATE INDEX IF NOT EXISTS idx_fb_deleted ON feedback(deleted_at)",
  // 접수함 수거 쿼리(워커가 1초마다)가 비어 있을 때 거의 공짜가 되게: 아직 안 옮긴 접수만 색인한다 (D5-71)
  "CREATE INDEX IF NOT EXISTS idx_inbox_pending ON feedback_inbox(id) WHERE feedback_id IS NULL",
];

/** 스키마 생성 + 시드 투입. 몇 번 실행해도 안전하다. */
export async function init_db(): Promise<void> {
  const conn = await connect();
  await conn.executescript(SCHEMA);
  if (!is_pg()) await _migrate_sqlite(conn);
  for (const sql of INDEX_SQL) await conn.execute(sql);

  const row = (await conn.execute("SELECT id FROM festival LIMIT 1")).fetchone();
  let fid: number;
  if (row === undefined) {
    const cur = await conn.execute(
      "INSERT INTO festival (name, region, start_date, end_date) VALUES (?,?,?,?)",
      [config.FESTIVAL.name, config.FESTIVAL.region, config.FESTIVAL.start_date, config.FESTIVAL.end_date],
    );
    fid = cur.lastrowid as number;
  } else {
    fid = row.id;
  }
  // 구역·부서는 **비어 있을 때만** 기본값을 넣는다 — 운영자가 바꾼 이름·부서·연락처를 다음 시작에 되돌리지 않게 (D5-90). config 는 DB 가 빈 곳의 기본값.
  if ((await conn.execute("SELECT COUNT(*) c FROM zone")).fetchone()!.c === 0) {
    for (const z of config.ZONES) await conn.execute("INSERT OR IGNORE INTO zone (festival_id, name) VALUES (?,?)", [fid, z]);
  }
  for (const [label, [dept, contact]] of Object.entries(config.DEPARTMENT_MAP)) {
    await conn.execute("INSERT OR IGNORE INTO department_map (label, department, contact) VALUES (?,?,?)", [label, dept, contact]);
  }
}

export async function festival_id(): Promise<number> {
  const conn = await connect();
  return (await conn.execute("SELECT id FROM festival LIMIT 1")).fetchone()!.id;
}

export async function zones(): Promise<Row[]> {
  const conn = await connect();
  return (await conn.execute("SELECT id, name FROM zone ORDER BY id")).fetchall();
}

/** 민원 1건을 숨기거나(deleted=true) 되돌린다. 없는 id 는 KeyError 대신 Error('KeyError: …'). 멱등. */
export async function set_feedback_deleted(feedback_id: number, deleted: boolean, ts: string | null = null): Promise<void> {
  const conn = await connect();
  if ((await conn.execute("SELECT id FROM feedback WHERE id=?", [feedback_id])).fetchone() === undefined) {
    throw new KeyError(`없는 민원입니다: ${feedback_id}`);
  }
  await conn.execute("UPDATE feedback SET deleted_at=? WHERE id=?", [deleted ? (ts ?? now()) : null, feedback_id]);
}

export { KeyError };      // Python KeyError 대응 (core/errors.ts)

export async function deleted_count(): Promise<number> {
  const conn = await connect();
  return (await conn.execute("SELECT COUNT(*) c FROM feedback WHERE deleted_at IS NOT NULL")).fetchone()!.c;
}

/** 최근에 지운(숨긴) 민원 — 운영자가 되돌릴 수 있게 보여 주는 목록 (D5-42). 지운 시각 최신순. */
export async function list_deleted(limit = 50): Promise<Row[]> {
  const conn = await connect();
  return (await conn.execute(
    `SELECT f.id, f.raw_text, COALESCE(z.name, '${config.ZONE_UNKNOWN}') zone, f.zone_id,
            f.posted_at, f.deleted_at, c.label, c.status
     FROM feedback f
     LEFT JOIN zone z ON z.id = f.zone_id
     LEFT JOIN classification c ON c.feedback_id = f.id
     WHERE f.deleted_at IS NOT NULL
     ORDER BY f.deleted_at DESC, f.id DESC LIMIT ?`,
    [Math.max(1, Math.min(Math.trunc(limit), 200))],
  )).fetchall();
}

// ── 쓰기 ──

/**
 * 민원 1건 저장 + 분류 대기열 등록. 중복이거나 내용이 없으면 null.
 * ★ 저장 전에 개인정보를 마스킹한다. 내용이 없는 입력('...', 'ㅋㅋ')은 저장하지 않는다. zone_id=null 은 '구역 미상'.
 */
export async function insert_feedback(zone_id: number | null, raw_text: string, source = "qr",
                                      posted_at: string | null = null): Promise<number | null> {
  if (!privacy.has_content(raw_text)) return null;
  raw_text = privacy.mask(raw_text);

  const ts = now();
  const digest = createHash("sha256").update(`${zone_id === null ? "None" : zone_id}|${raw_text.trim()}|${posted_at ?? ts}`).digest("hex");
  const conn = await connect();
  let cur: Cursor;
  try {
    cur = await conn.execute(
      `INSERT INTO feedback
       (festival_id, zone_id, source, raw_text, posted_at, ingested_at, hash)
       VALUES (?,?,?,?,?,?,?)`,
      [await festival_id(), zone_id, source, raw_text.trim(), posted_at ?? ts, ts, digest],
    );
  } catch (e) {
    if (is_unique_error(e)) return null;
    throw e;
  }
  const fid = cur.lastrowid as number;
  await conn.execute("INSERT INTO classification (feedback_id, status) VALUES (?, 'pending')", [fid]);
  return fid;
}

export async function log_agent(agent: string, action: string, input_summary = "", output_summary = "", reasoning = "",
                                latency_ms = 0, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0): Promise<void> {
  const conn = await connect();
  await conn.execute(
    `INSERT INTO agent_log
     (agent, action, input_summary, output_summary, reasoning, latency_ms, created_at,
      input_tokens, output_tokens, cache_read_tokens)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [agent, action, input_summary.slice(0, 200), output_summary.slice(0, 200), reasoning.slice(0, 300), Math.trunc(latency_ms), now(),
      input_tokens, output_tokens, cache_read_tokens],
  );
}

export async function raise_alert(label: string, kind: string, detail: string): Promise<number> {
  const conn = await connect();
  const cur = await conn.execute(
    "INSERT INTO alert (festival_id, label, kind, detail, created_at) VALUES (?,?,?,?,?)",
    [await festival_id(), label, kind, detail, now()],
  );
  return cur.lastrowid as number;
}

export async function save_severity(rows: Row[], window: string): Promise<void> {
  const ts = now();
  const conn = await connect();
  const fid = await festival_id();
  for (const r of rows) {
    await conn.execute(
      `INSERT INTO severity
       (festival_id, label, "window", as_of, freq, avg_sentiment,
        base_score, safety_w, spike_w, pending_w, score, grade, formula, spike_mult, safety_freq)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fid, r.label, window, ts, r.freq, r.avg_sentiment, r.base_score, r.safety_w, r.spike_w, r.pending_w, r.score, r.grade, r.formula,
        r.spike?.multiplier ?? null, r.safety_freq ?? null]);
  }
}

/** 워커 루프 상태 한 줄 (개발자 보기). 실패해도 워커는 계속 돈다. */
export async function set_worker_status(name: string, took_ms: number, ok = true, note = ""): Promise<void> {
  try {
    const conn = await connect();
    await conn.execute(
      "INSERT OR REPLACE INTO worker_status (name, last_at, took_ms, ok, note) VALUES (?,?,?,?,?)",
      [name, now(), Math.round(took_ms), ok ? 1 : 0, note.slice(0, 200)]);
  } catch { /* 상태 기록 실패는 무시 */ }
}

/** 이 창의 가장 최근 스냅샷이 rows 와 같은 판정이면 true. (같은 주기에 둘이 같은 초에 저장해 행이 2개씩 생기던 문제) */
export async function severity_recorded(rows: Row[], window: string): Promise<boolean> {
  const key = (r: Row): string => JSON.stringify([r.label, r.freq, Math.round(r.score * 10) / 10, r.grade]);
  const conn = await connect();
  const last = (await conn.execute(
    `SELECT label, freq, score, grade FROM severity
     WHERE "window"=? AND as_of=(SELECT MAX(as_of) FROM severity WHERE "window"=?)`,
    [window, window],
  )).fetchall();
  if (!last.length) return false;
  const a = new Set(last.map(key));
  const b = new Set(rows.map(key));
  return a.size === b.size && [...a].every((x) => b.has(x));
}

// ── 읽기 ──

/** 운영자 확인이 필요한 민원 수. review 는 심각도·알림·브리핑·조치요청서 인용에서 빠진다. */
export async function review_count(): Promise<number> {
  const conn = await connect();
  return (await conn.execute(
    `SELECT COUNT(*) c FROM classification c JOIN feedback f ON f.id = c.feedback_id
     WHERE c.status='review' AND ${LIVE_FEEDBACK_SQL}`)).fetchone()!.c;
}

/** 확인 필요 중 안전 의심(is_safety) 건수. */
export async function review_safety_count(): Promise<number> {
  const conn = await connect();
  return (await conn.execute(
    `SELECT COUNT(*) c FROM classification c JOIN feedback f ON f.id = c.feedback_id
     WHERE c.status='review' AND c.is_safety=1 AND ${LIVE_FEEDBACK_SQL}`)).fetchone()!.c;
}

export async function pending_count(): Promise<number> {
  const conn = await connect();
  return (await conn.execute(
    `SELECT COUNT(*) c FROM classification c JOIN feedback f ON f.id = c.feedback_id
     WHERE c.status='pending' AND ${LIVE_FEEDBACK_SQL}`)).fetchone()!.c;
}

/** 데이터 기준의 '현재'. 실시간에서는 실제 현재 시각, 리플레이 중에는 재생된 민원의 가장 최근 발생 시각. */
export async function data_now(): Promise<Date> {
  const conn = await connect();
  const row = (await conn.execute(
    `SELECT MAX(f.posted_at) t FROM feedback f
     JOIN classification c ON c.feedback_id = f.id
     WHERE c.status='done' AND f.deleted_at IS NULL`)).fetchone();
  if (row && row.t) {
    try {
      return fromisoformat(row.t);
    } catch {
      /* 잘못된 시각 문자열 → 현재 시각 */
    }
  }
  return new Date();
}

/** 지정 구간 내 분류 완료 민원. 심각도 계산의 입력. (review 는 제외) 창은 posted_at 기준. */
export async function window_rows(window_min: number): Promise<Row[]> {
  const since = isoformat(plus(await data_now(), -minutes(window_min)));
  const conn = await connect();
  return (await conn.execute(
    `SELECT c.label, c.sentiment, c.is_safety,
            f.id feedback_id, f.zone_id, f.raw_text,
            f.posted_at, f.ingested_at
     FROM classification c JOIN feedback f ON f.id = c.feedback_id
     WHERE c.status='done' AND f.posted_at >= ? AND f.deleted_at IS NULL`,
    [since],
  )).fetchall();
}

export const SYNTHETIC_SOURCES = ["replay", "demo", "dev"];      // 사람이 접수하지 않은 합성·재생 민원의 source 값

/** 집계 창 안에 합성·재생 민원이 있는지 — 관제 머리의 '합성 데이터' 표시용. */
export async function synthetic_in_window(window_min: number | null = null): Promise<{ on: boolean; count: number }> {
  const win = window_min || config.DEFAULT_WINDOW_MIN;
  const since = isoformat(plus(await data_now(), -minutes(win)));
  const marks = SYNTHETIC_SOURCES.map(() => "?").join(",");
  const conn = await connect();
  const n = (await conn.execute(
    `SELECT COUNT(*) AS n FROM feedback f WHERE f.deleted_at IS NULL AND f.posted_at >= ? AND f.source IN (${marks})`,
    [since, ...SYNTHETIC_SOURCES],
  )).fetchone()!.n;
  return { on: n > 0, count: n };
}

/** 심각도 순위. 창 조회 + 미조치 판정 + 기준시각을 한 번에 묶는다. */
export async function ranked(window_min: number | null = null): Promise<Row[]> {
  const win = window_min || config.DEFAULT_WINDOW_MIN;
  const rows = await window_rows(win);
  const ref = await data_now();
  const unhandled = new Map<string, boolean>();          // rank_labels 는 동기 콜백이라 미리 계산해 둔다
  for (const l of new Set(rows.map((r) => r.label as string))) {
    unhandled.set(l, await unhandled_over(l, config.PENDING_MINUTES));
  }
  return severity.rank_labels(rows, (l: string) => unhandled.get(l) ?? false, { ref });
}

export async function label_counts(window_min: number | null = null): Promise<Record<string, number>> {
  let sql = `SELECT c.label, COUNT(*) c FROM classification c
             JOIN feedback f ON f.id = c.feedback_id
             WHERE c.status='done' AND f.deleted_at IS NULL`;
  let params: unknown[] = [];
  if (window_min) {
    const since = isoformat(plus(await data_now(), -minutes(window_min)));
    sql += " AND f.posted_at >= ?";
    params = [since];
  }
  sql += " GROUP BY c.label ORDER BY c DESC";
  const conn = await connect();
  const out: Record<string, number> = {};
  for (const r of (await conn.execute(sql, params)).fetchall()) out[r.label] = r.c;
  return out;
}

export async function recent_feedback(limit = 15): Promise<Row[]> {
  const conn = await connect();
  return (await conn.execute(
    `SELECT f.id, f.raw_text, f.ingested_at, COALESCE(z.name, '${config.ZONE_UNKNOWN}') zone,
            c.label, c.sentiment, c.status
     FROM feedback f
     LEFT JOIN zone z ON z.id = f.zone_id
     LEFT JOIN classification c ON c.feedback_id = f.id
     WHERE f.deleted_at IS NULL
     ORDER BY f.id DESC LIMIT ?`,
    [limit],
  )).fetchall();
}

export async function recent_logs(limit = 20): Promise<Row[]> {
  const conn = await connect();
  return (await conn.execute("SELECT * FROM agent_log ORDER BY id DESC LIMIT ?", [limit])).fetchall();
}

// 조치요청서 상태: requested → in_progress → done (사람이 고름)
// superseded = 같은 유형의 새 요청서로 대체됨. 시스템만 쓰고, 열린 요청으로 세지 않는다.
export const OPEN_ACTION_SQL = "status IN ('requested','in_progress')";

/** 처리 현황용 목록. 대체된 요청서는 뺀다 (완료는 남긴다). */
export async function open_actions(): Promise<Row[]> {
  const conn = await connect();
  return (await conn.execute("SELECT * FROM action_request WHERE status != 'superseded' ORDER BY id DESC")).fetchall();
}

/** 유형별 가장 최근 조치요청서 (대체된 것 제외). 관제 카드의 조치 그룹에 쓴다. */
export async function latest_actions(): Promise<Record<string, Row>> {
  const conn = await connect();
  const rows = (await conn.execute(
    "SELECT id, label, status, created_at, closed_at FROM action_request WHERE status != 'superseded' ORDER BY id")).fetchall();
  const out: Record<string, Row> = {};
  for (const r of rows) out[r.label] = { ...r };      // 뒤(최신)가 앞을 덮어쓴다
  return out;
}

/** 유형별 가장 최근 요청서의 상태. 같은 유형 요청서가 여럿이면 최신이 이긴다. */
export async function latest_action_status(): Promise<Record<string, string>> {
  const conn = await connect();
  const rows = (await conn.execute(
    "SELECT label, status FROM action_request WHERE status != 'superseded' ORDER BY id")).fetchall();
  const out: Record<string, string> = {};
  for (const r of rows) out[r.label] = r.status;
  return out;
}

/** 해당 라벨에 조치요청이 없거나, 요청 후 N분이 지나도 미완료인가. (S-06) */
export async function unhandled_over(label: string, minutes_: number): Promise<boolean> {
  const cutoff = isoformat(plus(new Date(), -minutes(minutes_)));
  const conn = await connect();
  const row = (await conn.execute(
    `SELECT COUNT(*) c FROM action_request
     WHERE label=? AND status='done' AND created_at >= ?`, [label, cutoff])).fetchone()!;
  const first = (await conn.execute(
    `SELECT MIN(f.posted_at) t FROM classification c
     JOIN feedback f ON f.id=c.feedback_id
     WHERE c.label=? AND c.status='done' AND f.deleted_at IS NULL`, [label])).fetchone()!;
  if (row.c > 0 || first.t === null || first.t === undefined) return false;
  return first.t <= cutoff;
}

export async function cache_get(digest: string): Promise<Row | null> {
  const conn = await connect();
  const row = (await conn.execute("SELECT result FROM classify_cache WHERE hash=?", [digest])).fetchone();
  return row ? JSON.parse(row.result) : null;
}

export async function cache_put(digest: string, result: Row): Promise<void> {
  const conn = await connect();
  await conn.execute("INSERT OR REPLACE INTO classify_cache (hash, result) VALUES (?,?)", [digest, JSON.stringify(result)]);
}

// ── 웹 연동 ──

/** 웹 접수폼이 넣은 민원을 마스킹해 feedback 으로 옮긴다. 옮긴 건수. (insert_feedback 을 반드시 거친다) */
export async function pull_inbox(limit = 50): Promise<number> {
  const conn = await connect();
  const rows = (await conn.execute(
    "SELECT id, zone_id, text, COALESCE(dup_count, 0) dup_count FROM feedback_inbox WHERE feedback_id IS NULL ORDER BY id LIMIT ?",
    [limit])).fetchall();
  let moved = 0;
  for (const r of rows) {
    const fid = await insert_feedback(r.zone_id, r.text ?? "", "qr");
    // 원문은 지우고 접수번호만 남긴다. 중복이면 -1.
    await conn.execute("UPDATE feedback_inbox SET feedback_id=?, text=NULL WHERE id=?", [fid !== null ? fid : -1, r.id]);
    if (fid !== null && r.dup_count) {                     // 옮기기 전에 합쳐진 횟수를 이어 준다
      await conn.execute("UPDATE feedback SET dup_count=? WHERE id=?", [r.dup_count, fid]);
    }
    if (fid !== null) moved += 1;
  }
  return moved;
}

/** 조치요청서 생성 요청을 큐에 넣는다. 같은 유형이 이미 대기·작성 중이면 그 번호. */
export async function request_doc_job(label: string): Promise<number> {
  const conn = await connect();
  const busy = (await conn.execute(
    "SELECT id FROM doc_job WHERE label=? AND status IN ('queued','running') LIMIT 1", [label])).fetchone();
  if (busy) return busy.id;
  const cur = await conn.execute("INSERT INTO doc_job (label, created_at) VALUES (?,?)", [label, now()]);
  return cur.lastrowid as number;
}

/** 유형별 가장 최근 요청서 생성 요청의 상태 (queued|running|done|failed). */
export async function doc_job_states(): Promise<Record<string, Row>> {
  const conn = await connect();
  const rows = (await conn.execute("SELECT id, label, status, error, created_at FROM doc_job ORDER BY id")).fetchall();
  const out: Record<string, Row> = {};
  for (const r of rows) out[r.label] = { ...r };           // 최신이 덮어쓴다
  return out;
}

/** 대기 중인 조치요청서 생성 요청을 집는다. */
export async function claim_doc_jobs(limit = 2): Promise<Row[]> {
  const conn = await connect();
  const rows = (await conn.execute("SELECT id, label FROM doc_job WHERE status='queued' ORDER BY id LIMIT ?", [limit])).fetchall();
  for (const r of rows) await conn.execute("UPDATE doc_job SET status='running' WHERE id=?", [r.id]);
  return rows.map((r) => ({ ...r }));
}

export async function finish_doc_job(job_id: number, action_id: number | null, error = ""): Promise<void> {
  const conn = await connect();
  await conn.execute(
    "UPDATE doc_job SET status=?, action_request_id=?, error=?, finished_at=? WHERE id=?",
    [error ? "failed" : "done", action_id, error.slice(0, 300) || null, now(), job_id],
  );
}
