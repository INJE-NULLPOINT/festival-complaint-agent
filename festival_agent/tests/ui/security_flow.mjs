// webapi 입력·오류·연결 점검 (D5-40) — 크롬 없이 HTTP 로만. 스스로 webapi(운영 DB 복사본)를 빈 포트에 띄우고 끝나면 끈다.
//   node tests/ui/security_flow.mjs            (festival_agent 폴더에서)
// 본 것: 17KB 본문 → 413 · Content-Length 음수 → 400 즉시 · 배열/깨진 JSON/모르는 인자 → 400 고정 문구(함수·인자 이름 없음) ·
//        text/plain POST → 415 + 저장 안 됨 · SSE 51번째 연결 → 503 (하나 끊으면 다시 붙음) · 느리게 보내다 멈춘 요청은 끊김 ·
//        500 응답에 경로·SQL·테이블 이름이 없음 (마지막에 테이블을 일부러 지워 서버 오류를 만든다 — 복사본이라 안전).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..", "..");
const PY = process.env.PYTHON ?? "python";
const SLOW = Math.max(1, Number(process.env.UI_SLOW) || 1);
let failed = 0, passed = 0;
const ok = (n, d = "") => { passed++; console.log(`✓ ${n}${d ? "  — " + d : ""}`); };
const bad = (n, d = "") => { failed++; console.log(`✗ ${n}${d ? "  — " + d : ""}`); };
const check = (n, c, d = "") => (c ? ok(n, d) : bad(n, d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms * SLOW) { const v = await fn().catch(() => null); if (v) return v; await sleep(step); } return null; };

const tmp = mkdtempSync(join(tmpdir(), "ui-suite-sec-"));
const kids = [];
const killTree = (c) => { try { if (c?.pid) spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* */ } };
async function cleanup() { for (const k of kids) killTree(k); await sleep(1200); for (let i = 0; i < 6; i++) { try { rmSync(tmp, { recursive: true, force: true }); break; } catch { await sleep(800); } } }
process.on("uncaughtException", async (e) => { bad("점검 중 예외", String(e?.stack ?? e).split("\n").slice(0, 3).join(" / ")); await cleanup(); process.exit(1); });
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

const DB = join(tmp, "sec.db");
const mk = spawnSync(PY, [join(HERE, "make_mobile_db.py"), DB], { cwd: APP, encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
if (mk.status !== 0) { bad("준비: DB 복사본", (mk.stderr || mk.stdout || "").trim().split("\n").pop()); await cleanup(); process.exit(1); }
const env = { ...process.env, DB_PATH: DB, PYTHONIOENCODING: "utf-8", LLM_BACKEND: "local", SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", ADMIN_CODE: "sec-" + Math.random().toString(36).slice(2) };
async function startApi(extraEnv = {}) {
  const port = await freePort();
  const p = spawn(PY, ["webapi.py", "--port", String(port)], { cwd: APP, env: { ...env, ...extraEnv }, stdio: "ignore" }); kids.push(p);
  const good = await until(async () => (await fetch(`http://127.0.0.1:${port}/api/zones`)).ok, 25000, 300);
  return good ? { port, base: `http://127.0.0.1:${port}` } : null;
}
const A = await startApi();
const B = await startApi({ WEBAPI_REQUEST_TIMEOUT: "2" });
if (!A || !B) { bad("준비: webapi 가 안 뜸"); await cleanup(); process.exit(1); }

const JSON_H = { "Content-Type": "application/json" };
const post = async (name, body, headers = JSON_H, base = A.base) => {
  const r = await fetch(`${base}/api/rpc/${name}`, { method: "POST", headers, body });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const inbox = () => Number(spawnSync(PY, ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT COUNT(*) FROM feedback_inbox').fetchone()[0])", DB], { encoding: "utf-8" }).stdout.trim());
// 원시 소켓: 헤더를 마음대로 보낸다 (fetch 는 Content-Length 를 제멋대로 못 쓴다)
const raw = (port, text, waitMs = 3000) => new Promise((res) => {
  const s = net.connect({ port, host: "127.0.0.1" }); let buf = ""; const t0 = Date.now(); let closed = false;
  s.on("connect", () => s.write(text));
  s.on("data", (d) => { buf += d.toString("utf8"); });
  s.on("close", () => { closed = true; res({ buf, closed, ms: Date.now() - t0 }); });
  s.on("error", () => { res({ buf, closed: true, ms: Date.now() - t0 }); });
  setTimeout(() => { if (!closed) { s.destroy(); res({ buf, closed: false, ms: Date.now() - t0 }); } }, waitMs * SLOW);
});

// ① 본문 크기
const before0 = inbox();
let r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "x".repeat(17 * 1024) }));
check("17KB 본문 → 413", r.status === 413, `status ${r.status} ${JSON.stringify(r.body)}`);
r = await raw(A.port, `POST /api/rpc/submit_feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: -1\r\n\r\n`);
check("Content-Length −1 → 400 을 바로 돌려주고 끝냄 (멈추지 않음)", /^HTTP\/1\.\d 400/.test(r.buf) && r.closed && r.ms < 2500 * SLOW, `${r.buf.split("\r\n")[0]} · ${r.ms}ms`);
r = await raw(A.port, `POST /api/rpc/submit_feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: abc\r\n\r\n`);
check("Content-Length 가 숫자가 아니면 400", /^HTTP\/1\.\d 400/.test(r.buf), r.buf.split("\r\n")[0]);
r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "본문 크기 점검용 정상 접수: 16KB 이하는 통과" }));
check("정상 크기 접수는 통과", r.status === 200, `status ${r.status}`);

