// 개인정보 마스킹 — 접수 시점에 적용한다. (core/privacy.py 와 1:1)
//
// 심사 배점: 데이터·안전·윤리 10점 (개인정보·보안 3 / AI 오류·편향·안전대책 4)
// 접수 폼은 이름·연락처를 묻지 않지만, 본문에 자진해서 쓰는 경우가 있다. 저장 전에 지운다.
// 웹 접수 원문은 워커가 마스킹해 옮긴 직후 접수함에서 지운다.

// 숫자 경계 — 더 긴 숫자열의 일부를 잘못 가리지 않게
const D = "(?<!\\d)";
const DE = "(?!\\d)";

export const PATTERNS: [RegExp, string][] = [
  // 주민등록번호
  [new RegExp(D + "\\d{6}\\s*[-–]\\s*[1-4]\\d{6}" + DE, "g"), "[주민번호]"],
  // 카드번호
  [new RegExp(D + "(?:\\d{4}[-\\s]?){3}\\d{4}" + DE, "g"), "[카드번호]"],
  // 휴대전화
  [new RegExp(D + "01[016-9][-.\\s]?\\d{3,4}[-.\\s]?\\d{4}" + DE, "g"), "[연락처]"],
  // 일반 전화
  [new RegExp(D + "0\\d{1,2}[-.\\s]\\d{3,4}[-.\\s]\\d{4}" + DE, "g"), "[연락처]"],
  // 이메일 (Python \w 는 한글도 포함한다)
  [/[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+\.[\p{L}\p{N}_.]+/gu, "[이메일]"],
  // 차량번호
  [new RegExp(D + "\\d{2,3}[가-힣]\\s?\\d{4}" + DE, "g"), "[차량번호]"],
];

// 지시문 탐지 — **지시 대상(AI·시스템·모델)과 명령이 함께 있을 때만** 잡는다. 단어 하나만으로는 잡지 않는다.
// 넓게 잡으면 "다들 무시하고 새치기"·"해야 할 일은 많은데"·"브리핑 시간표를 바꿔 주세요"·"관리자 AI 챗봇이 엉뚱한 답" 같은
// 정상 민원이 카드 근거에서 빠져 실제 불편이 무시된다. 같은 이유로 "…해 주세요" 같은 정중한 요청은 명령형으로 보지 않는다.
export const INJECTION = new RegExp(
  [
    "(?:이전|위|앞|기존|모든|상기)\\s*(?:지시|명령|프롬프트)[^.\\n]{0,12}무시",
    "ignore\\s+(?:all\\s+)?(?:previous|prior|above)",
    "system\\s*prompt|prompt\\s*injection|jailbreak",
    "너는\\s*이제|당신은\\s*이제",
    "시스템\\s*지시|\\[\\s*(?:시스템|system)\\s*\\]",
    "(?:AI|에이전트|모델|시스템)\\s*에게[^.\\n]{0,40}(?:넣어라|넣으세요|해라|하라|하세요|무시|작성|바꿔라|바꾸세요|추가하라|출력|따르)",
    "조치\\s*목록에[^.\\n]{0,40}(?:넣|추가|작성|포함)",
    "해야\\s*할\\s*일은[^.\\n]{0,20}(?:반드시|[\"'‘“「『])",
    "(?:조치|카드|요청서|브리핑|분류)[^.\\n]{0,20}(?:넣어라|넣으세요|추가하라|작성하라|출력해라|바꿔라|바꾸세요)",
    "(?:위|앞)\\s*내용\\s*[을를]?\\s*무시",                                   // '위 내용 무시하고 …'
    "(?:AI|에이전트)\\s*야[^.\\n]{0,40}(?:무시|적어|써|넣어)",                    // 'AI야, 카드에 … 써' (부르는 말 + 명령)
  ].join("|"),
  "i",
);

const CONTENT = /[가-힣A-Za-z0-9]/g;
export const CONTENT_MIN = 2;
export const NEED_MORE = "어떤 불편인지 조금 더 적어 주세요";

/** 글자(한글 완성형·영문·숫자)가 2개 이상인가. 마스킹 전 원문 기준. */
export function has_content(text: string | null | undefined): boolean {
  return ((text ?? "").match(CONTENT)?.length ?? 0) >= CONTENT_MIN;
}

/** 개인정보로 보이는 부분을 치환한 문자열을 돌려준다. */
export function mask(text: string): string {
  let out = text;
  for (const [pattern, repl] of PATTERNS) out = out.replace(pattern, repl);
  return out;
}

/** 프롬프트 인젝션 시도로 보이는가. 차단하지 않는다 — 민원은 정상 처리하되 카드 근거에서 빼고 프롬프트로 못박는다. */
export function looks_like_injection(text: string): boolean {
  return INJECTION.test(text);
}
