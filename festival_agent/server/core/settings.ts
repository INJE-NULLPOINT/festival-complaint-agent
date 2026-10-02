// 운영자 설정 — 축제 이름·지역·기간, 구역 목록(이름 변경·숨김), 유형별 담당 부서·연락처. (신규, D5-90)
//
// 읽기: DB 표(festival · zone · department_map)가 원천이다. config 값은 **DB 가 비었을 때의 기본값**일 뿐이다 (init_db 가 처음 한 번만 시드).
//   짧게(5초) 캐시한다 — 워커·웹 서버가 따로 떠 있어도 5초 안에 바뀐 설정을 본다. 쓰기는 이 프로세스의 캐시를 바로 비운다.
// 쓰기(운영자 코드 필요 — webapi 가 admin.verify, Supabase 는 schema.sql 의 RPC 가 admin_gate): save_festival · add_zone · rename_zone · set_zone_hidden · save_department.
//   구역은 지우지 않는다(민원이 달려 있다) — 이름 변경·숨김만. 연락처는 형식(숫자와 하이픈)을 검사한다.
// 기본 연락처(055-000-000x)인 동안에는 화면이 '(예시 번호)'를 붙이도록 is_example=true 를 내려 준다.
import { config } from "./config.ts";
import * as db from "./db.ts";
import { ValueError } from "./errors.ts";

export type Row = Record<string, any>;

export const TTL_MS = 5000;
const _cache = new Map<string, { at: number; v: unknown }>();

export function invalidate(): void {
  _cache.clear();
}

async function cached<T>(name: string, load: () => Promise<T>): Promise<T> {
  const key = `${db.is_pg() ? "pg" : config.DB_PATH}|${name}`;       // 테스트가 DB 를 바꿔도 다른 DB 의 값을 쓰지 않게
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const v = await load();
  _cache.set(key, { at: Date.now(), v });
  return v;
}

// ── 연락처 ──
/** 숫자와 하이픈만, 숫자로 시작·끝, 하이픈은 연달아 쓰지 않음, 숫자 3~20개 (예: 055-000-0001 · 1577-1234 · 119). */
export const CONTACT_RE = /^\d(?:-?\d){2,19}$/;
export const valid_contact = (s: unknown): boolean => typeof s === "string" && CONTACT_RE.test(s.trim());
/** 처음 넣어 둔 예시 번호(055-000-000x)인가 — 화면이 '(예시 번호)'를 붙인다. */
export const is_example = (contact: unknown): boolean => /^055-000-000\d$/.test(String(contact ?? ""));

// ── 읽기 ──
/** 유형 → [부서, 연락처]. DB 행이 있으면 그것, 없는 유형은 config 기본값. */
export async function department_map(): Promise<Record<string, [string, string]>> {
  return cached("dept", async () => {
    const out: Record<string, [string, string]> = {};
    for (const [k, v] of Object.entries(config.DEPARTMENT_MAP)) out[k] = [v[0], v[1]];
    const conn = await db.connect();
    for (const r of (await conn.execute("SELECT label, department, contact FROM department_map")).fetchall()) {
      if (r.label in config.LABELS && r.department) out[r.label] = [String(r.department), String(r.contact ?? "-")];
    }
    return out;
  });
}

export async function festival(): Promise<{ id: number | null; name: string; region: string; start_date: string; end_date: string }> {
  return cached("festival", async () => {
    const conn = await db.connect();
    const r = (await conn.execute("SELECT id, name, region, start_date, end_date FROM festival ORDER BY id LIMIT 1")).fetchone();
    const f = config.FESTIVAL;
    return {
      id: r ? Number(r.id) : null, name: r?.name || f.name, region: r?.region ?? f.region,
      start_date: r?.start_date ?? f.start_date, end_date: r?.end_date ?? f.end_date,
    };
  });
}

/** 구역 행. feedback_count = 달린 민원 수(지운 것 제외), hidden = 0/1. */
export async function zone_rows(): Promise<Array<{ id: number; name: string; hidden: number; feedback_count: number }>> {
  return cached("zones", async () => {
    const conn = await db.connect();
    const rows = (await conn.execute(
      `SELECT z.id, z.name, COALESCE(z.hidden, 0) hidden,
              (SELECT COUNT(*) FROM feedback f WHERE f.zone_id = z.id AND f.deleted_at IS NULL) n
       FROM zone z ORDER BY z.id`)).fetchall();
    if (!rows.length) return config.ZONES.map((name, i) => ({ id: -(i + 1), name, hidden: 0, feedback_count: 0 }));
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name), hidden: Number(Boolean(r.hidden)), feedback_count: Number(r.n) }));
  });
}

/** 방문객·에이전트에게 보이는 구역 이름 (숨긴 구역 제외). */
export async function zone_names(): Promise<string[]> {
  return (await zone_rows()).filter((z) => !z.hidden).map((z) => z.name);
}
/** 숨긴 것까지 모든 구역 이름 (카드 문구 검사 — 다른 구역 이름 금지 — 용). */
export async function all_zone_names(): Promise<string[]> {
  return (await zone_rows()).map((z) => z.name);
}

