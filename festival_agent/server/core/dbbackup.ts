// 운영 DB(Supabase) 백업·복원 — 테이블을 JSON 한 파일로 떠서 backup/supabase_*.json 에 둔다. (신규, Python 원본 없음)
//
// - snapshot_supabase()  운영 Supabase 를 **읽기 전용** 트랜잭션(REPEATABLE READ READ ONLY)으로 한 시점에 읽는다. 쓰지 않는다.
// - save_backup()        snapshot → backup/supabase_YYYYmmdd_HHMMSS_ffffff.json, 최근 keep 개만 남긴다 (supabase_ 로 시작하는 것만 지운다).
// - read_backup()        파일을 읽고 모양을 검사한다.
// - restore()            지금 연결된 DB(config 가 가리키는 곳)의 백업 대상 테이블을 파일 내용으로 **바꾼다** (한 트랜잭션).
//                        운영 Supabase 면 cli 가 --live-db 와 확인 질문을 요구하고, 복원 직전 상태를 before_restore_*.json 으로 먼저 저장한다.
//
// 제외: operator_secret (운영자 코드 해시 — 파일에 남기지 않는다), admin_attempt·submit_rate (출처 해시·잠금 기록, 24시간짜리 임시 데이터).
// 파일 모양: { format, version, source, created_at, tables: { 이름: { columns: [...], rows: [[...], ...] } } }
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import * as db from "./db.ts";
import { isoformat } from "./datetime.ts";
import { paths, stamp } from "./procguard.ts";

export const FORMAT = "festival_agent_backup";
export const VERSION = 1;
export const PREFIX = "supabase_";                 // 자동 백업 (최근 keep 개만 남긴다)
export const BEFORE_RESTORE_PREFIX = "before_restore_";   // 복원 직전 저장본 (자동으로 지우지 않는다)

/** 백업 대상. 부모가 앞에 온다 (넣을 때 이 순서, 지울 때 반대 순서 — 외래키 때문). operator_secret 은 없다. */
export const BACKUP_TABLES = [
  "festival", "zone", "department_map", "feedback", "classification", "severity", "alert",
  "action_request", "doc_job", "agent_task", "agent_log", "briefing", "issue", "classify_cache",
  "replay_state", "festival_info", "feedback_inbox",
] as const;
export const EXCLUDED_TABLES = ["operator_secret", "admin_attempt", "submit_rate"] as const;

export interface TableDump { columns: string[]; rows: unknown[][] }
export interface BackupFile {
  format: string; version: number; source: string; created_at: string;
  tables: Record<string, TableDump>;
}

const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const has_id = (t: string): boolean => t !== "department_map" && t !== "classification" && t !== "classify_cache" && t !== "festival_info";

// ── 읽기 (Supabase, 읽기 전용) ──────────────────────────────────────────
export async function snapshot_supabase(): Promise<BackupFile> {
  if (!db.is_pg()) throw new Error("SUPABASE_DB_URL 이 없습니다 (Supabase 백업 대상 아님)");
  const client = new pg.Client(db.pg_client_config());
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");      // 모든 테이블을 같은 시점으로, 쓰기는 DB 가 막는다
    const have = new Set((await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)",
      [[...BACKUP_TABLES]])).rows.map((r) => r.table_name as string));
    const tables: Record<string, TableDump> = {};
    for (const t of BACKUP_TABLES) {
      if (!have.has(t)) continue;                                               // 아직 만들지 않은 테이블은 건너뛴다
      const res = await client.query({ text: `SELECT * FROM ${q(t)} ORDER BY 1`, rowMode: "array" });
      tables[t] = { columns: res.fields.map((f) => f.name), rows: res.rows as unknown[][] };
    }
    await client.query("ROLLBACK");
    return { format: FORMAT, version: VERSION, source: "supabase", created_at: isoformat(new Date()), tables };
  } finally {
    await client.end();
  }
}

/** 파일로 저장 (임시 파일에 쓴 뒤 이름을 바꾼다 — 쓰다 끊겨도 반쪽 파일이 남지 않는다). */
export function write_backup(bf: BackupFile, prefix: string, dest_dir: string | null = null): string {
  const dir = dest_dir ?? paths.BACKUP_DIR;
  mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, `${prefix}${stamp(new Date())}.json`);
  while (existsSync(dest)) dest = dest.replace(/\.json$/, "_x.json");
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify(bf), "utf8");
  renameSync(tmp, dest);
  return dest;
}

export function prune(keep: number, dir: string | null = null, prefix = PREFIX): void {
  const d = dir ?? paths.BACKUP_DIR;
  const old = readdirSync(d).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort().reverse();
  for (const f of old.slice(Math.max(keep, 1))) {
    try { unlinkSync(path.join(d, f)); } catch { /* 지우기 실패는 무시 */ }
  }
}

/** 운영 Supabase 를 읽어 backup/supabase_*.json 으로 저장하고 최근 keep 개만 남긴다. 저장한 경로를 돌려준다. */
export async function save_backup(keep = 12, opts: { dest_dir?: string | null } = {}): Promise<string> {
  const dest = write_backup(await snapshot_supabase(), PREFIX, opts.dest_dir ?? null);
  prune(keep, opts.dest_dir ?? null);
  return dest;
}

