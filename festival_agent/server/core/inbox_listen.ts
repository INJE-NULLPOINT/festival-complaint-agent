// 접수 알림 받기 — Postgres LISTEN/NOTIFY 로 워커를 바로 깨운다. (신규, D5-71)
//
// 왜: 접수 → 분류 완료 10초 목표에서 모델 호출(평균 6.7초)을 뺀 나머지는 거의 워커의 3초 폴링 대기였다.
//   schema.sql 의 트리거가 feedback_inbox 에 접수가 들어올 때마다 pg_notify('feedback_inbox', id) 를 보내고, 워커는 전용 연결로 LISTEN 하다가
//   알림이 오면 기다리던 수거 루프를 깨운다. **놓쳐도 된다** — 수거 루프는 알림이 없어도 계속 폴링한다(예비).
// 주의: Supabase 의 '트랜잭션 풀러'(포트 6543)는 LISTEN 을 받아 주지만 알림은 전해 주지 않는다. 그래서 연결하자마자
//   스스로 pg_notify('inbox_ping') 를 보내 2초 안에 돌아오는지 확인하고, 안 오면 '쓸 수 없음'으로 두고 폴링만 쓴다 (live()=false).
//   연결이 끊기면 10초 뒤 다시 붙는다. 세션 풀러·직접 연결이면 그대로 동작한다.
import pg from "pg";
import * as db from "./db.ts";

export const CHANNEL = "feedback_inbox";
export const PING = "inbox_ping";
const PING_WAIT_MS = 2000;
const RECONNECT_MS = 10_000;

export interface Listener {
  live(): boolean;
  stop(): Promise<void>;
}

/** pg 일 때만 의미가 있다. onNotify 는 접수 알림마다 불린다. 연결 실패·미지원은 조용히 live()=false 로 두고 폴링에 맡긴다. */
export function start_listener(onNotify: () => void, log: (msg: string) => void = () => {}): Listener {
  let stopped = false;
  let is_live = false;
  let client: pg.Client | null = null;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => { void connect(); }, RECONNECT_MS);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const c = new pg.Client({ ...db.pg_client_config(), keepAlive: true });
    let pinged = false;
    const drop = (why: string): void => {
      if (client === c) { client = null; if (is_live) log(`[worker] 접수 알림 연결이 끊겼습니다 (${why}) — 폴링으로 받습니다`); is_live = false; }
      c.removeAllListeners();
      c.on("error", () => { /* 이미 버린 연결 */ });
      c.end().catch(() => {});
      schedule();
    };
    try {
      c.on("notification", (m) => {
        if (m.channel === PING) pinged = true;
        else if (m.channel === CHANNEL) onNotify();
      });
      c.on("error", (e) => drop(String(e.message).slice(0, 60)));
      c.on("end", () => drop("연결 종료"));
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
      await c.query(`LISTEN ${PING}`);
      await c.query(`SELECT pg_notify('${PING}', 'x')`);
      const t0 = Date.now();
      while (!pinged && Date.now() - t0 < PING_WAIT_MS) await new Promise((r) => setTimeout(r, 50));
      if (!pinged) {
        log("[worker] 접수 알림(LISTEN)을 받을 수 없는 연결입니다 (트랜잭션 풀러?) — 폴링만 씁니다");
        c.removeAllListeners();
        c.on("error", () => {});
        await c.end().catch(() => {});
        is_live = false;
        schedule();                                   // 설정이 바뀌었을 수 있으니 가끔 다시 본다
        return;
      }
      if (stopped) { await c.end().catch(() => {}); return; }
      client = c;
      is_live = true;
      log("[worker] 접수 알림(LISTEN/NOTIFY) 연결됨 — 접수가 들어오면 바로 깨어납니다");
    } catch (e) {
      log(`[worker] 접수 알림 연결 실패: ${String((e as Error).message).slice(0, 80)} — 폴링으로 받습니다`);
      c.removeAllListeners();
      c.on("error", () => {});
      await c.end().catch(() => {});
      is_live = false;
      schedule();
    }
  };

  void connect();
  return {
    live: () => is_live,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      is_live = false;
      const c = client; client = null;
      if (c) { c.removeAllListeners(); c.on("error", () => {}); await c.end().catch(() => {}); }
    },
  };
}
