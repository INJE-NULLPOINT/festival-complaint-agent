// 동시 접수 · 벽시계 지연 자동 측정 (D6-8). (tests/latency_check.py 와 1:1)
//
// 방문객 접수를 동시에 N건(기본 20건, 3초 동안) 복사본 서버에 넣고 잰다.
//   · 유실 0 — 받은 글이 접수함·민원에 모두 남았는가
//   · 중복 0 — 같은 글이 두 번 저장되지 않았는가 (일부 방문객은 '두 번 누르기'처럼 같은 글을 곧바로 한 번 더 보낸다 → 합쳐져야 함)
//   · 접수 → 관제 유입 — 접수를 보낸 때부터 민원(feedback)으로 옮겨져 관제 '실시간 유입'에 뜰 수 있게 되기까지 (중앙값 · 최대)
//   · 접수 → 분류 완료 — 분류(classification.status)가 pending 을 벗어나기까지 (중앙값 · 최대)
//   · 접수 → 화면에 알림 — 그 유입 뒤 첫 SSE 'change' 이벤트까지 (화면은 이 알림 뒤 0.5초 안에 다시 그린다)
//
// 안전
//   · 운영 DB 는 읽기만 한다(festival.db 를 sqlite backup 으로 복사). 운영 Supabase 에는 붙지 않는다(SUPABASE_DB_URL 을 비운다).
//     복사본에 webapi 와 worker 를 별도 포트로 띄우고 끝나면 끈다. (festival.db 가 없으면 빈 새 DB 로 잰다)
//   · 분류는 local 대역(LLM_BACKEND=local, LLM 호출 없음). --backend claude_code 는 옵션일 뿐 기본으로 돌리지 않는다 (비용·시간).
//   · 방문객 N명은 X-Forwarded-For 로 서로 다른 출처(10.77.0.i)인 것처럼 보낸다 — 출처별 도배 방지(D5-33)에 한 사람으로 묶이지 않게.
//     webapi 는 접속자가 루프백일 때만 이 헤더를 믿는다(D5-43) — 이 시험은 같은 PC 에서 보내므로 그 조건을 만족한다.
//   · worker 는 --no-agents (분류·유입만; 조치 문구 생성 등 Agent Path 는 이 측정과 무관). 간격은 기본값(--interval 3초) 그대로다 — 벽시계 지연에 그 주기가 포함된다.
//
// 실행
//     node server/tests/latency_check.ts                      20건 · 3초 · local
//     node server/tests/latency_check.ts --n 50 --seconds 5
//     node server/tests/latency_check.ts --backend claude_code   (옵션 · 비용 발생 · 오래 걸림)
// 결과: server/tests/latency_report.md · 종료 코드 0 통과 / 1 실패(유실·중복·시간 초과)
//   
import "../scripts/_safe_env.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { backup, DatabaseSync } from "node:sqlite";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { fixed } from "../core/pyfmt.ts";
import { median, refuse_live_db, sleep, write_text, ymd_hm } from "../scripts/_common.ts";
import { Random } from "../scripts/_pyrandom.ts";

const HERE = import.meta.dirname;
const SERVER = path.resolve(HERE, "..");
const ROOT = path.resolve(SERVER, "..");
const REPORT = path.join(HERE, "latency_report.md");
const NODE = process.execPath;

function free_port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function kill_tree(p: ChildProcess | null): void {
  if (p && p.exitCode === null && p.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill();
  }
}

type Sql = (sql: string, params?: unknown[]) => unknown[][];

