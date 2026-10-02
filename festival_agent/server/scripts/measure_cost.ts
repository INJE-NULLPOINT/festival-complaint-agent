// 민원 1건 처리 원가 — agent_log 의 모델 호출 토큰 기록을 합산한다. (scripts/measure_cost.py 와 1:1)
//
// 실제 모델(LLM_BACKEND=anthropic)로 돌린 기록만 센다. local 대역은 API 를
// 부르지 않으므로 기록이 없고, 그 경우 원가측정.md 를 만들지 않는다
// (숫자 없는 문서를 만들면 할일.md 가 완료로 오판한다).
//
// --backend claude_code 는 참고 모드다. Claude Code CLI 경유 기록(cli_call)을 세고,
// 비용은 CLI 가 보고한 금액(total_cost_usd)을 쓴다. 결과는 원가측정_참고.md 로만
// 쓴다 — 제출용 원가측정.md 는 API 실측으로만 만든다 (할일 D6-5).
//
// DB: 기본은 **빈 임시 SQLite** 라 기록이 없다고 나온다. 집계할 기록이 있는 DB 를 줄 때만 읽는다.
//     --db <파일>   그 SQLite 파일의 기록을 읽는다 (읽기만; 예: 시연·측정에 쓴 임시 DB)
//     --live-db     .env 의 운영 DB(Supabase 등)의 기록을 읽는다 (읽기만)
//
// 사용법
//     node server/cli.ts cycle                              # 실제 모델로 한 바퀴 이상 돌린 뒤
//     node server/scripts/measure_cost.ts --live-db         # → ../제출_준비/원가측정.md
//     node server/scripts/measure_cost.ts --live-db --since 2026-10-03T00:00
//     node server/scripts/measure_cost.ts --live-db --backend claude_code   # → 원가측정_참고.md
import "./_safe_env.ts";
import path from "node:path";
import { parseArgs } from "node:util";
import { BASE_DIR, config } from "../core/config.ts";
import * as db from "../core/db.ts";
import { fixed, floatstr } from "../core/pyfmt.ts";
import { comma, comma_fixed, exists, read_text, use_temp_db, write_text, ymd_hm } from "./_common.ts";

const ROOT = BASE_DIR;
const PROJECT = path.dirname(ROOT);
const OUT: Record<string, string> = {
  anthropic: path.join(PROJECT, "제출_준비", "원가측정.md"),
  claude_code: path.join(PROJECT, "제출_준비", "원가측정_참고.md"),
};
const ACTION: Record<string, string> = { anthropic: "api_call", claude_code: "cli_call" };
const CLI_USD = /\$([0-9.]+)/;        // cli_call 요약 예: "success · $0.0622"

// 모델이 직접 분류한 건만 센다 — 캐시·local 대역·스텁 분류에는 모델 비용이 없다
const MODEL_CLASSIFIED = `status='done' AND processed_at >= ?
    AND COALESCE(agent_note,'') <> 'cache'
    AND COALESCE(agent_note,'') NOT LIKE '%(local 대역)%'
    AND COALESCE(agent_note,'') NOT LIKE 'STUB%'`;

type R = Record<string, any>;

