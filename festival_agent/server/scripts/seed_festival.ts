// D0 시드 — 관광공사 API로 경남 축제 정보를 받아 DB에 채운다. (scripts/seed_festival.py 와 1:1)
//
// 사용법
//     node server/scripts/seed_festival.ts --list                  경남 축제 목록 보기
//     node server/scripts/seed_festival.ts --pick 유등              해당 축제를 대상으로 설정
//     node server/scripts/seed_festival.ts --list --start 20261001  특정일 이후 축제
//
// 키가 없으면 목록 조회는 실패하지만, 시스템은 config.ZONES 수기 시드로
// 그대로 동작한다. (Fallback 확보 — 설명회 자료 D4 '실패 대비')
//
// 주의: 이 스크립트는 "대상 축제를 설정"하는 것이 목적이라 .env 가 가리키는 DB(운영이면 Supabase)에 쓴다.
//       (측정 스크립트와 달리 임시 DB 로 바꾸지 않는다 — Python 과 같음)
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../core/config.ts";
import * as db from "../core/db.ts";
import * as tourapi from "../core/tourapi.ts";

async function show_list(start: string | null): Promise<void> {
  if (!tourapi.available()) {
    console.log("TOURAPI_KEY 가 없습니다. .env 에 추가하세요.");
    console.log("  발급: data.go.kr → '한국관광공사_국문 관광정보 서비스_GW' 활용신청");
    console.log("        → 마이페이지 → 개발계정 → 일반 인증키(Decoding)");
    return;
  }
  let rows: Record<string, any>[];
  try {
    rows = await tourapi.search_festivals(tourapi.AREA_GYEONGNAM, start);
  } catch (exc) {
    if (!(exc instanceof tourapi.TourAPIError)) throw exc;
    console.log(`조회 실패: ${exc.message}`);
    return;
  }

  if (!rows.length) {
    console.log("결과가 없습니다. --start 날짜를 바꿔 보세요.");
    return;
  }
  console.log(`경남 축제 ${rows.length}건\n`);
  for (const r of rows) {
    console.log(`  [${r.content_id}] ${r.title}`);
    console.log(`      ${r.start_date} ~ ${r.end_date} · ${r.addr}`);
  }
}

function _fmt(yyyymmdd: string | null | undefined): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd || "";
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}`;
}

async function pick(keyword: string): Promise<void> {
  const info = await tourapi.lookup(keyword);
  if (!info) {
    console.log(`'${keyword}' 조회 실패 — 수기 시드(${config.FESTIVAL.name})를 그대로 씁니다.`);
    return;
  }

  await db.init_db();
  const conn = await db.connect();
  await conn.execute(
    `UPDATE festival SET name=?, region=?, start_date=?, end_date=?
               WHERE id=(SELECT id FROM festival LIMIT 1)`,
    [info.title, info.addr || config.FESTIVAL.region, _fmt(info.start_date), _fmt(info.end_date)],
  );

  console.log(`대상 축제를 설정했습니다: ${info.title}`);
  console.log(`  기간 ${_fmt(info.start_date)} ~ ${_fmt(info.end_date)}`);
  console.log(`  장소 ${info.addr}`);
  if (info.tel) console.log(`  연락처 ${info.tel}`);
  console.log("\n출처: 한국관광공사 TourAPI — 별지2 출처신고서에 기재하세요.");
}

const HELP = `usage: seed_festival.ts [-h] [--list] [--pick 키워드] [--start YYYYMMDD]

options:
  -h, --help        show this help message and exit
  --list            경남 축제 목록 조회
  --pick 키워드     대상 축제 설정
  --start YYYYMMDD  조회 시작일`;

async function main(): Promise<void> {
  const { values: a } = parseArgs({
    options: { list: { type: "boolean" }, pick: { type: "string" }, start: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (a.list) await show_list(a.start ?? null);
  else if (a.pick) await pick(a.pick);
  else console.log(HELP);
  await db.close_all();
}

if (import.meta.main) {
  await main();
}
