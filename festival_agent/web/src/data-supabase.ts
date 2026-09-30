// Supabase — anon 키로 읽고, 쓰기는 RPC 3개로만 한다 (supabase/schema.sql).
import { createClient } from "@supabase/supabase-js";
import { AdminDenied } from "./admin";
import type { Backend, FeedItem, ReviewItem, Severity } from "./data";

/** classification + feedback 임베드 행을 ReviewItem 으로. 순서는 서버(local)와 같다: 안전 의심 먼저, 그 안에서는 오래된 것 먼저, 최대 20건. */
function reviewItems(rows: any[] | null): ReviewItem[] {
  const list = (rows ?? []).map((r) => {
    const f = Array.isArray(r.feedback) ? r.feedback[0] : r.feedback;
    return {
      id: f.id as number, raw_text: f.raw_text as string, ingested_at: f.ingested_at as string, posted_at: f.posted_at as string | null,
      zone_id: (f.zone_id ?? null) as number | null, suggested_label: (r.suggested_label ?? null) as string | null,
      is_safety: Number(r.is_safety ?? 0), confidence: r.confidence == null ? null : Number(r.confidence),
    } as ReviewItem;
  });
  list.sort((a, b) => b.is_safety - a.is_safety || a.ingested_at.localeCompare(b.ingested_at) || a.id - b.id);
  return list.slice(0, 20);
}