async function main(): Promise<number> {
  const { values: a } = parseArgs({
    options: {
      backend: { type: "string", default: "anthropic" },
      since: { type: "string", default: "" },
      note: { type: "string", default: "" },
      previous: { type: "string", default: "" },
      "usd-krw": { type: "string", default: "0" },
      db: { type: "string" },
      "live-db": { type: "boolean" },
    },
  });
  const backend = a.backend as string;
  if (!["anthropic", "claude_code"].includes(backend)) {
    console.error("--backend 은 anthropic 또는 claude_code 여야 합니다.");
    return 2;
  }
  const since = a.since as string;
  const usd_krw = Number(a["usd-krw"]);
  const cli = backend === "claude_code";
  const action = ACTION[backend], out_path = OUT[backend];

  if (a.db) { config.SUPABASE_DB_URL = ""; config.DB_PATH = path.resolve(a.db as string); }
  else use_temp_db("cost.db");

  await db.init_db();
  const conn = await db.connect();
  const per_agent: R[] = (await conn.execute(
    `SELECT agent, COUNT(*) calls, SUM(input_tokens) i, SUM(output_tokens) o,
                      SUM(cache_read_tokens) c, AVG(latency_ms) lat,
                      MIN(created_at) first, MAX(created_at) last
               FROM agent_log WHERE action=? AND created_at >= ?
               GROUP BY agent ORDER BY agent`, [action, since])).fetchall();
  const reported: Record<string, number> = {};
  if (cli) {
    for (const r of (await conn.execute(
      "SELECT agent, output_summary s FROM agent_log WHERE action=? AND created_at >= ?", [action, since])).fetchall()) {
      const m = CLI_USD.exec(r.s || "");
      reported[r.agent] = (reported[r.agent] ?? 0.0) + (m ? parseFloat(m[1]) : 0.0);
    }
  }
  const n_done = Number((await conn.execute(`SELECT COUNT(*) n FROM classification WHERE ${MODEL_CLASSIFIED}`, [since])).fetchone()!.n);
  const n_cache = Number((await conn.execute(
    `SELECT COUNT(*) n FROM classification
               WHERE status='done' AND processed_at >= ? AND agent_note='cache'`, [since])).fetchone()!.n);

  if (!per_agent.length) {
    console.log(`${action} 기록이 없습니다. LLM_BACKEND=${backend} 로 \`node server/cli.ts cycle\` 을 ` +
      "먼저 돌리세요. (local 대역은 모델을 부르지 않습니다)");
    await db.close_all();
    return 1;
  }

  const [pin, pout, pcache] = config.PRICE_PER_MTOK[config.MODEL];
  const N = (x: any): number => Number(x ?? 0);

  const usd = (r: R): number => {
    if (cli) return reported[r.agent] ?? 0.0;       // CLI 가 보고한 금액 (캐시 생성 할증 포함)
    return (N(r.i) * pin + N(r.o) * pout + N(r.c) * pcache) / 1e6;
  };

  const total = per_agent.reduce((s, r) => s + usd(r), 0);
  const calls = per_agent.reduce((s, r) => s + N(r.calls), 0);
  const clsRow = per_agent.find((r) => r.agent === "classifier");
  const cls = clsRow ? usd(clsRow) : 0.0;
  const krw = (x: number): string => (usd_krw ? ` (약 ${comma_fixed(fixed(x * usd_krw, 1))}원)` : "");
  const first = per_agent.map((r) => r.first).reduce((m, x) => (x < m ? x : m));
  const last = per_agent.map((r) => r.last).reduce((m, x) => (x > m ? x : m));

  let lines: string[];
  if (cli) {
    lines = [
      "# 민원 1건 처리 원가 — 참고값 (Claude Code CLI 경유)",
      "",
      "> **참고값입니다. 제출용 원가가 아닙니다.** API 키 없이 `LLM_BACKEND=claude_code` 로",
      "> 돌린 기록입니다. CLI 는 호출마다 자체 프롬프트와 캐시 생성이 붙어 API 직접 호출과",
      "> 토큰·금액이 다릅니다. 제출용 `원가측정.md` 는 `--backend anthropic` 실측으로 만듭니다.",
      "",
      `측정 ${ymd_hm(new Date())} · 모델 \`${config.MODEL}\` · ` + "비용 = CLI 가 보고한 금액(total_cost_usd)의 합",
    ];
  } else {
    lines = [
      "# 민원 1건 처리 원가 실측",
      "",
      `측정 ${ymd_hm(new Date())} · 모델 \`${config.MODEL}\` · ` +
        `단가 입력 $${floatstr(pin)}/출력 $${floatstr(pout)}/캐시읽기 $${floatstr(pcache)} (100만 토큰당)`,
    ];
  }
  if (a.note) lines.push(`측정 조건: ${a.note}`);
  lines.push(
    `집계 범위: agent_log \`${action}\` 기록` + (since ? `, ${since} 이후` : " 전체") + ` (${first} ~ ${last})`,
    "",
    "| 에이전트 | 호출 | 입력 토큰 | 출력 토큰 | 캐시 읽기 | 평균 지연 | 비용(USD) | 호출 1회당 |" + (n_done ? " 민원 1건당 |" : ""),
    "|---|---|---|---|---|---|---|---|" + (n_done ? "---|" : ""),
    ...per_agent.map((r) =>
      `| ${r.agent} | ${r.calls} | ${comma(N(r.i))} | ${comma(N(r.o))} | ${comma(N(r.c))} ` +
      `| ${fixed(N(r.lat) / 1000, 1)}s | $${fixed(usd(r), 4)} | $${fixed(usd(r) / N(r.calls), 4)} |` +
      (n_done ? ` $${fixed(usd(r) / n_done, 5)} |` : "")),
    `| **합계** | ${calls} | | | | | **$${fixed(total, 4)}**${krw(total)} | |` + (n_done ? ` **$${fixed(total / n_done, 5)}** |` : ""),
    "",
    `- 모델이 직접 분류한 민원 ${n_done}건 · 캐시로 처리 ${n_cache}건 ` + "(local 대역·스텁 분류는 세지 않음)",
  );
  if (n_done) {
    lines.push(
      `- **분류 원가: 민원 1건당 $${fixed(cls / n_done, 5)}**${krw(cls / n_done)} (①분류 에이전트만)`,
      `- **전체 원가: 민원 1건당 $${fixed(total / n_done, 5)}**${krw(total / n_done)} ` + "(②③④ 배후 에이전트 비용을 분류 건수로 나눈 값)",
    );
  }
  if (n_cache) {
    const both = n_done + n_cache;
    lines.push(`- 캐시 포함 시 1건당 $${fixed(total / both, 5)}${krw(total / both)} (${both}건 기준 · ` +
      "캐시를 누가 채웠는지는 구분하지 않음 — local 대역 분류가 채운 캐시도 포함될 수 있음)");
  }
  lines.push(
    "",
    "주의: ②③④는 민원 건수가 아니라 주기마다 돈다. 민원이 적은 시간대에는 1건당",
    "원가가 올라가고 붐빌 때는 내려간다. 비즈니스 모델에는 측정 조건(건수·주기)을 함께 적을 것.",
    "",
  );
  if (a.previous && exists(a.previous as string)) {
    const prev = read_text(a.previous as string).trim().split("\n");
    const body = prev.filter((l) => !l.startsWith("> ")).slice(1);        // 제목·참고 안내 박스는 중복이라 뺀다
    lines.push("---", "", "## 이전 측정 (이 측정 전 기록 · 조건이 달라 직접 비교하지 말 것)", "", ...body, "");
  }
  write_text(out_path, lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`→ ${out_path}`);
  await db.close_all();
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