// 같은 글을 동시에 여러 번 (두 번 누르기·재시도): 접수함에 한 건만, 모두 같은 접수번호 (D5-33 · intake.accept 의 락)
const nDup0 = inbox();
const dupBody = JSON.stringify({ p_zone_id: 1, p_text: "동시 접수 점검: 같은 글을 여덟 번 동시에 보내도 한 건이어야 함" });
const dups = await Promise.all(Array.from({ length: 8 }, () => post("submit_feedback", dupBody)));
const nos = new Set(dups.map((x) => x.body.data));
check("같은 글 동시 8번 → 접수함에 1건, 접수번호 하나", dups.every((x) => x.status === 200) && inbox() === nDup0 + 1 && nos.size === 1, `+${inbox() - nDup0}건 · 번호 ${[...nos].join(",")} · 상태 ${[...new Set(dups.map((x) => x.status))].join(",")}`);

// ② 오류 문구 — 내부 정보 없음
const LEAK = /keyword|argument|submit_feedback\(|Traceback|sqlite|\.py|Error\b|[A-Za-z]:\\|no such|OperationalError|SELECT |DB_PATH/i;
const cases = [["배열 JSON", "[1,2,3]"], ["문자열 JSON", '"abc"'], ["깨진 JSON", "{not json"], ["모르는 인자", JSON.stringify({ p_zone_id: 1, p_text: "안녕하세요 점검", p_bogus: 1 })]];
for (const [label, body] of cases) {
  r = await post("submit_feedback", body);
  check(`${label} → 400 고정 문구 (함수·인자·경로 이름 없음)`, r.status === 400 && !LEAK.test(r.body.error ?? ""), `${r.status} ${r.body.error}`);
}
r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "." }));
check("입력 검사 문구(사용자용)는 그대로 전달", r.status === 400 && /적어 주세요|조금 더/.test(r.body.error ?? ""), `${r.status} ${r.body.error}`);

// ③ Content-Type
const n1 = inbox();
r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "교차 출처 단순 요청 점검: 저장되면 안 됨" }), { "Content-Type": "text/plain" });
check("text/plain POST → 415", r.status === 415, `status ${r.status}`);
r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "본문 형식 없음 점검: 저장되면 안 됨" }), {});
check("Content-Type 없는 POST 도 거절", r.status === 415 || r.status === 400, `status ${r.status}`);
check("거절된 요청은 저장되지 않음", inbox() === n1, `접수함 ${n1} → ${inbox()}`);
r = await post("submit_feedback", JSON.stringify({ p_zone_id: 1, p_text: "application/json; charset=utf-8 도 통과해야 하는 접수" }), { "Content-Type": "application/json; charset=utf-8" });
check("application/json; charset=utf-8 는 통과", r.status === 200, `status ${r.status}`);

// ④ SSE 연결 상한 (서버 기본 50)
const acs = [];
let okCount = 0;
for (let i = 0; i < 50; i++) { const ac = new AbortController(); acs.push(ac); const x = await fetch(`${A.base}/api/events`, { signal: ac.signal }).catch(() => null); if (x?.status === 200) okCount++; }
check("SSE 50개까지 연결됨", okCount === 50, `${okCount}개`);
const extra = await fetch(`${A.base}/api/events`).catch(() => null);
check("SSE 51번째 → 503", extra?.status === 503, `status ${extra?.status}`);
await extra?.body?.cancel().catch(() => {});
acs[0].abort();
const again = await until(async () => { const ac = new AbortController(); const x = await fetch(`${A.base}/api/events`, { signal: ac.signal }); const s = x.status; ac.abort(); return s === 200 ? true : null; }, 8000, 500);
check("하나를 끊으면 다시 붙을 수 있음", !!again);
for (const ac of acs) ac.abort();

// ⑤ 요청 제한 시간 (이 서버는 WEBAPI_REQUEST_TIMEOUT=2): 본문을 덜 보내고 멈추면 끊긴다
r = await raw(B.port, `POST /api/rpc/submit_feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"p_zone`, 8000);
check("느리게 보내다 멈춘 요청은 제한 시간 뒤 끊김 (2초 설정)", r.closed && r.ms < 6000 * SLOW, `${r.ms}ms · 닫힘 ${r.closed}`);
const alive = await fetch(`${B.base}/api/zones`).then((x) => x.ok).catch(() => false);
check("끊긴 뒤에도 서버는 정상 응답", alive);

// ⑥ 서버 오류(500) 응답에 내부 정보 없음 — 복사본에서 severity 표를 지워 일부러 오류를 만든다
spawnSync(PY, ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('DROP TABLE severity'); c.commit()", DB]);
const g = await fetch(`${A.base}/api/control`);
const gb = await g.json().catch(() => ({}));
check("서버 오류 → 500 고정 문구", g.status === 500 && gb.error === "서버 오류", `${g.status} ${JSON.stringify(gb)}`);
check("500 응답에 경로·SQL·표 이름이 없음", !LEAK.test(String(gb.error)) && !/severity|festival\.db|ui-suite/i.test(JSON.stringify(gb)), JSON.stringify(gb));

console.log(`\n통과 ${passed} · 실패 ${failed}`);
await cleanup();
process.exit(failed ? 1 : 0);
