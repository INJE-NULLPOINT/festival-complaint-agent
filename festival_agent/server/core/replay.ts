// 리플레이 엔진 — 과거 민원을 타임스탬프 순서대로 배속 재생한다. (core/replay.py 와 1:1)
//
// 왜 필요한가: 실시간 시스템은 3분 영상에서 '실시간임'을 보여주기 어렵다. 며칠치 민원이 쌓이면서 심각도 순위가 뒤집히는 장면이
// 이 과제의 결론인데, 실제로 며칠을 기다릴 수는 없다. 그래서 재생 기능을 **제품 기능으로** 넣는다. 개발 중 테스트에도 그대로 쓰인다.
// 설계: 상태를 DB에 둔다. 워커와 대시보드가 서로 다른 프로세스라도 같은 재생 상태를 본다.
//       step() 을 호출할 때마다 '지금 시각까지 도달한' 민원을 넣는다.
import { existsSync } from "node:fs";
import { dict_reader } from "./csv.ts";
import * as db from "./db.ts";
import { fromisoformat, plus, seconds } from "./datetime.ts";

export type Row = Record<string, any>;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS replay_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  csv_path TEXT, speed REAL, sim_start TEXT, wall_start TEXT,
  active INTEGER DEFAULT 0, cursor INTEGER DEFAULT 0, total INTEGER DEFAULT 0
);
`;

export async function ensure(): Promise<void> {
  const conn = await db.connect();
  await conn.executescript(SCHEMA);
}

/** CSV → [{posted_at, zone, text}] (posted_at 오름차순). */
export function load_rows(csv_path: string): Row[] {
  if (!existsSync(csv_path)) throw new Error(`시드 파일 없음: ${csv_path}`);   // FileNotFoundError
  const rows = dict_reader(csv_path).filter((r) => (r.text || "").trim());
  return rows.sort((a, b) => {
    const pa = a.posted_at || "";
    const pb = b.posted_at || "";
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
}

/** 재생 시작. speed=60 이면 1초에 60초치가 흐른다. (키워드 인자 speed 는 마지막 객체) */
export async function start(csv_path: string, opts: { speed?: number } = {}): Promise<Row> {
  const speed = opts.speed ?? 60.0;
  await ensure();
  const rows = load_rows(csv_path);
  if (!rows.length) throw new Error("시드가 비어 있습니다");          // ValueError

  const conn = await db.connect();
  await conn.execute("DELETE FROM replay_state");
  await conn.execute(
    `INSERT INTO replay_state
     (id, csv_path, speed, sim_start, wall_start, active, cursor, total)
     VALUES (1,?,?,?,?,1,0,?)`,
    [String(csv_path), speed, rows[0].posted_at, db.now(), rows.length]);
  return { total: rows.length, speed, sim_start: rows[0].posted_at };
}

export async function stop(): Promise<void> {
  await ensure();
  const conn = await db.connect();
  await conn.execute("UPDATE replay_state SET active=0 WHERE id=1");
}

export async function state(): Promise<Row | null> {
  await ensure();
  const conn = await db.connect();
  const row = (await conn.execute("SELECT * FROM replay_state WHERE id=1")).fetchone();
  return row ? { ...row } : null;
}

/** 현재 시뮬레이션 시각. */
export function sim_now(st: Row): Date {
  const elapsed = (Date.now() - fromisoformat(st.wall_start).getTime()) / 1000;
  return plus(fromisoformat(st.sim_start), seconds(elapsed * st.speed));
}

const mmdd_hhmm = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 지금 시각까지 도달한 민원을 투입한다. 투입 건수를 돌려준다. */
export async function step(max_batch = 40): Promise<number> {
  const st = await state();
  if (!st || !st.active) return 0;

  const rows = load_rows(st.csv_path);
  let cursor: number = st.cursor;
  if (cursor >= rows.length) {
    await stop();
    await db.log_agent("replay", "finished", "", `${rows.length}건 재생 완료`);
    return 0;
  }

  const now_sim = sim_now(st);
  const zone_by_name = new Map<string, number>((await db.zones()).map((z) => [z.name as string, z.id as number]));

  let inserted = 0;
  while (cursor < rows.length && inserted < max_batch) {
    const r = rows[cursor];
    let posted: Date;
    try {
      posted = fromisoformat(r.posted_at as string);
    } catch {
      cursor += 1;
      continue;
    }
    if (posted > now_sim) break;

    // 비었거나 모르는 구역은 NULL(구역 미상). 첫 구역으로 넣으면 집중도가 그쪽으로 쏠린다.
    const zid = zone_by_name.get(((r.zone as string) || "").trim()) ?? null;
    if ((await db.insert_feedback(zid, r.text as string, "replay", r.posted_at as string)) !== null) inserted += 1;
    cursor += 1;
  }

  const conn = await db.connect();
  await conn.execute("UPDATE replay_state SET cursor=? WHERE id=1", [cursor]);

  if (inserted) {
    await db.log_agent("replay", "inject", `${inserted}건`, `시뮬레이션 시각 ${mmdd_hhmm(now_sim)}`, `${cursor}/${rows.length} 진행`);
  }
  return inserted;
}

export async function progress(): Promise<Row | null> {
  const st = await state();
  if (!st) return null;
  return {
    active: Boolean(st.active),
    cursor: st.cursor,
    total: st.total,
    speed: st.speed,
    sim_now: st.active ? mmdd_hhmm(sim_now(st)) : "-",
  };
}

