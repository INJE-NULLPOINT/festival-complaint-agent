// 규칙 기반 분류 — local 백엔드 전용. (core/rules.py 와 1:1)
//
// ⚠ 이것은 제출물이 아니다. LLM_BACKEND=anthropic 으로 돌리면 ①분류 에이전트가 이 자리를 대신하고, 이 모듈은 호출되지 않는다.
//   개발 중 API 비용 없이 오케스트레이션 전체(①②③④)를 돌리기 위한 대역이다. 키워드 규칙이라 자연어 이해가 없다.
import { config } from "./config.ts";

export type Row = Record<string, any>;

// 순서가 중요하다. 위에서부터 먼저 걸리는 것을 택한다.
export const KEYWORDS: [string, string[]][] = [
  ["safety", ["넘어", "어두", "조명", "불이 없", "불이 하나", "미끄러", "난간",
    "위험", "헛디", "다칠", "사고", "깜깜"]],
  ["crowd", ["인파", "사람이 너무", "밀려", "몰려", "붐벼", "혼잡", "압사"]],
  ["parking", ["주차", "셔틀", "갓길", "차가 못", "차량", "견인", "정체"]],
  ["restroom", ["화장실", "휴지", "변기", "세면"]],
  ["price", ["비싸", "바가지", "가격", "현금만", "만원", "천원", "원이나", "값이",
    "원 받", "원이라", "원씩", "원에", "결제", "카드 안"]],
  ["guide", ["안내", "표지", "표시", "시간표", "길을", "헤맸", "안내도", "출구"]],
  ["positive", ["예뻤", "좋았", "친절", "감사", "또 올", "최고", "멋있", "행복"]],
];

// 유형별 기본 감정 강도. 실제 에이전트는 문장마다 다르게 준다.
export const SENTIMENT: Record<string, number> = {
  safety: -0.85, crowd: -0.70, parking: -0.60, restroom: -0.55,
  price: -0.50, guide: -0.45, positive: 0.80,
};

// 규칙에 걸리지 않은 민원. 라벨 체계에 '미분류'가 없어 guide 로 넘기지만, 신뢰도가 UNMATCHED_CONFIDENCE(< REVIEW_CONFIDENCE)라
// classifier.save_classification 이 유형을 저장하지 않고 status='review'(운영자 확인)로 돌린다.
export const FALLBACK_LABEL = "guide";
export const MATCHED_CONFIDENCE = 0.55;      // 규칙 기반이라 신뢰도를 낮게 잡는다
export const UNMATCHED_CONFIDENCE = 0.25;    // 미분류. config.REVIEW_CONFIDENCE 아래 → review
export const LOW_CONFIDENCE = 0.4;           // 이 아래는 인용 후보에서 후순위

/** 민원 1건 → 분류 결과. 실제 에이전트와 같은 모양으로 돌려준다. */
export function classify(text: string): Row {
  for (const [label, keys] of KEYWORDS) {
    if (keys.some((k) => text.includes(k))) return _result(label, true);
  }
  return _result(FALLBACK_LABEL, false);
}

function _result(label: string, matched: boolean): Row {
  return {
    label,
    sentiment: SENTIMENT[label] ?? -0.5,
    is_safety: config.SAFETY_LABELS.has(label),
    confidence: matched ? MATCHED_CONFIDENCE : UNMATCHED_CONFIDENCE,
    note: matched ? "키워드 규칙 일치 (local 대역)"
      : "규칙 미일치 — 미분류 (local 대역). 실제 에이전트가 재분류해야 함",
  };
}

/** 인용할 대표 민원을 고른다. 구역이 겹치지 않게 섞는다. 신뢰도 → 구역 분산 → 길이 순. */
export function pick_quotes(rows: Row[], n = 5): Row[] {
  const sort_key = (r: Row): [number, number] => {
    const conf = r.confidence;
    const low = conf !== null && conf !== undefined && conf < LOW_CONFIDENCE ? 1 : 0;
    return [low, -(r.raw_text ?? "").length];
  };
  const sorted = [...rows].sort((a, b) => {
    const ka = sort_key(a);
    const kb = sort_key(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });

  const seen = new Set<string>();
  const picked: Row[] = [];
  for (const r of sorted) {
    const zone = r.zone || "";
    if (seen.has(zone) && picked.length < n) continue;
    seen.add(zone);
    picked.push(r);
    if (picked.length >= n) break;
  }
  if (picked.length < n) {                       // 구역이 부족하면 남은 것으로 채운다
    for (const r of rows) {
      if (!picked.includes(r)) picked.push(r);
      if (picked.length >= n) break;
    }
  }
  return picked.slice(0, n);
}

/** local 대역의 조치 제안. config.ACTION_CATALOG(참고 예시) 앞 3개를 쓴다. */
export function suggestions_for(label: string): string[] {
  return (config.ACTION_CATALOG[label] ?? ["담당 부서 현장 확인 후 조치 방안 수립"]).slice(0, 3);
}
