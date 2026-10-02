// 화면 '마지막 갱신' 표시용 시각 (D5-86). 공개 읽기 — 시각만 돌려주고 내용은 없다.
//   server_now   서버가 지금이라고 보는 시각 (화면 시계와 어긋나도 경과를 서버 기준으로 잰다)
//   severity_at  가장 최근 등급 계산(severity 스냅샷) 시각
//   agent_at     에이전트(분류·감시·조치·통합·계획)가 마지막으로 무언가 한 시각 (agent_log)
//   worker_at    워커 루프가 마지막으로 돈 시각 (worker_status 의 가장 최근 값 — 일이 없어도 돈다)
// 값이 없으면 null. 화면은 null 이면 '아직 없음', 경과가 길면 경고를 띄운다. schema.sql 의 get_freshness() 와 같은 모양.
import * as db from "./db.ts";

export type Freshness = { server_now: string; severity_at: string | null; agent_at: string | null; worker_at: string | null };

async function max_of(sql: string): Promise<string | null> {
  const conn = await db.connect();
  const r = (await conn.execute(sql)).fetchone();
  return (r?.m as string | null | undefined) ?? null;
}

export async function get_freshness(): Promise<Freshness> {
  return {
    server_now: db.now(),
    severity_at: await max_of("SELECT MAX(as_of) m FROM severity"),
    agent_at: await max_of("SELECT MAX(created_at) m FROM agent_log"),
    worker_at: await max_of("SELECT MAX(last_at) m FROM worker_status WHERE name <> '_backend'"),
  };
}
