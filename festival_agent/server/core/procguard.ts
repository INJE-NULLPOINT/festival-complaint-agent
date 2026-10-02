// 프로세스 중복 실행 방지(PID 잠금 파일)와 SQLite 안전 백업. (core/procguard.py 와 1:1)
//
// - acquire(name, key)  같은 name·key 로 이미 살아 있는 프로세스가 있으면 null, 없으면 잠금 파일 경로를 돌려준다.
//                       죽은 프로세스가 남긴 잠금은 자동으로 치운다. 종료 때 release() (못 불러도 다음 실행이 stale 로 판단).
// - backup_db()         SQLite 온라인 백업 API 로 일관된 사본을 만들고 오래된 자동 백업을 지운다. 원본은 읽기만 한다.
//
// 테스트가 폴더를 임시로 바꿀 수 있게 경로는 바꿀 수 있는 객체 `paths` 에 둔다.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { BASE_DIR, config } from "./config.ts";

export const paths = {
  LOCK_DIR: path.join(BASE_DIR, "output", "locks"),
  BACKUP_DIR: path.join(BASE_DIR, "backup"),
};
export const AUTO_PREFIX = "auto_";          // 자동 백업만 지운다 (손으로 만든 festival_*_before_reset.db 등은 건드리지 않는다)

export function pid_alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);               // 신호 0 = 존재 확인 (Windows 에서도 종료시키지 않는다)
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";      // 권한이 없어도 살아 있는 프로세스다
  }
}

export function lock_path(name: string, key = ""): string {
  const tag = key ? createHash("sha1").update(String(key), "utf8").digest("hex").slice(0, 8) : "main";
  return path.join(paths.LOCK_DIR, `${name}_${tag}.lock`);
}

/** 잠금을 잡는다. 이미 살아 있는 소유자가 있으면 null. */
export function acquire(name: string, key = "", pid: number | null = null): string | null {
  const p = lock_path(name, key);
  mkdirSync(paths.LOCK_DIR, { recursive: true });
  const me = pid ?? process.pid;
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(p, String(me), { flag: "wx", encoding: "utf8" });      // 원자적 생성
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner = 0;
      try {
        owner = parseInt(readFileSync(p, "utf8").trim() || "0", 10) || 0;
      } catch { /* 읽기 실패 → 소유자 없음 */ }
      if (owner && owner !== me && pid_alive(owner)) return null;
      try {
        unlinkSync(p);                                                      // 죽은 프로세스의 잠금
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function release(p: string | null): void {
  if (p) {
    try { unlinkSync(p); } catch { /* 이미 없음 */ }
  }
}

export function stamp(d: Date): string {
  const z = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}_${z(d.getMilliseconds(), 3)}000`;
}

/**
 * DB 를 backup/auto_YYYYmmdd_HHMMSS_ffffff.db 로 복사하고 자동 백업은 최근 keep 개만 남긴다.
 * sqlite 의 backup API 를 쓰므로 쓰는 도중에도 일관된 사본이 나온다. 끝나면 원본의 WAL 을 비운다(체크포인트).
 */
export async function backup_db(keep = 12, opts: { src?: string | null; dest_dir?: string | null } = {}): Promise<string> {
  const src = opts.src ?? config.DB_PATH;
  const dest_dir = opts.dest_dir ?? paths.BACKUP_DIR;
  mkdirSync(dest_dir, { recursive: true });
  let dest = path.join(dest_dir, `${AUTO_PREFIX}${stamp(new Date())}.db`);
  while (existsSync(dest)) dest = dest.replace(/\.db$/, "_x.db");
  const s = new DatabaseSync(src, { timeout: 10000 });
  try {
    await backup(s, dest);
    try { s.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* 체크포인트 실패는 무시 */ }
  } finally {
    s.close();
  }
  const old = readdirSync(dest_dir).filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith(".db")).sort().reverse();
  for (const f of old.slice(Math.max(keep, 1))) {
    try { unlinkSync(path.join(dest_dir, f)); } catch { /* 지우기 실패는 무시 */ }
  }
  return dest;
}
