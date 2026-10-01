// 확인 필요(review) 민원 처리 (D5-32). (core/review.py 와 1:1)
//
// 분류 신뢰도가 낮거나 내용이 없어 유형을 정하지 못한 민원(status='review')을 운영자가 처리한다.
// 운영자 동작은 세 가지다 — ①유형 지정(resolve) ②유형 없음으로 닫기(dismiss) ③지우기(delete_feedback).
//
//   resolve   status='review' → 'done'. 운영자가 고른 유형·안전 여부로 집계(심각도·카드·알림)에 들어간다.
//             같은 문장이 다시 오면 쓰도록 classify_cache 에도 넣는다.
//   dismiss   'review' → 'dismissed'. 진짜 방문객 의견이지만 유형을 붙일 수 없는 것. 지우면 방문객 목소리가 사라지므로 따로 둔다.
//   reopen    'dismissed' 나 운영자가 지정한 'done' 을 다시 'review' 로 (되돌리기).
//
// 세 동작 모두 상태 조건을 건다 — 이미 처리된 민원은 '이미 처리된 민원입니다'. UPDATE 의 WHERE status 조건이 원자적이다.
// 안전 의심(is_safety=1) review 가 STALE_MIN 분 넘게 처리되지 않으면 알림을 한 번 올린다 (kind='review_safety_stale').
import { createHash } from "node:crypto";
import { config } from "./config.ts";
import * as db from "./db.ts";
import { isoformat, minutes, plus } from "./datetime.ts";
import { KeyError, ValueError } from "./errors.ts";

export type Row = Record<string, any>;

export const STALE_MIN = 15;                     // 설계값. 미조치 가중(30분)보다 짧게 잡았다
export const MSG_DONE = "이미 처리된 민원입니다";
export const MSG_MISSING = "없는 민원입니다";
export const MSG_NOT_REOPENABLE = "되돌릴 수 있는 처리가 아닙니다";
export const ALERT_KIND = "review_safety_stale";

function _digest(raw_text: string): string {
  return createHash("sha256").update(raw_text, "utf8").digest("hex");
}

async function _get(conn: db.Conn, feedback_id: number): Promise<Row | undefined> {
  return (await conn.execute(
    `SELECT c.feedback_id, c.status, c.label, c.sentiment, c.is_safety, c.confidence,
            c.suggested_label, c.decided_by, f.raw_text
     FROM classification c JOIN feedback f ON f.id = c.feedback_id
     WHERE c.feedback_id = ?`, [feedback_id])).fetchone();
}

/** 유형 지정. 없는 민원 KeyError · 이미 처리됨·모르는 유형 ValueError. */
export async function resolve(feedback_id: number, label: string, is_safety: boolean | number | null = null,
                              ts: string | null = null): Promise<void> {
  if (!(label in config.LABELS)) throw new ValueError(`모르는 민원 유형입니다: ${label}`);
  const conn = await db.connect();
  const r = await _get(conn, feedback_id);
  if (!r) throw new KeyError(MSG_MISSING);
  if (r.status !== "review") throw new ValueError(MSG_DONE);
  // 안전을 고르면 자동으로 안전 의심, 긍정은 안전이 아니다. 혼잡을 포함한 그 밖에는 운영자가 고른 값, 없으면 모델이 준 값 (D5-59: 혼잡이라고 안전은 아니다)
  let safe: number;
  if (config.SAFETY_LABELS.has(label)) safe = 1;
  else if (label === "positive") safe = 0;
  else if (is_safety === null || is_safety === undefined) safe = Number(Boolean(r.is_safety));
  else safe = Number(Boolean(is_safety));
  const sug = r.suggested_label || "-";
  const cur = await conn.execute(
    `UPDATE classification
     SET label=?, is_safety=?, confidence=1.0, status='done', agent_note=?,
         reviewed_at=?, review_action='label', decided_by='operator'
     WHERE feedback_id=? AND status='review'`,
    [label, safe, `운영자 지정 (모델 제안: ${sug})`, ts ?? db.now(), feedback_id]);
  if (cur.rowcount === 0) throw new ValueError(MSG_DONE);
  const sentiment = r.sentiment;
  // 같은 문장이 다시 오면 운영자 지정을 쓴다 (리플레이 반복 대비)
  await db.cache_put(_digest(r.raw_text), {
    label, sentiment: sentiment !== null && sentiment !== undefined ? sentiment : -0.5,
    is_safety: Boolean(safe), confidence: 1.0,
  });
}