// ── 읽기 (파일) ─────────────────────────────────────────────────────────
export function read_backup(file: string): BackupFile {
  let bf: BackupFile;
  try {
    bf = JSON.parse(readFileSync(file, "utf8")) as BackupFile;
  } catch (e) {
    throw new Error(`백업 파일을 읽을 수 없습니다: ${(e as Error).message}`);
  }
  if (bf?.format !== FORMAT || bf.version !== VERSION || typeof bf.tables !== "object" || bf.tables === null) {
    throw new Error(`festival_agent 백업 파일이 아닙니다 (format=${String(bf?.format)}, version=${String(bf?.version)})`);
  }
  for (const [t, d] of Object.entries(bf.tables)) {
    if (!(BACKUP_TABLES as readonly string[]).includes(t)) throw new Error(`백업 대상이 아닌 테이블이 들어 있습니다: ${t}`);
    if (!Array.isArray(d?.columns) || !Array.isArray(d.rows) || d.rows.some((r) => !Array.isArray(r) || r.length !== d.columns.length)) {
      throw new Error(`테이블 모양이 잘못됐습니다: ${t}`);
    }
  }
  return bf;
}

export function summarize(bf: BackupFile): Record<string, number> {
  return Object.fromEntries(Object.entries(bf.tables).map(([t, d]) => [t, d.rows.length]));
}

// ── 복원 ────────────────────────────────────────────────────────────────
/** 지금 연결된 DB 의 행 수 (없는 테이블은 null). */
export async function current_counts(): Promise<Record<string, number | null>> {
  const conn = await db.connect();
  const out: Record<string, number | null> = {};
  for (const t of BACKUP_TABLES) {
    try {
      out[t] = Number((await conn.execute(`SELECT COUNT(*) c FROM ${q(t)}`)).fetchone()!.c);
    } catch {
      out[t] = null;
    }
  }
  return out;
}

/** 쓰는 쪽을 한 모양으로 (SQLite 는 db.transaction, Postgres 는 전용 연결의 BEGIN/COMMIT). */
interface Writer {
  columns(t: string): Promise<Set<string>>;
  exec(sql: string, params?: unknown[]): Promise<void>;
  fix_sequence(t: string): Promise<void>;
}

const chunk_rows = (ncols: number): number => Math.max(1, Math.min(500, Math.floor(30000 / Math.max(ncols, 1))));

async function apply(w: Writer, bf: BackupFile, ph: (n: number) => string): Promise<Record<string, number>> {
  const present: string[] = [];
  const skipped: string[] = [];
  for (const t of BACKUP_TABLES) {
    if (!(await w.columns(t)).size) { if (bf.tables[t]) skipped.push(t); continue; }
    present.push(t);
  }
  if (skipped.length) throw new Error(`복원할 DB 에 없는 테이블이 있습니다: ${skipped.join(", ")} (스키마를 먼저 만드세요)`);
  // 지우기: 자식 → 부모. 파일에 없는 테이블은 건드리지 않는다.
  for (const t of [...BACKUP_TABLES].reverse()) {
    if (bf.tables[t] && present.includes(t)) await w.exec(`DELETE FROM ${q(t)}`);
  }
  const done: Record<string, number> = {};
  for (const t of BACKUP_TABLES) {
    const d = bf.tables[t];
    if (!d || !present.includes(t)) continue;
    const target = await w.columns(t);
    const idx = d.columns.map((c, i) => [c, i] as const).filter(([c]) => target.has(c));   // 대상에 없는 열은 버린다 (스키마가 달라졌을 때)
    const cols = idx.map(([c]) => q(c)).join(", ");
    const step = chunk_rows(idx.length);
    for (let i = 0; i < d.rows.length; i += step) {
      const part = d.rows.slice(i, i + step);
      const values = part.map((_, r) => `(${idx.map((_, c) => ph(r * idx.length + c + 1)).join(", ")})`).join(", ");
      await w.exec(`INSERT INTO ${q(t)} (${cols}) VALUES ${values}`, part.flatMap((row) => idx.map(([, k]) => row[k])));
    }
    if (has_id(t) && d.rows.length) await w.fix_sequence(t);
    done[t] = d.rows.length;
  }
  return done;
}

/** 지금 연결된 DB 를 파일 내용으로 바꾼다. 한 트랜잭션이라 중간에 실패하면 원래대로 돌아간다. 테이블별 복원 행 수를 돌려준다. */
export async function restore(bf: BackupFile): Promise<Record<string, number>> {
  if (db.is_pg()) {
    const client = new pg.Client(db.pg_client_config());
    await client.connect();
    try {
      await client.query("BEGIN");
      const w: Writer = {
        async columns(t) {
          const r = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [t]);
          return new Set(r.rows.map((x) => x.column_name as string));
        },
        async exec(sql, params = []) { await client.query(sql, params.length ? params.map((v) => (v === undefined ? null : v)) : undefined); },
        async fix_sequence(t) {
          await client.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${q(t)}), 0) + 1, false)`, [`public.${t}`]);
        },
      };
      const done = await apply(w, bf, (n) => `$${n}`);
      await client.query("COMMIT");
      return done;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* 연결이 이미 끊김 */ }
      throw e;
    } finally {
      await client.end();
    }
  }
  return db.transaction(async (conn) => {
    const w: Writer = {
      async columns(t) { return new Set((await conn.execute(`PRAGMA table_info(${q(t)})`)).rows.map((r) => r.name as string)); },
      async exec(sql, params = []) { await conn.execute(sql, params); },
      async fix_sequence() { /* INTEGER PRIMARY KEY 는 최대 id + 1 로 이어진다 */ },
    };
    return apply(w, bf, () => "?");
  });
}
