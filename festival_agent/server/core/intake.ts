// 접수 도배 방지 (D5-33) — '양으로는 막지 않고, 같은 글과 기계적 폭주만 막는다'. (core/intake.py 와 1:1)
//
// 이 시스템의 핵심 신호는 '한 구역에 민원이 몰림'(급증·S-04)이다. 구역·양으로 막으면 진짜 인파 사고 때 신고를 스스로 자르게 된다.
// 그래서 막는 것은 두 가지뿐이고, 구역 몰림은 막지 않고 표시만 한다.
//
//   ① 같은 글 합치기  같은 구역 + 정규화한 본문(공백·기호 제거, 소문자)이 최근 2분 안에 이미 접수됐으면 새로 넣지 않고
//                     성공처럼 응답한다. 합친 횟수는 dup_count 로 남긴다.
//   ② 출처별 폭주 제한 접속 주소(IP)의 하루짜리 해시(core/source_id.ts)별로 1분 10건 · 10분 30건을 넘으면 거절한다.
//                     원문 IP 는 저장하지 않는다. submit_rate(해시, 시각) 표에만 두고 24시간 뒤 지우며, 민원 행과는 연결하지 않는다.
//                     출처를 알 수 없으면(IP 없음) ②는 건너뛴다.
//   ③ 구역 몰림 표시  같은 구역에 1분 안에 20건 이상이면 zone_burst() 가 알려 준다. 심각도 계산은 그대로다.
//
// 켜고 끄기: config.DEDUP_ENABLED · config.SUBMIT_LIMIT_ENABLED. 숫자는 전부 설계값.
import { config } from "./config.ts";
import * as db from "./db.ts";
import { hours, kst_stamp, plus, seconds } from "./datetime.ts";
import * as privacy from "./privacy.ts";

export type Row = Record<string, any>;

export const MSG_RATE = "잠시 후 다시 보내 주세요";          // 한도 숫자·기준은 알려 주지 않는다

/** 출처별 폭주 제한에 걸림. */
export class RateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimited";
  }
}

// 같은 글이 거의 동시에 두 번 와도 한 건으로 합치려면 '찾기 → 넣기'가 한 덩어리여야 한다 (프로세스 안의 뮤텍스)
let _tail: Promise<unknown> = Promise.resolve();
async function withSubmitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _tail.then(fn, fn);
  _tail = run.catch(() => undefined);
  return run;
}

/** 같은 글 판정용 정규화 — 개인정보 마스킹 뒤 공백·기호를 지우고 소문자로. */
export function normalize(text: string): string {
  return privacy.mask(text || "").toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
}

export const _stamp = kst_stamp;

export function seoul_now(): Date {
  return new Date();
}

/** 최근 DEDUP_WINDOW_SEC 안에 같은 구역·같은 글이 있으면 합치고(dup_count+1) 접수번호를 돌려준다. 없으면 null. */
export async function find_duplicate(zone_id: number | null, text: string, now: Date | null = null): Promise<number | null> {
  if (!config.DEDUP_ENABLED) return null;
  const norm = normalize(text);
  if (!norm) return null;
  const cutoff = _stamp(plus(now ?? seoul_now(), -seconds(config.DEDUP_WINDOW_SEC)));
  const conn = await db.connect();
  // ① 아직 접수함에 원문이 남아 있는 것
  const [zsql, zarg] = zone_id !== null && zone_id !== undefined ? ["zone_id = ?", [zone_id]] : ["zone_id IS NULL", []];
  for (const r of (await conn.execute(
    `SELECT id, text FROM feedback_inbox WHERE ${zsql} AND created_at >= ? AND text IS NOT NULL ORDER BY id DESC`,
    [...zarg, cutoff])).fetchall()) {
    if (normalize(r.text) === norm) {
      await conn.execute("UPDATE feedback_inbox SET dup_count = COALESCE(dup_count, 0) + 1 WHERE id=?", [r.id]);
      await conn.commit();
      return r.id;
    }
  }
  // ② 워커가 이미 옮긴 것 (원문은 마스킹본)
  for (const r of (await conn.execute(
    `SELECT f.id, f.raw_text FROM feedback f WHERE f.${zsql} AND f.ingested_at >= ? AND ${db.LIVE_FEEDBACK_SQL} ORDER BY f.id DESC`,
    [...zarg, cutoff])).fetchall()) {
    if (normalize(r.raw_text) === norm) {
      await conn.execute("UPDATE feedback SET dup_count = COALESCE(dup_count, 0) + 1 WHERE id=?", [r.id]);
      const receipt = (await conn.execute("SELECT MAX(id) m FROM feedback_inbox WHERE feedback_id=?", [r.id])).fetchone()!.m;
      await conn.commit();
      return receipt || r.id;
    }
  }
  return null;
}

