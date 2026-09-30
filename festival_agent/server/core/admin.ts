// 운영자 코드 검사 (D5-31) — 관리자 동작을 방문객이 못 쓰게 막는다. (core/admin.py 와 1:1)
//
// 로그인이 없어서 민원 지우기·되돌리기, 조치 상태 변경, 조치요청서 생성이 주소만 알면 누구에게나 열려 있었다.
// 방문객이 쓰는 것은 접수(submit_feedback) 하나뿐이다. 그래서 관리자 동작 네 가지는 **운영자 코드**가 맞을 때만 실행한다.
//   local 대역(webapi.ts)이 이 모듈을 쓴다. 코드는 .env 의 ADMIN_CODE (사람이 직접 넣는다).
//   Supabase 는 schema.sql 의 operator_secret(해시)·admin_gate() 가 같은 규칙으로 검사한다.
//
// 규칙 (두 대역 공통)
//   · 코드가 설정돼 있지 않으면(ADMIN_CODE 비어 있음) 관리자 동작을 전부 거부한다 — 열린 채로 시작하지 않는다.
//   · 코드를 안 보냈으면 거부. 틀린 코드는 거부하고 실패로 센다. 코드를 안 보낸 요청은 실패로 세지 않는다.
//   · 최근 10분에 **같은 출처에서** 5번 틀리면 그 출처는 10분 안에는 맞는 코드도 거부한다 (무차별 대입 방지).
//     맞는 코드를 넣으면 **그 출처의** 기록만 비운다. 출처는 접속 주소의 하루짜리 해시(core/source_id.ts)라서,
//     방문객이 틀린 코드를 몇 번 보내도 다른 출처의 운영자는 잠기지 않는다 (D5-40).
//     접속 주소를 알 수 없으면(source 없음) 예전처럼 전체가 한 출처로 묶인다.
//   · 비교는 timingSafeEqual 로 한다 (시간차 공격 방지).
//
// 한계: 공유 코드라 누가 했는지는 구분하지 못한다. 코드가 새면 바꿔야 한다.
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import * as db from "./db.ts";
import { hours, kst_stamp, minutes, plus } from "./datetime.ts";

export const WINDOW_MIN = 10;
export const MAX_FAIL = 5;

export const MSG_NEED = "운영자 코드가 필요합니다";
export const MSG_LOCKED = "시도가 너무 많습니다. 10분 뒤에 다시 시도하세요";

/** 관리자 동작 거부. status 는 HTTP 상태 (401 코드 없음·틀림 / 403 코드 미설정 / 429 잠김). */
export class AdminError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminError";
    this.status = status;
  }
}

export const KEEP_HOURS = 24;            // 실패 기록(출처 해시 포함)은 하루가 지나면 지운다

export async function recent_failures(source: string | null = null): Promise<number> {
  const cutoff = kst_stamp(plus(new Date(), -minutes(WINDOW_MIN)));
  const conn = await db.connect();
  return (await conn.execute("SELECT COUNT(*) c FROM admin_attempt WHERE at >= ? AND COALESCE(src, '') = ?",
    [cutoff, source || ""])).fetchone()!.c;
}

export async function _purge_old(): Promise<void> {
  const cutoff = kst_stamp(plus(new Date(), -hours(KEEP_HOURS)));
  const conn = await db.connect();
  await conn.execute("DELETE FROM admin_attempt WHERE at < ?", [cutoff]);
  await conn.commit();
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 운영자 코드가 맞으면 조용히 끝나고, 아니면 AdminError 를 던진다. source = 출처 해시(없으면 전체 공용). */
export async function verify(code: unknown, source: string | null = null): Promise<void> {
  const expected = config.ADMIN_CODE;
  if (!expected) throw new AdminError(MSG_NEED, 403);                 // 코드를 안 정했으면 전부 거부
  const src = source || "";
  if ((await recent_failures(src)) >= MAX_FAIL) throw new AdminError(MSG_LOCKED, 429);   // 잠금 중에는 맞는 코드도 거부
  if (typeof code !== "string" || !code) throw new AdminError(MSG_NEED, 401);
  const conn = await db.connect();
  if (same(code, expected)) {
    await conn.execute("DELETE FROM admin_attempt WHERE COALESCE(src, '') = ?", [src]);   // 이 출처의 기록만
    await conn.commit();
    await _purge_old();
    return;
  }
  await conn.execute("INSERT INTO admin_attempt (at, src) VALUES (?, ?)", [kst_stamp(new Date()), src]);
  await conn.commit();
  await _purge_old();
  throw new AdminError(MSG_NEED, 401);
}
