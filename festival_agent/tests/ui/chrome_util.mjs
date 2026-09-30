// 점검 스크립트 공용 — 헤드리스 크롬을 깨끗이 끈다.
//
// chrome.kill() 은 본 프로세스만 강제로 끊는다. 그러면 하위(renderer · gpu · utility) 프로세스가 고아로 남아
// 프로필 파일을 붙잡고, 임시 폴더가 지워지지 않는다 (renderer 는 명령줄에 --user-data-dir 이 없어 경로로도 못 찾는다).
// 그래서 ① 크롬에게 스스로 닫으라고 하고(Browser.close) ② 안 닫히면 하위까지 한꺼번에 끈다(taskkill /T).
import { spawnSync } from "node:child_process";

export async function quitChrome(chrome, ws) {
  const exited = new Promise((r) => chrome.once("exit", r));
  try { ws?.send(JSON.stringify({ id: 999999, method: "Browser.close" })); } catch { /* 이미 끊김 */ }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2500))]);
  if (chrome.exitCode === null && chrome.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    else chrome.kill("SIGKILL");
  }
  try { ws?.close(); } catch { /* */ }
}
