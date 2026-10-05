// page_action.png/json 만 다시 — 혼잡 요청서가 펼쳐진 상태로. 직전 세션이 남긴 시연 DB 의 복사본에 서버만 붙인다 (워커·실모델 없음).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { freePort, killTree, openChrome, quitChrome } from "../../festival_agent/tests/ui/lib.ts";
const HERE = import.meta.dirname, APP = path.resolve(HERE, "..", "..", "festival_agent");
const OUT = path.join(HERE, "_영상편집", "src", "page");
const tmp = mkdtempSync(path.join(tmpdir(), "fixpa-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<any> | any, ms = 10000, step = 200) => { const t0 = Date.now(); for (;;) { let v: any = null; try { v = await fn(); } catch { /* */ } if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const kids: ChildProcess[] = [];
try {
  const db = path.join(tmp, "copy.db"); { const src = new DatabaseSync(path.join(APP, "output", "demo_festival.db"), { readOnly: true }); src.exec(`VACUUM INTO '${db.split(path.sep).join("/")}'`); src.close(); }          // WAL 에 남은 최신 내용까지 복사
  const d = new DatabaseSync(db); d.exec("UPDATE worker_status SET last_at = '2099-01-01T00:00:00' WHERE name <> '_backend'"); d.close();
  const env = { ...process.env, SUPABASE_DB_URL: "", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", DB_PATH: db, LLM_BACKEND: "local", DOCS_DIR: path.join(tmp, "docs"), VITE_NO_WATCH: "1" };
  const ap = await freePort(), vp = await freePort();
  kids.push(spawn(process.execPath, ["server/webapi.ts", "--port", String(ap)], { cwd: APP, env: env as any, stdio: "ignore" }));
  kids.push(spawn(process.execPath, [path.join(APP, "web/node_modules/vite/bin/vite.js"), "--port", String(vp), "--strictPort", "--host", "127.0.0.1"], { cwd: path.join(APP, "web"), env: { ...env, WEBAPI_PORT: String(ap) } as any, stdio: "ignore" }));
  const base = `http://127.0.0.1:${vp}`;
  await until(async () => (await fetch(`${base}/api/control`)).ok, 40000, 400);
  const o = await openChrome({ prefix: "fixpa-", width: 1920, height: 1080 });
  const { send, ev } = o;
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  const metrics = (h: number) => send("Emulation.setDeviceMetricsOverride", { width: 1920, height: h, deviceScaleFactor: 2, mobile: false });
  await metrics(1080);
  await send("Page.navigate", { url: `${base}/#action` });
  await until(() => ev(`document.querySelectorAll(".docs li").length > 0`), 20000); await sleep(2500);
  const findLi = `[...document.querySelectorAll(".docs li")].find((l) => l.querySelector(".name")?.textContent.includes("혼잡"))`;
  for (let k = 0; k < 4 && !(await ev(`!!document.querySelector(".docs li.open .paper")`)); k++) { await ev(`(${findLi})?.querySelector("[data-toggle]")?.click()`); await sleep(1500); }
  console.log("펼침:", await ev(`!!document.querySelector(".docs li.open .paper")`));
  const docH = () => ev(`Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))`);
  await ev(`window.scrollTo(0, 0)`); await sleep(500);
  let h = await docH();
  for (let k = 0; k < 3; k++) { await metrics(h); await sleep(900); const h2 = await docH(); if (h2 === h) break; h = h2; }
  const ZONES = `(() => { const out = []; const sy = window.scrollY, sx = window.scrollX; const list = [["조치 대상 (심각도 순)", "#app section.card:has(.targets)", false], ["#", ".targets li", true, "'조치 대상 · ' + (e.querySelector('.name')?.textContent || '')"], ["조치요청서 · 처리 현황", "#app section.card:has(.docs)", false], ["#", ".docs > li", true, "'요청서 · ' + (e.querySelector('.name')?.textContent || '')"], ["조치요청서 미리보기 (종이)", ".docs li.open .paper", false], ["처리 상태 버튼 (요청·조치중·완료)", ".docs li.open .seg", false]]; for (const [name, sel, all, nameJs] of list) { const els = all ? [...document.querySelectorAll(sel)] : [document.querySelector(sel)]; els.forEach((e, i) => { if (!e) return; const r = e.getBoundingClientRect(); if (!r.width || !r.height) return; const nm = nameJs ? String(new Function("e", "i", "return " + nameJs)(e, i) || name) : name; out.push({ name: nm.trim().split(/\\s+/).join(" "), selector: all ? sel + ":nth-of-type(" + (i + 1) + ")" : sel, x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) }); }); } return out.sort((a, b) => a.y - b.y || a.x - b.x); })()`;
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, "page_action.png"), Buffer.from(r.data, "base64"));
  const z = await ev(ZONES);
  writeFileSync(path.join(OUT, "page_action.json"), JSON.stringify({ file: "page_action.png", note: "좌표는 CSS px (PNG 는 가로세로 2배). origin 은 PNG 왼쪽 위가 페이지의 어디인지", cssWidth: 1920, cssHeight: h, scale: 2, origin: { x: 0, y: 0 }, zones: z }, null, 1));
  console.log(`page_action.png css 1920x${h} · 구역 ${z.length}`);
  await quitChrome(o.chrome, o.ws);
} catch (e) { console.error(e); process.exitCode = 1; } finally { kids.forEach(killTree); await sleep(500); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } process.exit(process.exitCode ?? 0); }
