// 개발·시연용 샘플 민원 CSV를 생성한다. (scripts/make_dev_seed.py 와 1:1 — 같은 시드면 같은 행이 나온다)
//
// ⚠ 주의 — 이 파일이 만드는 데이터는 **개발용 합성 데이터**입니다.
//    실제 방문객이 쓴 리뷰가 아닙니다.
//    제출용 리플레이 시드(200건)는 **공개 리뷰를 직접 수집·정제한 것**으로
//    교체해야 합니다. 합성 데이터를 실제 수집분인 것처럼 제출하면
//    설명회 주의사항 13번(허위·조작 금지) 위반입니다.
//
//    개발 중 파이프라인을 돌려보고, 심각도 역전 장면을 리허설하는 용도입니다.
//
// 사용법
//     node server/scripts/make_dev_seed.ts                  # seed/dev_sample.csv 생성
//     node server/scripts/make_dev_seed.ts --rows 200       # 건수 지정
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config, BASE_DIR } from "../core/config.ts";
import { isoformat } from "../core/datetime.ts";
import { Random } from "./_pyrandom.ts";

export const OUT = path.join(BASE_DIR, "seed", "dev_sample.csv");

// 유형별 예시 문장 (합성)
export const TEXTS: Record<string, string[]> = {
  parking: [
    "주차장에서 나가는 데 한 시간 넘게 걸렸어요",
    "주차 안내가 없어서 계속 같은 자리만 돌았습니다",
    "주차장이 이미 만차인데 입구에서 알려주지 않아요",
    "갓길에 다 세워놔서 차가 아예 못 지나갑니다",
    "주차 요원이 한 명뿐이라 정리가 안 됩니다",
    "임시주차장 위치를 아무도 모릅니다",
    "나가는 길이 한 차선이라 계속 막혀요",
  ],
  restroom: [
    "화장실 줄이 너무 깁니다 삼십 분 기다렸어요",
    "임시 화장실에 휴지가 없습니다",
    "화장실 위치 안내판이 안 보여요",
    "여자 화장실만 줄이 너무 깁니다",
    "화장실이 너무 더럽고 냄새가 심해요",
  ],
  price: [
    "어묵 한 그릇에 만 원은 너무합니다",
    "작년보다 음식값이 두 배는 오른 것 같아요",
    "현금만 받는 가게가 많아서 불편했습니다",
    "가격표가 안 붙어 있어서 나중에 비싸게 받았어요",
    "생수 한 병에 삼천 원 받더라고요",
  ],
  guide: [
    "안내도가 입구에만 있어서 중간에 길을 잃었어요",
    "프로그램 시간표를 어디서 보는지 모르겠습니다",
    "안내요원에게 물어봤는데 모른다고 하네요",
    "출구 표시가 없어서 한참 헤맸습니다",
  ],
  crowd: [
    "다리 위에 사람이 너무 몰려서 위험했어요",
    "인파 때문에 아이 손을 놓칠 뻔했습니다",
    "좁은 길에 양방향 통행이라 밀려다녔어요",
  ],
  safety: [
    "진입로에 불이 하나도 없어서 어두워서 넘어졌어요",
    "가로등이 없는 구간에서 발을 헛디뎠습니다",
    "조명이 꺼져 있어 바닥이 안 보입니다",
    "어두운 계단에서 미끄러질 뻔했어요",
    "난간이 흔들려서 위험해 보입니다",
  ],
  positive: [
    "등이 정말 예뻤어요 내년에 또 올게요",
    "아이들이 너무 좋아했습니다 감사합니다",
    "야경이 사진으로 담기지 않을 만큼 좋았어요",
    "자원봉사자분들이 정말 친절했습니다",
  ],
};

// 유형별 등장 비중 — 주차가 압도적으로 많고 안전은 적다.
// (건수 1위와 심각도 1위가 갈리는 장면을 만들기 위한 구성)
export const WEIGHTS: Record<string, number> = {
  parking: 30, restroom: 18, price: 16, guide: 13,
  positive: 14, crowd: 5, safety: 4,
};

export const ZONE_HINT: Record<string, string[]> = {
  parking: ["진주교 남단 주차장", "셔틀버스 승강장"],
  restroom: ["임시 화장실 A", "먹거리장터"],
  price: ["먹거리장터"],
  guide: ["촉석루 일원", "유등터널"],
  crowd: ["유등터널", "남강 수상무대"],
  safety: ["진주교 남단 주차장", "소망등 달기 구역"],
  positive: ["남강 수상무대", "촉석루 일원"],
};

export interface Row { posted_at: string; zone: string; text: string; _label_hint: string }

export function generate(n: number, days = 4, seed = 20261006): Row[] {
  const rng = new Random(seed);
  // datetime.now().replace(hour=17, minute=0, second=0, microsecond=0) - timedelta(days=days)
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 17, 0, 0, 0);

  const labels = Object.keys(WEIGHTS);
  const weights = labels.map((k) => WEIGHTS[k]);

  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const day = i * days / n;
    // 축제는 저녁에 사람이 몰린다 (17시~22시)
    // timedelta(days=day, minutes=m) — 마이크로초로 반올림한 뒤 초 단위로 자른다(isoformat timespec="seconds")
    const minutes = rng.randint(0, 300);
    const micro = Math.round(day * 86_400_000_000) + minutes * 60_000_000;
    const t = new Date(start.getTime() + Math.floor(micro / 1_000_000) * 1000);
    let label = rng.choices(labels, weights, 1)[0];

    // 마지막 날 후반부에 안전(조명) 민원을 집중시켜 급증을 만든다
    if (day > days - 0.35 && rng.random() < 0.45) label = "safety";

    rows.push({
      posted_at: isoformat(t),
      zone: rng.choice(ZONE_HINT[label] ?? config.ZONES),
      text: rng.choice(TEXTS[label]),
      _label_hint: label,        // 정확도 측정용 정답 라벨
    });
  }
  rows.sort((a, b) => (a.posted_at < b.posted_at ? -1 : a.posted_at > b.posted_at ? 1 : 0));
  return rows;
}

const cell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

async function main(): Promise<void> {
  const { values: a } = parseArgs({ options: { rows: { type: "string", default: "120" }, days: { type: "string", default: "4" } } });
  const nRows = Number(a.rows), days = Number(a.days);

  const rows = generate(nRows, days);
  mkdirSync(path.dirname(OUT), { recursive: true });
  const cols: (keyof Row)[] = ["posted_at", "zone", "text", "_label_hint"];
  // csv.DictWriter 기본: 줄 끝 \r\n, 필요한 칸만 따옴표, utf-8(BOM 없음)
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
  writeFileSync(OUT, csv, "utf-8");

  // collections.Counter.most_common() — 건수 내림차순, 같으면 먼저 나온 순
  const dist = new Map<string, number>();
  for (const r of rows) dist.set(r._label_hint, (dist.get(r._label_hint) ?? 0) + 1);
  console.log(`생성: ${OUT}  (${rows.length}건, ${days}일치)`);
  console.log("유형 분포 (건수 기준)");
  for (const [k, v] of [...dist].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${(config.LABELS[k] ?? k).padEnd(10)} ${String(v).padStart(4)}건`);
  }
  console.log("\n⚠ 개발용 합성 데이터입니다. 제출용 시드는 실제 수집 리뷰로 교체하세요.");
  console.log("   _label_hint 열은 분류 정확도 측정용 정답이며, 시스템은 읽지 않습니다.");
}

if (import.meta.main) {
  await main();
}
