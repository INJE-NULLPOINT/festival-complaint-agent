// 전역 설정 — 라벨 체계, 구역, 부서 매핑, 심각도 가중치. (core/config.py 와 1:1)
//
// 바꿀 수 있는 객체 `config` 하나로 내보낸다. 테스트가 Python 처럼 config.SAFETY_THRESHOLD 같은 값을 잠깐 바꿨다가 되돌리므로
// 읽는 쪽은 호출할 때마다 config.X 를 읽는다 (import 시점에 값을 복사하지 않는다).
// process.env 에 이미 값이 정해져 있으면(빈 문자열이라도) .env 로 덮지 않는다 — dotenv 기본 동작. 테스트·측정 스크립트가
// SUPABASE_DB_URL="" 로 운영 DB 를 끊는 데 기댄다 (server/README.md).
import path from "node:path";
import dotenv from "dotenv";

export const BASE_DIR = path.resolve(import.meta.dirname, "..", "..");   // festival_agent/
dotenv.config({ path: path.join(BASE_DIR, ".env"), quiet: true });

const env = (k: string, d = ""): string => process.env[k] ?? d;

export const config = {
  BASE_DIR,
  DB_PATH: env("DB_PATH", path.join(BASE_DIR, "festival.db")),

  // ── Supabase ──
  // SUPABASE_DB_URL 이 있으면 SQLite 대신 Supabase Postgres 를 쓴다. URL·서비스 키는 요청서 DOCX 를 Storage 에 올릴 때 쓴다.
  SUPABASE_DB_URL: env("SUPABASE_DB_URL"),
  SUPABASE_URL: env("SUPABASE_URL").replace(/\/+$/, ""),
  SUPABASE_SERVICE_KEY: env("SUPABASE_SERVICE_KEY"),
  SUPABASE_BUCKET: env("SUPABASE_BUCKET", "docs"),

  // ── 운영자 코드 (core/admin.ts) ──
  // 민원 지우기·되돌리기, 조치 상태 변경, 조치요청서 생성은 이 코드가 맞을 때만 실행한다. 비어 있으면 그 동작을 전부 거부한다.
  ADMIN_CODE: env("ADMIN_CODE"),

  // ── 모델 ──
  // 에이전트별로 effort 를 다르게 준다. 분류는 단순 판정이라 low 로 충분하고, 통합 에이전트는 결론을 내리는 자리라 high.
  MODEL: "claude-opus-5-5",
  EFFORT: { classifier: "low", monitor: "medium", dispatcher: "medium", supervisor: "high" } as Record<string, string>,

  // USD / 100만 토큰 (입력, 출력, 캐시 읽기). 원가 계산용 — 모델을 바꾸면 같이 바꾼다.
  PRICE_PER_MTOK: {
    "claude-opus-5": [5.0, 25.0, 0.5],
    "claude-opus-5-5": [4.0, 20.0, 0.2],
  } as Record<string, [number, number, number]>,

  // ── 분류 라벨 ──
  LABELS: {
    parking: "주차/교통",
    restroom: "화장실",
    price: "가격/바가지",
    guide: "안내/동선",
    crowd: "혼잡",
    safety: "안전",
    positive: "긍정",
  } as Record<string, string>,

  // 안전으로 간주하는 라벨 (심각도 ×2.0 가중 대상)
  SAFETY_LABELS: new Set(["safety", "crowd"]),

  // 심각도 계산에서 제외 (S-05)
  EXCLUDED_FROM_SEVERITY: new Set(["positive"]),

  // ── 부서 매핑 ──
  DEPARTMENT_MAP: {
    parking: ["교통과", "055-000-0001"],
    restroom: ["환경위생과", "055-000-0002"],
    price: ["지역경제과", "055-000-0003"],
    guide: ["관광진흥과", "055-000-0004"],
    crowd: ["안전총괄과", "055-000-0005"],
    safety: ["안전총괄과", "055-000-0005"],
  } as Record<string, [string, string]>,

  // ── 축제 / 구역 시드 ──
  FESTIVAL: {
    name: "진주남강유등축제",
    region: "경상남도 진주시",
    start_date: "2026-10-01",
    end_date: "2026-10-12",
  } as Record<string, string>,

  // 구역을 알 수 없는 민원은 zone_id=NULL 로 저장하고 화면·집계에서 이 이름으로 보인다. 첫 구역으로 넣지 않는다.
  ZONE_UNKNOWN: "구역 미상",

  ZONES: [
    "진주교 남단 주차장",
    "촉석루 일원",
    "남강 수상무대",
    "유등터널",
    "먹거리장터",
    "소망등 달기 구역",
    "임시 화장실 A",
    "셔틀버스 승강장",
  ],

  // ── 심각도 가중치 (S-01 ~ S-06) ──
  W_FREQ: 60.0,          // S-01 빈도 비중
  W_INTENSITY: 40.0,     // S-01 부정강도 비중
  W_SAFETY: 2.0,         // S-02 안전 가중
  W_SPIKE: 1.5,          // S-03 급증 가중
  W_PENDING: 1.2,        // S-06 미조치 경과 가중

  SAFETY_THRESHOLD: 3,       // S-04 안전 N건 이상이면 무조건 immediate
  SPIKE_WINDOW_MIN: 15,      // S-03 급증 판정 구간
  SPIKE_BASELINE_MIN: 60,    // S-03 비교 기준 구간
  SPIKE_MULTIPLIER: 2.0,     // S-03 급증 판정 배수
  SPIKE_MIN_RECENT: 3,       // B-02 급증으로 보려면 최근 구간에 최소 이 건수
  PENDING_MINUTES: 30,       // S-06 미조치 경과 기준

  DEFAULT_WINDOW_MIN: 60,    // 기본 심각도 윈도우

  // ── 경계 규칙 B-01 ~ B-04 ──
  MIN_WINDOW_TOTAL: 10,           // B-01 빈도비 = freq / max(창 전체 건수, 이 값)
  NONSAFETY_IMMEDIATE_MIN: 5,     // B-03 비안전 유형은 이 건수 미만이면 점수를 NONSAFETY_CAP 으로 자른다
  NONSAFETY_CAP: 79.9,            // B-03 (= 최고 high, 즉시 아님)
  SAFETY_FLOOR: 60.0,             // B-04 안전 유형은 1건이라도 점수 하한 (= 최소 high)
  REVIEW_CONFIDENCE: 0.3,         // 분류 신뢰도가 이 아래면 유형을 넣지 않고 운영자 확인(review)으로 보낸다

  GRADE_CUTOFF: [[80, "immediate"], [60, "high"], [40, "mid"]] as [number, string][],   // 미만은 low

  // ── 관제 '지금 조치할 일' 카드 (core/issues.ts) ──
  // 아래 목록은 프롬프트의 '참고 예시'일 뿐 고르도록 강제하지 않고, AI 문장이 검사에 실패했을 때 템플릿의 재료로도 쓴다.
  ACTION_CATALOG: {
    safety: [
      "위험 지점 통제선·안전펜스로 접근 차단",
      "해당 구간 안전요원 배치",
      "조명이 없거나 꺼진 구간 임시 조명 설치",
      "파손 시설물(난간·바닥 등) 사용 중지 및 긴급 보수 요청",
      "미끄럼·단차 구간 경고 표지·야광 테이프 부착",
    ],
    crowd: [
      "혼잡 구간 일방통행 동선 적용",
      "안전요원·안내요원 추가 배치",
      "안내방송으로 다른 동선·시간대로 분산 유도",
      "입구 진입 인원 일시 조절(대기 구역 운영)",
      "미아보호소·만남의 장소 위치 안내",
    ],
    parking: [
      "임시주차장 만차·잔여 정보 진입로 안내",
      "진입·출차 동선에 교통 수신호 요원 배치",
      "셔틀버스 증차 또는 배차 간격 단축 요청",
      "불법 주정차 구간 계도·단속 요청",
    ],
    restroom: [
      "해당 화장실 긴급 청소·비품 보충",
      "대기 줄이 긴 구역에 이동식 화장실 추가 배치",
      "가까운 다른 화장실 위치 안내 표지 설치",
      "고장 칸 사용 중지 표시 및 수리 요청",
    ],
    price: [
      "해당 부스 가격표 게시 여부 현장 점검",
      "가격 민원 부스 운영자 면담·시정 요청",
      "결제수단(카드 가능 여부) 부스 입구 표시",
    ],
    guide: [
      "주요 분기점에 안내 표지판 추가 설치",
      "프로그램 시간표·위치를 구역 게시판·안내소에 게시",
      "안내요원에게 최신 운영 정보 재공지",
      "안내방송으로 변경 사항 공지",
    ],
  } as Record<string, string[]>,

  // 카드 문장 검사에 쓰는 장소·시설 단어. 문장에 이 단어가 있으면 근거 민원 원문이나 구역 이름에도 있어야 한다.
  PLACE_WORDS: [
    "입구", "출구", "출입구", "다리", "계단", "난간", "화장실", "주차장", "터널", "부스", "무대",
    "승강장", "정류장", "가로등", "조명", "통로", "매표소", "진입로", "광장", "바닥",
    "에스컬레이터", "엘리베이터", "승강기", "펜스", "울타리", "안내소", "매점", "주차타워",
    "지하도", "육교",
  ],

  // 장소·시설 단어와 뜻이 통하는 민원 표현.
  PLACE_ALIASES: {
    조명: ["어둡", "어두", "깜깜", "불빛", "불이 ", "불도", "가로등"],
    가로등: ["어둡", "어두", "깜깜", "불빛", "불이 ", "불도", "조명"],
    부스: ["장터", "가게", "노점", "매장", "먹거리", "판매", "바가지", "가격"],
    승강장: ["셔틀", "버스", "배차"],
    정류장: ["셔틀", "버스", "배차"],
    주차장: ["주차"],
    출입구: ["입구", "출구"],
    입구: ["출입구"],
    출구: ["출입구"],
  } as Record<string, string[]>,

  // 오판 비용이 큰 조치 표현. 안전 유형 카드이면서 등급이 즉시일 때만 허용하고 '운영자 판단 필요'를 단다.
  ESCALATION_WORDS: ["중단", "폐쇄", "대피", "진입 통제", "출입 통제", "전면 통제", "통행 통제", "입장 통제",
    "출동", "119", "112", "경찰", "소방", "구급", "재난문자"],

  // ① 분류의 실행 방식 (claude_code·anthropic 경로에만 해당, local 대역은 무관). 기본값은 'agent'.
  //   agent    에이전트가 get_pending → (애매하면 lookup_similar) → save 를 스스로 부른다 (done_when 으로 보고 호출 생략)
  //   prefetch 대기 민원을 코드가 프롬프트에 넣어 준다. 모델은 애매할 때만 lookup_similar 를 부르고 save 한다
  CLASSIFY_MODE: env("CLASSIFY_MODE", "agent").trim().toLowerCase(),
  PREFETCH_LIMIT: 10,     // prefetch 모드에서 한 번에 프롬프트에 넣는 민원 수

  // ── 접수 도배 방지 (core/intake.ts) — 숫자는 설계값 ──
  DEDUP_ENABLED: env("DEDUP_ENABLED", "1") !== "0",                 // ① 같은 구역·같은 글 합치기
  DEDUP_WINDOW_SEC: 120,
  SUBMIT_LIMIT_ENABLED: env("SUBMIT_LIMIT_ENABLED", "1") !== "0",   // ② 출처(IP 하루 해시)별 폭주 제한
  SUBMIT_LIMITS: [[60, 10], [600, 30]] as [number, number][],       // (초, 건수): 1분 10건 · 10분 30건
  CROWD_FLAG_SEC: 60,
  CROWD_FLAG_MIN: 20,                                               // ③ 한 구역 1분 20건 이상이면 표시만

  // 사람이 읽는 문장·화면에는 점수 대신 한글 등급을 쓴다 (점수는 정렬·등급 판정 같은 내부 계산에만 쓴다)
  GRADE_KO: { immediate: "즉시", high: "높음", mid: "보통", low: "낮음" } as Record<string, string>,

  CARD_TEXT_MIN_INTERVAL: 60,   // 같은 카드의 문구를 다시 쓰는 최소 간격(초). 등급·조치 그룹이 바뀌면 즉시
};

export type Config = typeof config;