export function supabaseBackend(url: string, key: string): Backend {
  const sb = createClient(url, key);

  const must = <T>({ data, error }: { data: T; error: { message: string } | null }): T => {
    if (error) throw new Error(error.message);
    return data;
  };

  /** 가장 최근 심각도 스냅샷 한 묶음. 워커가 분류 직후마다 남긴다. */
  async function latestSeverity(): Promise<Severity[]> {
    const rows = must(await sb.from("severity").select("*")
      .order("id", { ascending: false }).limit(40)) as Severity[];
    if (!rows.length) return [];
    const { as_of: asOf, window } = rows[0];
    // 같은 초에 스냅샷이 겹치거나(워커·②감시) 창 길이가 다른 판정이 섞일 수 있다.
    // 가장 최근 행과 같은 as_of·창만 쓰고, 유형마다 최신 행(id 큰 쪽) 하나만 쓴다.
    const latest = new Map<string, Severity>();
    for (const r of rows) {
      if (r.as_of === asOf && r.window === window && !latest.has(r.label)) latest.set(r.label, r);
    }
    // 서버(local)와 같은 순서: 등급(즉시>높음>보통>낮음) → 안전 계열(safety_w>1) 먼저 → 점수
    const order: Record<string, number> = { immediate: 0, high: 1, mid: 2, low: 3 };
    const safe = (s: Severity) => ((s.safety_w ?? 1) > 1 ? 0 : 1);
    return [...latest.values()].sort((a, b) =>
      (order[a.grade] ?? 9) - (order[b.grade] ?? 9) || safe(a) - safe(b) || b.score - a.score);
  }

  /** 반환값이 {ok:false, error} 면 운영자 코드 거부로 던진다. 잠김은 문구로 가린다 ("시도가 너무 많습니다…"). */
  function denyIfRejected(data: unknown): void {
    const d = data as { ok?: boolean; error?: string } | null;
    if (d && typeof d === "object" && d.ok === false) {
      const msg = d.error ?? "운영자 코드가 필요합니다";
      throw new AdminDenied(/시도가 너무 많|잠시 후|10분/.test(msg) ? "locked" : /설정/.test(msg) ? "unset" : "wrong", msg);
    }
  }
  async function adminRpc(name: string, args: Record<string, unknown>, code?: string): Promise<any> {
    const { data, error } = await sb.rpc(name, { ...args, p_code: code ?? "" });
    if (error) throw new Error(error.message);
    denyIfRejected(data);
    return data;
  }

  return {
    name: "supabase",

    async zones() {
      return must(await sb.from("zone").select("id,name").order("id")) ?? [];
    },

    async festival() {
      const rows = must(await sb.from("festival").select("name").limit(1)) as { name: string }[] | null;
      return rows?.[0]?.name ?? "";
    },

    async control() {
      const [sev, brief, feed, pending, total, alerts, review, reviewSafety, issues, deleted, reviewRows, synth] = await Promise.all([
        latestSeverity(),
        sb.from("briefing").select("*").order("id", { ascending: false }).limit(1),
        // 지운(숨긴) 민원은 빼고 보여 준다 — deleted_at IS NULL (D5-30)
        sb.from("feedback").select("id,raw_text,ingested_at,zone_id,classification(label,status)")
          .is("deleted_at", null).order("id", { ascending: false }).limit(10),
        sb.from("classification").select("feedback_id", { count: "exact", head: true }).eq("status", "pending"),
        sb.from("feedback").select("id", { count: "exact", head: true }).is("deleted_at", null),
        sb.from("alert").select("*").eq("acked", 0).order("id", { ascending: false }).limit(3),
        // 확인 필요(유형 없음) 개수와, 그중 안전 의심 개수 — webapi.py 의 review · review_safety 와 같다
        sb.from("classification").select("feedback_id", { count: "exact", head: true }).eq("status", "review"),
        sb.from("classification").select("feedback_id", { count: "exact", head: true }).eq("status", "review").eq("is_safety", 1),
        // 조치할 일 카드 (D5-29): active=1 인 것만, 순위 순서
        sb.from("issue").select("*").eq("active", 1).order("rank_no"),
        // 지운 민원 개수 (D5-30)
        sb.from("feedback").select("id", { count: "exact", head: true }).not("deleted_at", "is", null),
        // 확인 필요 목록 (D5-32): status='review' 인 분류 + 그 민원. 지운 민원은 뺀다. 최대 20건 (webapi 의 review_items 와 같다)
        sb.from("classification")
          .select("feedback_id,suggested_label,is_safety,confidence,feedback!inner(id,raw_text,ingested_at,posted_at,zone_id,deleted_at)")
          .eq("status", "review").is("feedback.deleted_at", null).limit(60),
        // 합성·재생 민원 개수 (헤더 '합성 데이터' 배지). 집계 창 기준은 서버만 알아서, 여기서는 지우지 않은 전체로 센다.
        // 실패해도(열 없음 등) 관제를 막지 않도록 must() 에 넣지 않는다.
        sb.from("feedback").select("id", { count: "exact", head: true }).is("deleted_at", null).in("source", ["replay", "demo", "dev"]),
      ]);
      const items: FeedItem[] = (must(feed) ?? []).map((f: any) => {
        const c = Array.isArray(f.classification) ? f.classification[0] : f.classification;
        return { ...f, label: c?.label ?? null, status: c?.status ?? null };
      });
      return {
        sev,
        briefing: must(brief)?.[0] ?? null,
        feed: items,
        pending: pending.count ?? 0,
        review: review.count ?? 0,
        review_safety: reviewSafety.count ?? 0,
        issues: must(issues) ?? [],
        deleted: deleted.count ?? 0,
        synthetic: { on: (synth.count ?? 0) > 0, count: synth.count ?? 0 },
        review_items: reviewItems(must(reviewRows) as any[] | null),
        total: total.count ?? 0,
        alerts: must(alerts) ?? [],
      };
    },

    async action() {
      const [sev, acts, jobs] = await Promise.all([
        latestSeverity(),
        sb.from("action_request").select("*").order("id", { ascending: false }).limit(15),
        sb.from("doc_job").select("*").order("id", { ascending: false }).limit(30),
      ]);
      return { sev, actions: must(acts) ?? [], jobs: must(jobs) ?? [] };
    },

    async submitFeedback(zoneId, text) {
      return must(await sb.rpc("submit_feedback", { p_zone_id: zoneId, p_text: text }));
    },
    // 관리자 동작 (D5-31) — RPC 인자 p_code 로 운영자 코드를 보낸다 (묻는 것은 admin.ts 의 gateAdmin).
    // 서버는 틀린 코드를 예외가 아니라 반환값 {ok:false, error} 로 준다 (예외면 '틀린 시도' 기록이 롤백돼 잠금이 안 걸린다).
    // 그래서 error 가 아니라 data.ok 를 본다. 없는 민원·잘못된 상태 같은 검증 오류는 예외 그대로.
    async checkAdmin(code) {
      const { data, error } = await sb.rpc("check_admin", { p_code: code });
      // 서버에 check_admin 이 아직 없으면(옛 schema.sql) 여기서는 확인하지 않고, 첫 실제 동작에서 확인된다
      if (error && (error.code === "PGRST202" || /Could not find the function/i.test(error.message))) return;
      if (error) throw new Error(error.message);
      denyIfRejected(data);
    },
    async requestDoc(label, code) {
      const data = await adminRpc("request_doc", { p_label: label }, code);
      return typeof data === "number" ? data : data?.id;       // {ok, id} (옛 서버는 id 만)
    },
    async setActionStatus(id, status, code) {
      await adminRpc("set_action_status", { p_id: id, p_status: status }, code);
    },
    async deleteFeedback(id, code) {
      await adminRpc("delete_feedback", { p_id: id }, code);
    },
    async restoreFeedback(id, code) {
      await adminRpc("restore_feedback", { p_id: id }, code);
    },
    async resolveReview(id, label, code) {
      await adminRpc("resolve_review", { p_id: id, p_label: label }, code);
    },
    async dismissReview(id, code) {
      await adminRpc("dismiss_review", { p_id: id }, code);
    },
    async reopenReview(id, code) {
      await adminRpc("reopen_review", { p_id: id }, code);
    },

    subscribe(h) {
      const ch = sb.channel("festival");
      for (const t of ["feedback", "classification", "severity", "briefing", "action_request", "doc_job", "issue"]) {
        ch.on("postgres_changes", { event: "*", schema: "public", table: t }, h.onChange);
      }
      ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "alert" }, (p) => {
        h.onAlert(p.new as any);
        h.onChange();
      });
      ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "doc_job" }, (p) => {
        const j = p.new as { label: string; status: string };
        if (j.status === "done") h.onDocDone(j);
      });
      ch.subscribe((status) => h.onStatus(status === "SUBSCRIBED"));
    },
  };
}