/** 설정 화면용 한 덩어리 (읽기 전용, 공개). departments[].is_example 은 기본 연락처인 동안 true. */
export async function get_settings(): Promise<Row> {
  const dm = await department_map();
  const departments = Object.keys(config.DEPARTMENT_MAP).map((label) => ({
    label, label_ko: config.LABELS[label] ?? label, department: dm[label][0], contact: dm[label][1], is_example: is_example(dm[label][1]),
  }));
  return { festival: await festival(), zones: await zone_rows(), departments };
}

// ── 쓰기 (운영자 코드 검사는 호출하는 쪽) ──
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (s: unknown, max: number, what: string): string => {
  const v = typeof s === "string" ? s.trim() : "";
  if (!v) throw new ValueError(`${what}을(를) 입력해 주세요`);
  if ([...v].length > max) throw new ValueError(`${what}은(는) ${max}자 이내로 적어 주세요`);
  if (/[\u0000-\u001f<>]/.test(v)) throw new ValueError(`${what}에 쓸 수 없는 문자가 있습니다`);
  return v;
};

export async function save_festival(p_name: unknown, p_region: unknown, p_start_date: unknown, p_end_date: unknown): Promise<Row> {
  const name = clean(p_name, 40, "축제 이름");
  const region = clean(p_region, 40, "지역");
  const sd = String(p_start_date ?? "").trim(), ed = String(p_end_date ?? "").trim();
  if (!DATE_RE.test(sd) || !DATE_RE.test(ed) || Number.isNaN(Date.parse(sd)) || Number.isNaN(Date.parse(ed))) throw new ValueError("기간은 YYYY-MM-DD 형식으로 적어 주세요");
  if (ed < sd) throw new ValueError("끝나는 날이 시작하는 날보다 빠를 수 없습니다");
  const conn = await db.connect();
  const cur = (await conn.execute("SELECT id FROM festival ORDER BY id LIMIT 1")).fetchone();
  if (cur) await conn.execute("UPDATE festival SET name=?, region=?, start_date=?, end_date=? WHERE id=?", [name, region, sd, ed, cur.id]);
  else await conn.execute("INSERT INTO festival (name, region, start_date, end_date) VALUES (?,?,?,?)", [name, region, sd, ed]);
  invalidate();
  return { ok: true, festival: await festival() };
}

/** 구역 이름을 정리하고 같은 이름이 있는지 본다 (exclude_id 는 자기 자신). */
async function checked_zone_name(p_name: unknown, exclude_id: number | null): Promise<string> {
  const name = clean(p_name, 30, "구역 이름");
  const conn = await db.connect();
  const same = (await conn.execute("SELECT id FROM zone WHERE name=?", [name])).fetchone();
  if (same && Number(same.id) !== exclude_id) throw new ValueError("같은 이름의 구역이 이미 있습니다");
  return name;
}
async function zone_id_of(p_id: unknown): Promise<number> {
  const id = Math.trunc(Number(p_id));
  const conn = await db.connect();
  if (!Number.isFinite(id) || !(await conn.execute("SELECT id FROM zone WHERE id=?", [id])).fetchone()) throw new ValueError("없는 구역입니다");
  return id;
}

/** 구역 추가. 새 id 를 돌려준다. */
export async function add_zone(p_name: unknown): Promise<Row> {
  const name = await checked_zone_name(p_name, null);
  const conn = await db.connect();
  const id = Number((await conn.execute("INSERT INTO zone (festival_id, name) VALUES (?,?)", [await db.festival_id(), name])).lastrowid);
  invalidate();
  return { ok: true, id };
}

export async function rename_zone(p_id: unknown, p_name: unknown): Promise<Row> {
  const id = await zone_id_of(p_id);
  const name = await checked_zone_name(p_name, id);
  const conn = await db.connect();
  await conn.execute("UPDATE zone SET name=? WHERE id=?", [name, id]);
  invalidate();
  return { ok: true, id };
}

/** 숨김/보이기. 지우는 기능은 없다 — 민원이 달린 구역이 사라지면 집계가 깨진다. 숨긴 구역은 방문객 구역 선택에서만 빠진다. */
export async function set_zone_hidden(p_id: unknown, p_hidden: unknown): Promise<Row> {
  const id = await zone_id_of(p_id);
  const conn = await db.connect();
  await conn.execute("UPDATE zone SET hidden=? WHERE id=?", [Number(Boolean(p_hidden)), id]);
  invalidate();
  return { ok: true, id, hidden: Number(Boolean(p_hidden)) };
}

export async function save_department(p_label: unknown, p_department: unknown, p_contact: unknown): Promise<Row> {
  const label = String(p_label ?? "");
  if (!(label in config.DEPARTMENT_MAP)) throw new ValueError(`부서를 정할 수 없는 유형입니다: ${label}`);
  const dept = clean(p_department, 30, "담당 부서");
  const contact = String(p_contact ?? "").trim();
  if (!valid_contact(contact)) throw new ValueError("연락처는 숫자와 하이픈만 써 주세요 (예: 055-123-4567)");
  const conn = await db.connect();
  await conn.execute("INSERT OR REPLACE INTO department_map (label, department, contact) VALUES (?,?,?)", [label, dept, contact]);
  invalidate();
  return { ok: true, departments: (await get_settings()).departments };
}
