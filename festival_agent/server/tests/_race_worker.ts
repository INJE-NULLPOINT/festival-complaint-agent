// race.test.ts 의 일꾼 — 별도 스레드에서 같은 SQLite 파일에 붙어 intake.accept 를 한 번 부른다.
// 모두 준비될 때까지 SharedArrayBuffer 로 기다렸다가 동시에 출발한다 (Python threading.Barrier 대신).
import { workerData, parentPort } from "node:worker_threads";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_DB_URL = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_KEY = "";
process.env.DB_PATH = workerData.dbPath;

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const db = await import(pathToFileURL(join(SERVER, "core", "db.ts")).href);
const intake = await import(pathToFileURL(join(SERVER, "core", "intake.ts")).href);
db.use_path(workerData.dbPath);

const flag = new Int32Array(workerData.sab);
Atomics.add(flag, 0, 1);                 // 준비됨
Atomics.wait(flag, 1, 0);                // 출발 신호 기다림
try {
  const id = await intake.accept(1, workerData.text);
  parentPort!.postMessage({ id });
} catch (e: any) {
  parentPort!.postMessage({ error: String(e?.message ?? e) });
} finally {
  if (typeof db.close_all === "function") await db.close_all();
}
