// 이태원 112 공개 신고 기록 시간순 재현 (D5-84): 신고가 들어온 순서대로 등급이 언제 바뀌는지 본다.
//   S-04 (안전 3건 이상 → 즉시)  S-03 (최근 15분 유입 급증 ×1.5)
// 실제 신고 시각·문장은 seed/itaewon_112.csv 에 있어야 한다 (posted_at,zone,text — 공개 기록에서 옮긴 값만. 이 저장소에는 아직 없다).
// 규칙(local) 분류 결과이고 DB·모델을 쓰지 않는다. 이 시스템이 사건을 '예측'했다는 뜻이 아니라, 같은 기록을 그 시각에 받았다면 규칙이 언제 즉시로 올렸을지를 보여 준다.
//
// 사용법
//     node server/scripts/replay_itaewon.ts                    seed/itaewon_112.csv 재현 → tests/itaewon_replay.md
//     node server/scripts/replay_itaewon.ts --file X.csv       다른 신고 기록으로
import "./_safe_env.ts";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BASE_DIR } from "../core/config.ts";
import { dict_reader } from "../core/csv.ts";
import { timeline, type Call } from "./_itaewon.ts";

const { values: a } = parseArgs({
  options: {
    file: { type: "string", default: path.join(BASE_DIR, "seed", "itaewon_112.csv") },
    out: { type: "string", default: path.join(BASE_DIR, "tests", "itaewon_replay.md") },
    "live-db": { type: "boolean" },
  },
  strict: false,
});

if (!existsSync(a.file as string)) { console.error(`신고 기록 파일이 없습니다: ${a.file}\n(posted_at,zone,text 열 — 공개 기록의 시각·내용만)`); process.exit(2); }
const calls: Call[] = dict_reader(a.file as string).filter((r) => (r.text || "").trim()).map((r) => ({ posted_at: r.posted_at ?? "", zone: r.zone ?? "", text: r.text ?? "" }));
if (!calls.length) { console.error("신고 기록이 비어 있습니다 (seed/itaewon_112.csv 에 공개 기록의 시각·내용을 넣어 주세요)."); process.exit(2); }
const tl = timeline(calls, { tail_min: 30 });
const hm = (s?: string): string => (s ? s.slice(11, 16) : "—");

const lines = [
  "# 이태원 112 공개 신고 시간순 재현", "",
  `- 입력 ${calls.length}건 (${calls[0].posted_at} ~ ${calls[calls.length - 1].posted_at}) · 1분 간격 · 그 시각까지 들어온 신고 누적 (S-04 만 같은 구역 1시간)`,
  "- **분류값은 모델이 아니라 규칙(local) 대역이 붙인 것이다.** 표현 차이로 안전 신고를 놓칠 수 있고, 모델 분류 결과가 아니다.", "",
  "| 유형 | 즉시 등급 | 안전 3건(S-04) | 급증(S-03) |", "|---|---|---|---|",
];
for (const l of new Set(tl.rows.map((r) => r.label as string))) lines.push(`| ${l} | ${hm(tl.first_immediate[l])} | ${hm(tl.first_s04[l])} | ${hm(tl.first_spike[l])} |`);
writeFileSync(a.out as string, lines.join("\n") + "\n", "utf8");
console.log(lines.slice(4).join("\n"));

