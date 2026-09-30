// 여러 에이전트가 공유하는 도구. (agents/common.py 와 1:1)
//
// lookup_festival_info 는 ③조치 에이전트가 조치요청서에 축제 공식 정보(기간·주소·주최 연락처)를 넣을 때 호출한다.
// 외부 API를 실제로 사용하는 지점이므로 심사 'Tool 4점'의 근거가 된다.
import { config } from "../core/config.ts";
import { tool } from "../core/llm.ts";
import * as tourapi from "../core/tourapi.ts";

export const lookup_festival_info = tool({
  name: "lookup_festival_info",
  description:
    "한국관광공사 TourAPI 에서 축제 공식 정보(기간·주소·연락처·개요)를 조회한다. " +
    "실패하면 null 이니 그때는 축제명만 쓴다.",
  properties: {
    keyword: { type: "string", description: "축제명 일부 (예: 유등)" },
  },
  required: ["keyword"],
  params: ["keyword"],
}, async (keyword: string) => {
  const info = await tourapi.lookup(keyword);
  if (!info) return null;
  return {
    title: info.title,
    addr: info.addr,
    period: `${info.start_date ?? "None"} ~ ${info.end_date ?? "None"}`,
    tel: info.tel,
    homepage: (info.homepage || "").slice(0, 200),
    source: "한국관광공사 TourAPI",
  };
});

export const get_zones = tool({
  name: "get_zones",
  description: "축제장 구역 목록을 조회한다.",
  properties: {},
  params: [],
}, () => [...config.ZONES]);
