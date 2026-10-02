// Python datetime 의 필요한 부분만 (naive 지역 시각, isoformat(timespec="seconds")). core/db.py·severity.py 등이 쓴다.
const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** datetime.now().isoformat(timespec="seconds") — 지역 시각, 시간대 표기 없음 */
export function isoformat(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** datetime.fromisoformat(s) — 시간대 표기가 없으면 지역 시각으로 읽는다. 잘못된 문자열은 Error */
export function fromisoformat(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(s.trim());
  if (!m) throw new Error(`Invalid isoformat string: '${s}'`);
  if (m[8]) return new Date(s.trim().replace(" ", "T"));
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7] ? Math.floor(+`0.${m[7]}` * 1000) : 0);
}

export const minutes = (n: number): number => n * 60_000;
export const seconds = (n: number): number => n * 1000;
export const hours = (n: number): number => n * 3_600_000;

/** dt ± timedelta */
export const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

/** datetime.now() */
export const now_dt = (): Date => new Date();

/** 한국 시각(UTC+9) 표기 'YYYY-MM-DDTHH:MM:SS' — schema.sql 의 now() at time zone 'Asia/Seoul' 과 같은 기준 (admin·intake) */
export function kst_stamp(d: Date): string {
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}T${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())}`;
}

/** Python 의 (a - b).total_seconds() */
export const total_seconds = (a: Date, b: Date): number => (a.getTime() - b.getTime()) / 1000;
