// 규칙 기반 분류 — local 백엔드 전용. (core/rules.py 와 1:1)
//
// ⚠ 이것은 제출물이 아니다. LLM_BACKEND=anthropic 으로 돌리면 ①분류 에이전트가 이 자리를 대신하고, 이 모듈은 호출되지 않는다.
//   개발 중 API 비용 없이 오케스트레이션 전체(①②③④)를 돌리기 위한 대역이다. 키워드 규칙이라 자연어 이해가 없다.
import { config } from "./config.ts";

export type Row = Record<string, any>;

// 순서가 중요하다. 위에서부터 먼저 걸리는 것을 택한다.
export const KEYWORDS: [string, string[]][] = [
  ["safety", ["넘어", "어두", "조명", "불이 없", "불이 하나", "미끄러", "난간",
    "위험", "헛디", "다칠", "사고", "깜깜",
    "불났", "불이 났", "화재", "연기", "다쳤", "다침", "쓰러", "기절", "가스", "폭발", "붕괴",     // D5-72: 긴급 신호도 안전으로
    "물에 빠", "강에 빠", "익수", "떠내려", "구명조끼가 없", "구명조끼 없", "구명이 필요",         // D5-75: 남강 수면(유등) — D5-80: 구 단위로 좁힘
    "전선", "누전", "스파크", "합선",                                                                //   ('물에 젖은', '구명조끼 대여소', '빠짐없이'는 안전이 아니다)
    "불똥", "파편", "불티", "폭죽이 사람",
    "큰일 날 것", "큰일 날 거", "큰일날 것", "큰일날 거", "큰일 나겠", "큰일나겠", "큰일이 날"]],                 // D5-86: 구절 단위 — '큰일 났어요'(지난 일)·'큰일이네'는 안전이 아니다                                                          // D5-81: 불꽃놀이 낙하물 (구 단위 — '불꽃놀이 몇 시예요' 는 안전이 아니다. 패턴은 FIREWORK_DANGER)
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

// 혼잡 중 위험 신호(압사·밀림 등)가 있는 것만 안전으로 본다. 단순히 줄이 길다·붐빈다는 안전이 아니다 (D5-59, 판단 기준 양식과 같은 기준).
export const CROWD_DANGER = ["압사", "밀려", "밀치", "다칠", "쓰러", "끼일", "위험"];

/**
 * 불꽃놀이 낙하·충돌 위험 (D5-81): '불꽃이 관람석으로 떨어져요'처럼 사이에 말이 끼는 문장을 잡는다. 구 단위라 '불꽃놀이 몇 시예요'·'불꽃놀이가 예뻤어요'는 걸리지 않는다.
 * memory.risk_signals 도 같은 패턴을 쓴다.
 */
export const FIREWORK_DANGER = /(?:불꽃|폭죽|불똥)[^.!?\n]{0,14}(?:떨어|튀어|튀었|날아|맞았|맞아|터져서\s*(?:다|사람|아이))/;

/**
 * 명시적 생명위험어 (D5-83) — 이 말이 든 안전 민원은 **1건이어도 즉시** 등급이다 (압사·질식·쓰러짐·의식 없음·불/화재·물에 빠짐·감전 등).
 * 일반 안전(난간 흔들림·조명 없음 같은 시설 불편)은 1~2건이면 '높음'까지, 3건 이상이면 즉시(S-04). 공백을 뺀 글에서 찾는다.
 */
export const LIFE_DANGER_TERMS = ["압사", "질식", "쓰러", "의식이없", "의식을잃", "의식불명", "숨을못", "숨이안", "숨쉬기힘", "숨쉴수없", "심정지", "호흡곤란",
  "불났", "불이났", "불이붙", "불길", "화재", "폭발", "붕괴", "무너", "깔렸", "깔려", "감전", "익수", "물에빠", "강에빠", "떠내려",
  "가스누출", "가스가새", "가스냄새", "흉기", "찔렸"];

/** 글에 명시적 생명위험어가 있는가. */
export function life_danger(text: string | null | undefined): boolean {
  const flat = String(text ?? "").replace(/\s+/g, "");
  return LIFE_DANGER_TERMS.some((k) => flat.includes(k));
}

/** 한 유형의 키워드(또는 안전의 불꽃 패턴)가 글에 걸리는가. */
function hit(label: string, keys: string[], text: string): boolean {
  return keys.some((k) => text.includes(k)) || (label === "safety" && FIREWORK_DANGER.test(text));
}

/** 글에 키워드가 걸린 유형 전부 (순서는 KEYWORDS). 둘 이상이면 원인이 섞인 애매한 민원이다. */
export function matched_labels(text: string): string[] {
  return KEYWORDS.filter(([label, keys]) => hit(label, keys, text)).map(([label]) => label);
}

/** 민원 1건 → 분류 결과. 실제 에이전트와 같은 모양으로 돌려준다. */
export function classify(text: string): Row {
  for (const [label, keys] of KEYWORDS) {
    if (hit(label, keys, text)) return _result(label, true, text);
  }
  return _result(FALLBACK_LABEL, false);
}

function _result(label: string, matched: boolean, text = ""): Row {
  return {
    label,
    sentiment: SENTIMENT[label] ?? -0.5,
    is_safety: config.SAFETY_LABELS.has(label) || (label === "crowd" && CROWD_DANGER.some((k) => text.includes(k))),
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
