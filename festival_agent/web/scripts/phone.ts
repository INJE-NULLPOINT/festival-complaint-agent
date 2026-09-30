// 폰 확인용 서버 — `npm run phone` (할일 D5-27)
//   vite build --watch  : 소스를 고치면 빌드본(dist)이 자동으로 다시 만들어진다
//   vite preview        : 그 dist 를 4173 에서 서빙한다 (--host 라 같은 Wi-Fi 의 폰에서 열린다)
// 폰 브라우저는 개발 서버(5173)가 보내는 최신 문법을 못 읽을 수 있어 빌드본(구형 기준으로 낮춘 것)으로 본다.
// 새 패키지 없이 Node 만 쓴다. 한쪽이 죽으면 다른 쪽도 같이 끈다.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vite = join(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin", "vite.js");
const PORT = process.env.PHONE_PORT ?? "4173";

type Piped = ChildProcessByStdio<null, Readable, Readable>;
const run = (args: string[]): Piped => spawn(process.execPath, [vite, ...args], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
const pipe = (child: Piped, tag: string, onLine?: (line: string) => void): void => {
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) {
        const clean = l.replace(/\x1b\[[0-9;]*m/g, "");
        if (clean.trim()) console.log(`[${tag}] ${clean}`);
        onLine?.(clean);
      }
    });
  }
};

// watch 빌드는 dist 를 비우지 않아(바꾸는 사이 404 가 나지 않게) 다시 빌드할 때마다 새 이름의 파일이 쌓인다.
// 지금 index.html 이 쓰지 않는 파일만, 폰이 받는 중일 수 있으니 1분 지난 것부터 지운다.
function prune() {
  try {
    const dist = join(root, "dist");
    const html = readFileSync(join(dist, "index.html"), "utf8");
    const used = new Set([...html.matchAll(/assets\/([\w.-]+)/g)].map((m) => m[1]));
    for (const f of readdirSync(join(dist, "assets"))) {
      const file = join(dist, "assets", f);
      if (!used.has(f) && Date.now() - statSync(file).mtimeMs > 60_000) rmSync(file, { force: true });
    }
  } catch { /* 빌드 중이면 다음 기회에 */ }
}

let preview: Piped | null = null;
let closing = false;
const stopAll = (code = 0): void => {
  if (closing) return;
  closing = true;
  for (const c of [build, preview]) if (c && !c.killed) c.kill();
  setTimeout(() => process.exit(code), 300);
};

// 1) 먼저 깨끗한 빌드 한 번 (오래된 파일을 비운다)  2) watch 로 다시 빌드 (비우지 않음: 바꾸는 사이 404 가 나지 않게)
const first = run(["build"]);
pipe(first, "build");
const build = await new Promise<Piped>((resolve) => {
  first.on("exit", (code) => {
    if (code !== 0) { console.error("[phone] 첫 빌드 실패 — 위 오류를 고친 뒤 다시 실행하세요"); process.exit(code ?? 1); }
    const w = run(["build", "--watch", "--emptyOutDir", "false"]);
    pipe(w, "watch", (line) => { if (/built in/.test(line)) setTimeout(prune, 61_000); });
    w.on("exit", (c) => { if (!closing) { console.error(`[phone] watch 빌드가 멈췄습니다 (code ${c})`); stopAll(1); } });
    resolve(w);
  });
});

preview = run(["preview", "--host", "--port", PORT, "--strictPort"]);
pipe(preview, "preview");
preview.on("exit", (c) => { if (!closing) { console.error(`[phone] preview 가 멈췄습니다 (code ${c}) — 포트 ${PORT} 가 이미 쓰이고 있을 수 있습니다`); stopAll(1); } });

console.log(`[phone] 소스를 고치면 자동으로 다시 빌드됩니다.  폰: http://<PC IP>:${PORT}/?v=qr   (끄기: Ctrl+C)`);
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