async function main(): Promise<number> {
  refuse_live_db("latency_check");
  const { values: v } = parseArgs({
    options: {
      n: { type: "string", default: "20" },
      seconds: { type: "string", default: "3.0" },
      double: { type: "string", default: "5" },
      backend: { type: "string", default: "local" },
      timeout: { type: "string", default: "120.0" },
    },
  });
  const args = { n: Number(v.n), seconds: Number(v.seconds), double: Number(v.double), backend: v.backend as string, timeout: Number(v.timeout) };
  if (!["local", "claude_code"].includes(args.backend)) { console.error("--backend 은 local|claude_code"); return 2; }

  const tmp = mkdtempSync(path.join(tmpdir(), "latency-"));
  const dbp = path.join(tmp, "latency.db");
  const kids: ChildProcess[] = [];
  const notes: string[] = [];
  let ok = true;
  let roh: DatabaseSync | null = null;
  try {
    // ── 복사본 DB (운영 DB 는 읽기만) ──
    const src = process.env.DB_PATH || path.join(ROOT, "festival.db");
    const env0 = { ...process.env, DB_PATH: dbp, LLM_BACKEND: args.backend, PYTHONIOENCODING: "utf-8", SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "" };
    if (existsSync(src)) {
      const s = new DatabaseSync(src, { readOnly: true });
      await backup(s, dbp);
      s.close();
      const d = new DatabaseSync(dbp);
      for (const t of ["admin_attempt", "submit_rate"]) { try { d.exec(`DELETE FROM ${t}`); } catch { /* 표가 없다 */ } }
      d.close();
    } else {
      notes.push("festival.db 가 없어 빈 새 DB 로 측정");
      const init = spawnSync(NODE, ["-e", "const db = await import('./server/core/db.ts'); await db.init_db(); await db.close_all();", "--input-type=module"], { cwd: ROOT, env: env0 });
      if (init.status !== 0) throw new Error("새 DB 만들기 실패");
    }

    const port = await free_port();
    const base = `http://127.0.0.1:${port}`;
    kids.push(spawn(NODE, [path.join(SERVER, "webapi.ts"), "--port", String(port)], { cwd: ROOT, env: env0, stdio: "ignore" }));
    let up = false;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/zones", { signal: AbortSignal.timeout(2000) }); await r.arrayBuffer(); up = true; break; } catch { await sleep(300); }
    }
    if (!up) throw new Error("webapi 가 뜨지 않음");
    kids.push(spawn(NODE, [path.join(SERVER, "worker.ts"), "--no-agents"], { cwd: ROOT, env: env0, stdio: "ignore" }));

    roh = new DatabaseSync(dbp);
    const q: Sql = (sql, params = []) => roh!.prepare(sql).all(...(params as any[])).map((r) => Object.values(r as object));
    // 시작 전에 밀려 있는 것(복사본에 남은 대기 분류·접수함)을 먼저 비운다 — 그 대기열이 측정에 섞이지 않게
    const backlog = (): number => Number(q("SELECT (SELECT COUNT(*) FROM classification WHERE status='pending') + (SELECT COUNT(*) FROM feedback_inbox WHERE feedback_id IS NULL)")[0][0]);
    const b0 = backlog();
    const t_dr = Date.now() / 1000;
    while (backlog() > 0 && Date.now() / 1000 - t_dr < 90) await sleep(500);
    if (backlog() > 0) notes.push(`시작 전 대기열 ${b0}건이 90초 안에 안 비워져 측정에 섞였을 수 있음`);
    else if (b0) notes.push(`시작 전 대기열 ${b0}건을 먼저 비운 뒤 측정`);

    const zones = q("SELECT id FROM zone ORDER BY id").map((r) => Number(r[0]));
    const rnd = new Random(68);
    const N = args.n;
    const kinds = ["계단 조명이 꺼져 있어요", "입구가 너무 혼잡해요", "주차장이 가득 찼어요", "화장실 줄이 길어요"];
    const texts = Array.from({ length: N }, (_, i) => `동시 접수 측정 ${String(i).padStart(2, "0")}: ${kinds[i % 4]} (${i}번 방문객)`);
    const offsets = Array.from({ length: N }, () => rnd.uniform(0, args.seconds)).sort((a, b) => a - b);
    const doubles = new Set(rnd.sample(Array.from({ length: N }, (_, i) => i), Math.min(args.double, N)));
    const max_inbox = Number(q("SELECT COALESCE(MAX(id),0) FROM feedback_inbox")[0][0]);
    const max_fb = Number(q("SELECT COALESCE(MAX(id),0) FROM feedback")[0][0]);

    // ── SSE 'change' 이벤트 시각 기록 ──
    const changes: number[] = [];
    const sse_abort = new AbortController();
    void (async () => {
      try {
        const r = await fetch(base + "/api/events", { signal: sse_abort.signal });
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of r.body as any) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (line.startsWith("event: change")) changes.push(Date.now() / 1000);
          }
        }
      } catch { /* 중단 */ }
    })();
    await sleep(1500);

    // ── 접수: 방문객 N명이 offsets 에 맞춰 동시에 ──
    interface Post { i: number; status: number; receipt: number | null; t_send: number; t_ack: number; dup: boolean; err?: string }
    const post = async (i: number, dup = false): Promise<Post> => {
      const t_send = Date.now() / 1000;
      try {
        const r = await fetch(base + "/api/rpc/submit_feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.77.0.${i + 1}` },
          body: JSON.stringify({ p_zone_id: zones[i % zones.length], p_text: texts[i] }),
          signal: AbortSignal.timeout(30_000),
        });
        const txt = await r.text();
        if (r.status === 200) return { i, status: 200, receipt: JSON.parse(txt).data ?? null, t_send, t_ack: Date.now() / 1000, dup };
        return { i, status: r.status, receipt: null, t_send, t_ack: Date.now() / 1000, dup, err: txt.slice(0, 120) };
      } catch (e) {
        return { i, status: 0, receipt: null, t_send, t_ack: Date.now() / 1000, dup, err: String((e as Error).message).slice(0, 120) };
      }
    };
    const results: (Post | null)[] = new Array(N).fill(null);
    const extra: Post[] = [];
    const t_start = Date.now() / 1000 + 0.3;
    const at = async (i: number): Promise<void> => { await sleep(Math.max(0, t_start + offsets[i] - Date.now() / 1000) * 1000); };
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < N; i++) tasks.push((async () => { await at(i); results[i] = await post(i); })());
    // 두 번 누르기는 같은 순간에 두 요청을 동시에 보낸다
    for (const i of doubles) tasks.push((async () => { await at(i); extra.push(await post(i, true)); })());
    await Promise.all(tasks);

    // ── 지켜보기: 유입(feedback_id 채워짐) · 분류 완료(status != pending) ──
    const t_feed = new Map<number, number>();
    const t_cls = new Map<number, number>();
    const receipts = new Map<number, number>();           // i → 접수번호
    for (const r of results) if (r && r.status === 200 && r.receipt) receipts.set(r.i, r.receipt);
    const deadline = Date.now() / 1000 + args.timeout;
    while (Date.now() / 1000 < deadline && t_cls.size < receipts.size) {
      const ids = [...receipts.values()];
      if (ids.length) {
        const marks = ids.map(() => "?").join(",");
        for (const [rid, fid, st] of q(`SELECT i.id, i.feedback_id, c.status FROM feedback_inbox i LEFT JOIN classification c ON c.feedback_id = i.feedback_id WHERE i.id IN (${marks})`, ids)) {
          const now = Date.now() / 1000;
          const id = Number(rid);
          if (fid !== null && !t_feed.has(id)) t_feed.set(id, now);
          if (fid !== null && st !== null && st !== "pending" && !t_cls.has(id)) t_cls.set(id, now);
        }
      }
      await sleep(50);
    }
    await sleep(1500);
    sse_abort.abort();

    // ── 집계 ──
    const accepted = results.filter((r): r is Post => !!r && r.status === 200);
    const failed_posts = results.filter((r) => !r || r.status !== 200);
    const dup_ok = extra.filter((r) => r.status === 200);
    const inbox_rows = q("SELECT id, text, feedback_id FROM feedback_inbox WHERE id > ?", [max_inbox]);
    // 접수함의 text 는 유입 뒤 NULL 이 되므로 민원 원문으로 센다
    const fb_texts = q("SELECT raw_text FROM feedback WHERE id > ? AND raw_text LIKE '동시 접수 측정 %'", [max_fb]).map((r) => String(r[0]));
    const kept = Array.from({ length: N }, (_, i) => fb_texts.filter((t) => t === texts[i]).length);
    const lost = kept.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0);
    const dups = kept.map((c, i) => (c > 1 ? i : -1)).filter((i) => i >= 0);
    const same_receipt = dup_ok.every((r) => !(results[r.i] && results[r.i]!.receipt) || r.receipt === results[r.i]!.receipt);
    const new_inbox = inbox_rows.length;

    const lat = (m: Map<number, number>): number[] => accepted.filter((r) => r.receipt !== null && m.has(r.receipt)).map((r) => m.get(r.receipt!)! - r.t_send);
    const feed_l = lat(t_feed), cls_l = lat(t_cls);
    const ack_l = accepted.map((r) => r.t_ack - r.t_send);
    const sse_l: number[] = [];
    for (const r of accepted) {
      const tf = r.receipt !== null ? t_feed.get(r.receipt) : undefined;
      if (tf !== undefined) {
        const nxt = changes.find((c) => c >= tf);
        if (nxt !== undefined) sse_l.push(nxt - r.t_send);
      }
    }
    const stat = (xs: number[]): [string, string] => (xs.length ? [`${fixed(median(xs), 2)}초`, `${fixed(Math.max(...xs), 2)}초`] : ["측정 못함", "측정 못함"]);

    const checks: [string, boolean, string][] = [
      [`접수 ${N}건 모두 성공 응답`, accepted.length === N, `성공 ${accepted.length}/${N}` + (failed_posts.length ? ` · 실패 [${failed_posts.map((r) => (r ?? { status: undefined }).status).join(", ")}]` : "")],
      ["유실 0", !lost.length && t_cls.size === receipts.size, `남지 않은 글 ${lost.length}건 · 분류까지 끝난 ${t_cls.size}/${receipts.size}`],
      ["중복 0 (같은 글이 두 번 저장되지 않음)", !dups.length && new_inbox === N, `두 번 이상 저장된 글 ${dups.length}건 · 접수함 새 행 ${new_inbox}건 (기대 ${N})`],
      [`두 번 누르기 ${doubles.size}건은 합쳐져 성공 응답 · 같은 접수번호`, dup_ok.length === doubles.size && same_receipt, `성공 ${dup_ok.length}/${doubles.size} · 같은 번호 ${same_receipt ? "True" : "False"}`],
    ];
    ok = checks.every((c) => c[1]);

    const md: string[] = [
      "# 동시 접수 · 벽시계 지연 측정 (D6-8)", "",
      `- 수행 ${ymd_hm(new Date())} · 방문객 ${N}명이 ${Number(args.seconds)}초에 걸쳐 동시 접수 (그중 ${doubles.size}명은 같은 글을 곧바로 한 번 더 = 두 번 누르기)`,
      `- 분류 백엔드 \`${args.backend}\`` + (args.backend === "local" ? " (local 대역 — LLM 호출 없음)" : " (옵션 실측 — 비용 발생)") + " · worker `--no-agents` 기본 주기(3초) · 운영 DB 복사본 · 별도 포트",
      "- 방문객마다 다른 출처(X-Forwarded-For 10.77.0.i)로 보냄 — 출처별 도배 방지에 묶이지 않게", "",
      "## 결과", "", "| 항목 | 판정 | 내용 |", "|---|---|---|",
    ];
    for (const [name, good, detail] of checks) md.push(`| ${name} | ${good ? "✅ 통과" : "❌ 실패"} | ${detail} |`);
    md.push("", "## 지연 (접수를 보낸 때부터, 벽시계)", "", "| 구간 | 중앙값 | 최대 | 표본 |", "|---|---|---|---|");
    for (const [label, xs] of [["접수 응답(접수번호 받기까지)", ack_l], ["접수 → 관제 유입 (민원으로 옮겨져 유입에 뜰 수 있음)", feed_l],
      ["접수 → 화면에 알림 (첫 SSE change)", sse_l], ["접수 → 분류 완료", cls_l]] as [string, number[]][]) {
      const [m_, x_] = stat(xs);
      md.push(`| ${label} | ${m_} | ${x_} | ${xs.length}건 |`);
    }
    md.push("", "## 해석", "",
      "- 접수 응답은 webapi 가 접수함에 넣는 시간뿐이다. 유입·분류 시간의 대부분은 worker 의 주기(기본 3초 간격으로 수거·분류)다.",
      "- '화면에 알림'은 서버가 변화를 알리는 시각이다. 실제 화면은 그 뒤 0.5초 안에 다시 그린다(main.ts 의 모음 시간).",
      "- local 분류는 규칙 대역이라 빠르다. 실제 LLM 분류(claude_code · API)의 시간은 이 표에 없다 — `--backend claude_code` 로 따로 재야 한다.");
    if (notes.length) md.push("", "## 참고", "", ...notes.map((n) => `- ${n}`));
    md.push("");
    write_text(REPORT, md.join("\n"));
    for (const [name, good, detail] of checks) console.log(`${good ? "✓" : "✗"} ${name}  — ${detail}`);
    for (const [label, xs] of [["접수→관제 유입", feed_l], ["접수→화면 알림", sse_l], ["접수→분류 완료", cls_l]] as [string, number[]][]) {
      const [m_, x_] = stat(xs);
      console.log(`측정 ${label}: 중앙값 ${m_} · 최대 ${x_} (${xs.length}건)`);
    }
    console.log(`→ ${REPORT}`);
    return ok ? 0 : 1;
  } finally {
    try { roh?.close(); } catch { /* 이미 닫힘 */ }
    for (const k of kids) kill_tree(k);
    await sleep(1200);
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