/** 유형 없음으로 닫기. */
export async function dismiss(feedback_id: number, ts: string | null = null): Promise<void> {
  const conn = await db.connect();
  const r = await _get(conn, feedback_id);
  if (!r) throw new KeyError(MSG_MISSING);
  const cur = await conn.execute(
    `UPDATE classification
     SET status='dismissed', reviewed_at=?, review_action='dismissed', decided_by='operator'
     WHERE feedback_id=? AND status='review'`, [ts ?? db.now(), feedback_id]);
  if (cur.rowcount === 0) throw new ValueError(MSG_DONE);
}

/** 운영자 처리(닫기·유형 지정)를 되돌려 다시 '확인 필요'로. */
export async function reopen(feedback_id: number): Promise<void> {
  const conn = await db.connect();
  const r = await _get(conn, feedback_id);
  if (!r) throw new KeyError(MSG_MISSING);
  const was_label = r.status === "done" && r.decided_by === "operator";
  if (!(r.status === "dismissed" || was_label)) throw new ValueError(MSG_NOT_REOPENABLE);
  const sug = r.suggested_label || "-";
  const cur = await conn.execute(
    `UPDATE classification
     SET status='review', label=NULL, confidence=NULL, agent_note=?,
         reviewed_at=NULL, review_action=NULL, decided_by=NULL
     WHERE feedback_id=? AND (status='dismissed' OR (status='done' AND decided_by='operator'))`,
    [`확인 필요 — 운영자가 되돌림. 모델 제안: ${sug}`, feedback_id]);
  if (cur.rowcount === 0) throw new ValueError(MSG_NOT_REOPENABLE);
  if (was_label) {                       // 지정하며 넣어 둔 같은 문장 캐시는 지운다
    await conn.execute("DELETE FROM classify_cache WHERE hash=?", [_digest(r.raw_text)]);
  }
}

/** 운영자가 처리할 확인 필요 목록. 안전 의심이 먼저, 그 안에서는 오래된 것 먼저 (최대 limit건). */
export async function items(limit = 20): Promise<Row[]> {
  const conn = await db.connect();
  const rows = (await conn.execute(
    `SELECT f.id, f.raw_text, f.ingested_at, f.posted_at, f.zone_id,
            COALESCE(z.name, '${config.ZONE_UNKNOWN}') zone,
            c.suggested_label, COALESCE(c.is_safety, 0) is_safety, c.confidence, c.agent_note
     FROM classification c
     JOIN feedback f ON f.id = c.feedback_id
     LEFT JOIN zone z ON z.id = f.zone_id
     WHERE c.status='review' AND ${db.LIVE_FEEDBACK_SQL}
     ORDER BY COALESCE(c.is_safety, 0) DESC, f.ingested_at ASC, f.id ASC
     LIMIT ?`, [limit])).fetchall();
  return rows.map((r) => ({ ...r }));
}

/** 안전 의심 확인 필요가 minutes 분 넘게 처리되지 않았으면 알림 1회 (같은 민원은 한 번만). 올린 알림 수. */
export async function raise_stale_alerts(minutes_: number = STALE_MIN): Promise<number> {
  const cutoff = isoformat(plus(new Date(), -minutes(minutes_)));
  let raised = 0;
  const conn = await db.connect();
  const stale = (await conn.execute(
    `SELECT f.id, f.raw_text, c.suggested_label
     FROM classification c JOIN feedback f ON f.id = c.feedback_id
     WHERE c.status='review' AND c.is_safety=1 AND ${db.LIVE_FEEDBACK_SQL}
       AND f.ingested_at <= ?
     ORDER BY f.ingested_at`, [cutoff])).fetchall();
  const done = new Set((await conn.execute("SELECT detail FROM alert WHERE kind=?", [ALERT_KIND])).fetchall().map((r) => r.detail as string));
  for (const r of stale) {
    const marker = `[#${r.id}]`;            // 같은 민원에 알림이 두 번 나가지 않게 표식을 본문에 둔다
    if ([...done].some((d) => d.includes(marker))) continue;
    const label = r.suggested_label in config.LABELS ? r.suggested_label : "safety";
    await db.raise_alert(label, ALERT_KIND,
      `${marker} 확인 필요 안전 의심 민원이 ${minutes_}분 넘게 처리되지 않았습니다: ${(r.raw_text || "").slice(0, 40)}`);
    raised += 1;
  }
  return raised;
}