/** 출처별 폭주 제한. 넘으면 RateLimited. 통과하면 이번 시도를 기록한다. 출처를 모르면 건너뛴다. */
export async function check_rate(src: string | null, now: Date | null = null): Promise<void> {
  if (!config.SUBMIT_LIMIT_ENABLED || !src) return;
  const t = now ?? seoul_now();
  const conn = await db.connect();
  await conn.execute("DELETE FROM submit_rate WHERE at < ?", [_stamp(plus(t, -hours(24)))]);     // 24시간 뒤 삭제
  for (const [sec, limit] of config.SUBMIT_LIMITS) {
    const n = (await conn.execute("SELECT COUNT(*) c FROM submit_rate WHERE src=? AND at >= ?",
      [src, _stamp(plus(t, -seconds(sec)))])).fetchone()!.c;
    if (n >= limit) {
      await conn.commit();
      throw new RateLimited(MSG_RATE);
    }
  }
  await conn.execute("INSERT INTO submit_rate (src, at) VALUES (?, ?)", [src, _stamp(t)]);
  await conn.commit();
}

/**
 * 접수 한 건을 받는다 — ②출처별 제한 → ①같은 글 합치기 → 저장을 한 덩어리로(프로세스 안에서 락).
 * feedback_inbox 에 넣고 접수번호(inbox id)를 돌려준다 (워커가 마스킹해 옮긴다).
 * 합쳐진 글은 같은 번호를 돌려준다(성공처럼). 제한에 걸리면 RateLimited.
 */
export async function accept(zone_id: number | null, text: string, source: string | null = null): Promise<number> {
  // 프로세스 안은 뮤텍스로, **프로세스 사이는 BEGIN IMMEDIATE 트랜잭션**으로 묶는다 (워커·웹이 따로 떠도 같은 글은 한 건).
  // SQLite 는 쓰기 잠금을 먼저 잡고 '찾기 → 넣기/합치기'를 하므로 다른 연결은 busy_timeout 동안 기다린다.
  return withSubmitLock(() => db.transaction(async (conn) => {
    await check_rate(source);
    const dup = await find_duplicate(zone_id, text);
    if (dup !== null) return dup;
    const cur = await conn.execute("INSERT INTO feedback_inbox (zone_id, text, created_at) VALUES (?,?,?)",
      [zone_id, text.replace(/^ +| +$/g, ""), _stamp(seoul_now())]);
    return cur.lastrowid as number;
  }));
}

/** 24시간 지난 출처 기록(submit_rate)과 운영자 코드 실패 기록(admin_attempt)을 지운다. 워커가 주기적으로 부른다. */
export async function purge_old(now: Date | null = null): Promise<number> {
  const cutoff = _stamp(plus(now ?? seoul_now(), -hours(24)));
  const conn = await db.connect();
  let n = (await conn.execute("DELETE FROM submit_rate WHERE at < ?", [cutoff])).rowcount;
  n += (await conn.execute("DELETE FROM admin_attempt WHERE at < ?", [cutoff])).rowcount;
  await conn.commit();
  return n;
}

/** 최근 window_sec 안에 min_count 건 이상 접수가 몰린 구역 — 차단하지 않고 표시만 한다 (심각도는 그대로). */
export async function zone_burst(window_sec: number | null = null, min_count: number | null = null, now: Date | null = null): Promise<Row[]> {
  const wsec = window_sec || config.CROWD_FLAG_SEC;
  const min = min_count || config.CROWD_FLAG_MIN;
  const cutoff = _stamp(plus(now ?? seoul_now(), -seconds(wsec)));
  const conn = await db.connect();
  const rows = (await conn.execute(
    `SELECT z.id zone_id, z.name zone, COUNT(*) n FROM feedback_inbox i
     JOIN zone z ON z.id = i.zone_id WHERE i.created_at >= ? GROUP BY z.id, z.name
     HAVING COUNT(*) >= ? ORDER BY n DESC`, [cutoff, min])).fetchall();
  return rows.map((r) => ({ zone_id: r.zone_id, zone: r.zone, count: r.n, window_sec: wsec }));
}
