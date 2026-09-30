// scripts/ 공통 도우미 — Python 표준 라이브러리 동작을 같게 맞춘 것들.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../core/config.ts";
import { LIVE_DB } from "./_safe_env.ts";

export { LIVE_DB };
export const IS_WIN = process.platform === "win32";
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Path.read_text(encoding="utf-8") — 줄바꿈을 \n 으로 */
export const read_text = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n?/g, "\n");
/** Path.write_text(text, encoding="utf-8") — \n 을 os.linesep 으로 (Windows 는 \r\n) */
export const write_text = (p: string, text: string): void => writeFileSync(p, IS_WIN ? text.replace(/\n/g, "\r\n") : text, "utf-8");
export const exists = existsSync;

/** 같은 경로인지 (Windows 는 대소문자 무시) */
export function same_path(a: string, b: string): boolean {
  const x = path.resolve(a), y = path.resolve(b);
  return IS_WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** 임시 폴더 (tempfile.mkdtemp) */
export const mkdtemp = (prefix = "tmp"): string => mkdtempSync(path.join(tmpdir(), prefix));

/** 측정 스크립트용: --live-db 가 아니면 임시 SQLite 로 고정한다. 돌려주는 값은 쓰는 DB 경로(운영이면 null). */
export function use_temp_db(name: string): string | null {
  if (LIVE_DB) {
    console.log("⚠ --live-db: 운영 DB 를 씁니다 (연결 값은 출력하지 않음).");
    return null;
  }
  const p = path.join(mkdtemp("fa-"), name);
  config.SUPABASE_DB_URL = "";
  config.DB_PATH = p;
  return p;
}

/** --live-db 를 받지 않는 스크립트: 주면 거부한다 (이 스크립트는 늘 임시·시연 DB 만 쓴다). */
export function refuse_live_db(script: string): void {
  if (LIVE_DB) {
    console.error(`${script}: 이 스크립트는 운영 DB 를 쓰지 않습니다 (--live-db 미지원).`);
    process.exit(2);
  }
}

export function ensure_dir(p: string): void { mkdirSync(p, { recursive: true }); }

// ── statistics ──
export function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  if (!n) throw new Error("no median for empty data");
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
/** statistics.stdev (표본 표준편차, n-1) */
export function stdev(v: number[]): number {
  const n = v.length;
  if (n < 2) throw new Error("stdev requires at least two data points");
  const m = v.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}

/** 천 단위 쉼표 (Python f"{n:,}") — 정수 */
export const comma = (n: number): string => Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Python f"{x:,.{d}f}" */
export function comma_fixed(s: string): string {
  const [i, f] = s.split(".");
  const neg = i.startsWith("-");
  const head = (neg ? i.slice(1) : i).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + head + (f !== undefined ? "." + f : "");
}

// ── datetime ──
const p2 = (n: number): string => String(n).padStart(2, "0");
/** f"{dt:%Y-%m-%d %H:%M}" */
export const ymd_hm = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
/** f"{dt:%H:%M:%S}" */
export const hms = (d: Date): string => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

// ── csv (Python csv 모듈과 같은 쓰기·읽기) ──
/** csv.writer 기본(QUOTE_MINIMAL, lineterminator="\r\n") 한 칸 */
export function csv_cell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
