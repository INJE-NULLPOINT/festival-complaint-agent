// 에이전트(워커) 멈춤 감지 (D5-86) — 서버의 get_freshness(공개, 시각만)로 본다. 운영자 코드는 필요 없다.
//   · worker_at  워커 루프가 마지막으로 돈 시각 — 일이 없어도 돈다. 이것이 STALE_MS 보다 오래되면 '멈춤'.
//   · agent_at   에이전트가 마지막으로 판단한 시각 — 새 민원이 없으면 몇 시간 멈춰 있는 게 정상이라 경고에는 쓰지 않고 '마지막 판단 N분 전'만 보인다.
//   · 시각을 못 받으면(worker_at 이 null) 아무것도 말하지 않는다 — 모르는 것을 짐작하지 않는다.
//   · 경과는 서버가 준 server_now 기준이라 이 컴퓨터 시계가 틀려도 상관없다.
import { api } from "./data";

const POLL_MS = 15000;
const STALE_MS = 120000;           // 워커는 몇 초마다 도니, 2분이면 확실히 멈춘 것

export type Beat = { stale: boolean; workerAgeMs: number; agentAgeMs: number | null } | null;

const ms = (s: string | null | undefined): number | null => { const t = Date.parse(String(s ?? "")); return Number.isNaN(t) ? null : t; };

/** '방금 전 · N분 전 · N시간 전 · N일 전' */
export function ago(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 1440)}일 전`;
}

export function initHeartbeat(onBeat: (b: Beat) => void): void {
  const tick = async () => {
    if (document.hidden) return;
    try {
      const f = await api.freshness();
      const now = ms(f.server_now), w = ms(f.worker_at), a = ms(f.agent_at);
      if (now === null || w === null) { onBeat(null); return; }
      const workerAgeMs = Math.max(0, now - w);
      onBeat({ stale: workerAgeMs > STALE_MS, workerAgeMs, agentAgeMs: a === null ? null : Math.max(0, now - a) });
    } catch { /* 연결 끊김은 연결 배너가 알린다 */ }
  };
  void tick();
  window.setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void tick(); });
}
