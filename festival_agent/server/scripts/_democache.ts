// 시연 시드의 '실제 모델 분류 결과' 캐시 (D5-89). precache_demo.ts 가 만들고 demo_scenario.ts 가 시연 DB 에 넣는다.
// 파일은 문장 → 분류 결과만 담는다. 어느 모델이 언제 분류했는지(backend·model·created_at)를 같이 적어 둬서,
// 시연에서 '캐시된 실제 모델 결과'라고 정직하게 밝힐 수 있다. 규칙(local) 대역 결과는 만들지도 읽지도 않는다.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BASE_DIR } from "../core/config.ts";
import * as db from "../core/db.ts";

export const FILE = path.join(BASE_DIR, "seed", "demo_classify_cache.json");

export type Entry = { text: string; label: string; sentiment: number; is_safety: boolean; confidence: number };
export type CacheFile = { backend: string; model: string; created_at: string; entries: Entry[] };

export const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function read(file = FILE): CacheFile | null {
  if (!existsSync(file)) return null;
  const j = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
  if (!j || !Array.isArray(j.entries) || !j.backend || j.backend === "local") throw new Error(`${file}: 실제 모델 결과 파일이 아닙니다`);
  return j;
}

/** 현재 DB(시연 DB)의 classify_cache 에 넣는다. 넣은 건수. 파일이 없으면 0. */
export async function load(file = FILE): Promise<number> {
  const j = read(file);
  if (!j) return 0;
  for (const e of j.entries) {
    await db.cache_put(digest(e.text), { label: e.label, sentiment: e.sentiment, is_safety: e.is_safety, confidence: e.confidence });
  }
  return j.entries.length;
}
