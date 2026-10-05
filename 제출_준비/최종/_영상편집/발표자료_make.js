// 발표자료_철철철.pptx 생성 (다크 네이비·시안, 10장, 발표 멘트는 노트)
const pptxgen = require("pptxgenjs");
const path = require("path");
const { applyTheme } = require("C:/Users/12kjm/.claude/skills/synced/20a91682-88a3-4864-90a4-c521fb65b664_dc817bb6-90ca-45e2-9376-3e29c4a6ff5b/pptx/scripts/apply_theme.js");

const IMG = path.join(__dirname, "img");
const OUT = process.argv[2];
const THEME = {
  name: "Festival Navy",
  headFontFace: "Malgun Gothic",
  bodyFontFace: "Malgun Gothic",
  colors: {
    dk1: "F2F5FA", lt1: "0E131C", dk2: "8A94A6", lt2: "141C33",
    accent1: "5CC8E8", accent2: "A84D00", accent3: "F2C94C", accent4: "2A3550",
    accent5: "C9D1DE", accent6: "1B2440", hlink: "5CC8E8", folHlink: "8A94A6",
  },
};
const HEX = { bg: "0E131C", card: "141C33", line: "2A3550", cyan: "5CC8E8", text: "F2F5FA", muted: "8A94A6", soft: "C9D1DE", high: "A84D00", mid: "F2C94C", ink: "1B1B1B" };

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";            // 13.33 x 7.5
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "실시간 축제 민원 관제 AI Agent";
pres.author = "팀 철철철";
const C = pres.SchemeColor;

pres.defineSlideMaster({
  title: "COVER",
  background: { color: HEX.bg },
  objects: [],
});
pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: HEX.bg },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.35, w: 12.1, h: 0.95, fontSize: 36, bold: true, color: C.text1, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { text: { text: "팀 철철철 · 실시간 축제 민원 관제 AI Agent", options: { x: 0.6, y: 7.0, w: 8, h: 0.3, fontSize: 11, color: C.text2, margin: 0 } } },
  ],
  slideNumber: { x: 12.2, y: 7.0, w: 0.5, h: 0.3, fontSize: 11, color: HEX.muted, align: "right" },
});

const T = (slide, text, o) => slide.addText(text, { isTextBox: true, margin: 0, fontFace: THEME.bodyFontFace, color: C.text1, valign: "top", ...o });
const panel = (slide, x, y, w, h, name) => slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.15, fill: { color: C.background2 }, line: { color: HEX.line, width: 1 }, objectName: name });
const badge = (slide, text, x, y, kind) => slide.addText(text, { isTextBox: true, x, y, w: 1.1, h: 0.45, shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: 0.22, align: "center", valign: "middle", margin: 0, fontSize: 18, bold: true,
  fill: { color: kind === "high" ? HEX.high : HEX.mid }, color: kind === "high" ? "FFFFFF" : HEX.ink });
const shot = (slide, file, x, y, w, h, name) => {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x - 0.04, y: y - 0.04, w: w + 0.08, h: h + 0.08, rectRadius: 0.1, fill: { color: "000000" }, line: { color: HEX.line, width: 1 }, objectName: name + " 틀" });
  slide.addImage({ path: path.join(IMG, file), x, y, w, h, objectName: name });
};
const num = (slide, n, x, y) => slide.addText(n, { isTextBox: true, x, y, w: 0.6, h: 0.6, shape: pres.shapes.OVAL, fill: { color: HEX.line }, color: C.accent1, bold: true, fontSize: 20, align: "center", valign: "middle", margin: 0 });

// 1. 표지 ─────────────────────────────────────────────
pres.addSection({ title: "표지" });
{
  const s = pres.addSlide({ masterName: "COVER", sectionTitle: "표지" });
  T(s, "진주남강유등축제 · 민원 관제", { x: 0.7, y: 1.2, w: 6, h: 0.4, fontSize: 16, bold: true, color: C.accent1, charSpacing: 2 });
  T(s, [{ text: "실시간 축제 민원 관제", options: { breakLine: true } }, { text: "AI Agent", options: { color: HEX.cyan } }], { x: 0.7, y: 1.8, w: 6.2, h: 1.9, fontSize: 44, bold: true });
  T(s, "건수가 아니라 심각도로 봅니다", { x: 0.7, y: 3.9, w: 6, h: 0.5, fontSize: 24, color: C.text2 });
  T(s, [{ text: "팀 철철철 · 강은진 · 김동우", options: { breakLine: true } }, { text: "인제대학교 · 대학부 ⑤ 경남 지역혁신·공공서비스" }], { x: 0.7, y: 5.3, w: 6.2, h: 0.9, fontSize: 16, color: C.text2, lineSpacingMultiple: 1.3 });
  shot(s, "brief.png", 7.3, 1.5, 5.4, 2.27, "관제 화면 캡처");
  T(s, "실제 관제 화면 · 가상 민원으로 시연", { x: 7.3, y: 3.95, w: 5.4, h: 0.3, fontSize: 12, color: C.text2 });
  s.addNotes("안녕하세요, 철철철 팀입니다. 축제 민원을 건수가 아니라 심각도로 정리해서, 운영자가 지금 무엇부터 해야 하는지 바로 보여 주는 AI 에이전트를 만들었습니다.");
}

// 2. 문제 ─────────────────────────────────────────────
pres.addSection({ title: "문제와 해결" });
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "문제와 해결" });
  s.addText("안전 민원은 적게 들어와서 묻힙니다", { placeholder: "title" });
  panel(s, 0.9, 1.7, 5.1, 3.9, "건수 기준 카드");
  T(s, "건수 순서로 보면", { x: 1.2, y: 2.0, w: 4.5, h: 0.4, fontSize: 18, color: C.text2, align: "center" });
  T(s, "1위", { x: 1.2, y: 2.6, w: 4.5, h: 0.5, fontSize: 22, bold: true, color: C.text2, align: "center" });
  T(s, "주차/교통 54건", { x: 1.2, y: 3.2, w: 4.5, h: 0.8, fontSize: 36, bold: true, color: C.text2, align: "center" });
  badge(s, "보통", 2.9, 4.3, "mid");
  T(s, "→", { x: 6.1, y: 3.2, w: 1.1, h: 0.8, fontSize: 40, color: C.text2, align: "center" });
  panel(s, 7.3, 1.7, 5.1, 3.9, "심각도 기준 카드");
  T(s, "심각도 순서로 보면", { x: 7.6, y: 2.0, w: 4.5, h: 0.4, fontSize: 18, color: C.text2, align: "center" });
  T(s, "1위", { x: 7.6, y: 2.6, w: 4.5, h: 0.5, fontSize: 22, bold: true, color: C.text2, align: "center" });
  T(s, "안전 11건", { x: 7.6, y: 3.2, w: 4.5, h: 0.8, fontSize: 40, bold: true, color: C.accent1, align: "center" });
  badge(s, "높음", 9.3, 4.3, "high");
  T(s, "개발용 합성 민원 160건 · 규칙 분류 기준", { x: 0.9, y: 6.0, w: 11.5, h: 0.4, fontSize: 14, color: C.text2, align: "center" });
  s.addNotes("축제에는 주차나 가격 민원이 많이 들어오고, 안전 민원은 적게 들어옵니다. 건수 순서로 보면 어두운 길이나 인파 밀림 같은 안전 민원이 뒤로 밀립니다. 그래서 저희는 순위를 건수가 아니라 심각도로 매깁니다. 개발용 합성 데이터에서 건수 1위는 주차였지만, 심각도 1위는 안전이었습니다.");
}

// 3. 해결 ─────────────────────────────────────────────
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "문제와 해결" });
  s.addText("운영자는 ‘지금 할 일’ 한 화면만 봅니다", { placeholder: "title" });
  const steps = [["1", "방문객이 QR로 민원 접수", "이름·연락처 없이"], ["2", "AI가 분류하고 심각도로 순위", "안전이 건수에 묻히지 않게"], ["3", "지금 할 일 · 담당 부서 요청서", "운영자는 확인하고 지시만"]];
  steps.forEach(([n, h, d], i) => {
    const y = 1.75 + i * 1.6;
    num(s, n, 0.8, y + 0.1);
    T(s, h, { x: 1.6, y, w: 4.6, h: 0.5, fontSize: 24, bold: true });
    T(s, d, { x: 1.6, y: y + 0.55, w: 4.6, h: 0.4, fontSize: 18, color: C.text2 });
  });
  shot(s, "card.png", 6.6, 1.6, 6.1, 3.72, "1번 카드 캡처");
  T(s, "관제 화면의 1번 카드 — 해야 할 일 · 담당 부서 · 근거 민원", { x: 6.6, y: 5.5, w: 6.1, h: 0.4, fontSize: 14, color: C.text2 });
  s.addNotes("사용자는 축제 운영 담당 주무관입니다. 방문객은 구역마다 붙은 QR로 이름 없이 민원을 남깁니다. 에이전트가 민원을 분류하고 심각도로 순위를 매겨서, 지금 먼저 할 일과 담당 부서에 보낼 요청서까지 만들어 둡니다. 운영자는 이 한 화면을 보고 지시만 하면 됩니다.");
}

// 4. Agent 구조 ─────────────────────────────────────────
pres.addSection({ title: "Agent 구조" });
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Agent 구조" });
  s.addText("AI 에이전트 5개가 나눠서 일합니다", { placeholder: "title" });
  const agents = [["01", "분류", "유형 · 안전 판단"], ["02", "계획", "이번에 할 일"], ["03", "감시", "등급과 경보"], ["04", "조치", "부서 요청서"], ["05", "통합", "순위 · 브리핑"]];
  agents.forEach(([n, nm, d], i) => {
    const x = 0.6 + i * 2.48;
    panel(s, x, 1.75, 2.2, 2.9, nm + " 에이전트");
    T(s, n, { x: x + 0.25, y: 1.95, w: 1.7, h: 0.6, fontSize: 28, bold: true, color: C.accent1 });
    T(s, nm, { x: x + 0.25, y: 2.65, w: 1.7, h: 0.6, fontSize: 28, bold: true });
    T(s, d, { x: x + 0.25, y: 3.4, w: 1.85, h: 0.6, fontSize: 17, color: C.accent5 });
    if (i < 4) T(s, "›", { x: x + 2.2, y: 2.9, w: 0.28, h: 0.5, fontSize: 24, color: C.text2, align: "center" });
  });
  T(s, "각 에이전트가 필요한 도구를 스스로 골라 부르고,", { x: 0.6, y: 5.15, w: 12, h: 0.45, fontSize: 22 });
  T(s, "어떤 도구를 불렀는지는 관제 화면 ‘AI 동작 보기’에 그대로 남습니다.", { x: 0.6, y: 5.65, w: 12, h: 0.45, fontSize: 22 });
  s.addNotes("에이전트는 다섯 개입니다. 접수된 민원은 분류 에이전트가 바로 처리하고, 판단은 주기마다 돕니다. 계획 에이전트가 이번 주기에 무엇을 할지 정하면, 감시·조치·통합 에이전트가 각자 필요한 도구를 불러 결과를 냅니다. 어떤 도구를 언제 불렀는지는 화면에서 그대로 볼 수 있습니다.");
}

// 5. 계산식 ──────────────────────────────────────────────
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Agent 구조" });
  s.addText("심각도는 AI가 아니라 공개된 계산식이 정합니다", { placeholder: "title" });
  panel(s, 0.6, 1.9, 3.6, 2.4, "입력");
  T(s, "입력", { x: 0.9, y: 2.1, w: 3, h: 0.4, fontSize: 16, color: C.text2 });
  T(s, "건수 · 안전 여부\n급증 · 미조치 시간", { x: 0.9, y: 2.6, w: 3.1, h: 1.4, fontSize: 22, bold: true, lineSpacingMultiple: 1.2 });
  T(s, "→", { x: 4.3, y: 2.7, w: 0.6, h: 0.7, fontSize: 32, color: C.text2, align: "center" });
  panel(s, 5.0, 1.9, 3.4, 2.4, "계산식");
  T(s, "계산", { x: 5.3, y: 2.1, w: 3, h: 0.4, fontSize: 16, color: C.text2 });
  T(s, "공개된 계산식\n(코드)", { x: 5.3, y: 2.6, w: 2.9, h: 1.4, fontSize: 24, bold: true, color: C.accent1, lineSpacingMultiple: 1.2 });
  T(s, "→", { x: 8.5, y: 2.7, w: 0.6, h: 0.7, fontSize: 32, color: C.text2, align: "center" });
  panel(s, 9.2, 1.9, 3.5, 2.4, "등급");
  T(s, "결과", { x: 9.5, y: 2.1, w: 3, h: 0.4, fontSize: 16, color: C.text2 });
  s.addText("즉시", { isTextBox: true, x: 9.5, y: 2.65, w: 1.3, h: 0.5, shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: 0.25, fill: { color: "C0392B" }, color: "FFFFFF", bold: true, fontSize: 18, align: "center", valign: "middle", margin: 0 });
  badge(s, "높음", 11.0, 2.67, "high");
  badge(s, "보통", 9.6, 3.4, "mid");
  s.addText("낮음", { isTextBox: true, x: 11.0, y: 3.4, w: 1.1, h: 0.45, shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: 0.22, fill: { color: HEX.line }, color: C.accent5, bold: true, fontSize: 18, align: "center", valign: "middle", margin: 0 });
  T(s, "같은 상황이면 언제나 같은 순서가 나옵니다", { x: 0.6, y: 4.9, w: 12, h: 0.5, fontSize: 24, bold: true });
  T(s, "AI는 이 계산 함수를 도구로 불러 결과를 받고, 무엇을 알리고 어떻게 설명할지만 판단합니다", { x: 0.6, y: 5.5, w: 12, h: 0.5, fontSize: 20, color: C.text2 });
  s.addNotes("중요한 원칙이 하나 있습니다. 심각도 점수는 AI가 정하지 않습니다. 건수, 안전 여부, 급증, 미조치 시간을 넣으면 공개된 계산식이 등급을 냅니다. 감시 에이전트는 이 계산 함수를 도구로 부를 뿐이라, 같은 상황이면 항상 같은 순서가 나옵니다. 안전 가중과 즉시 기준은 행정안전부 매뉴얼과 가이드라인을 대조해 정했습니다.");
}

// 6. 핵심 기능 ─────────────────────────────────────────
pres.addSection({ title: "핵심 기능과 시연" });
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "핵심 기능과 시연" });
  s.addText("접수부터 요청서까지 한 흐름입니다", { placeholder: "title" });
  const feats = [["QR 접수", "이름·연락처 없이 접수"], ["자동 분류", "애매하면 ‘확인 필요’로"], ["관제 카드 · 브리핑", "지금 먼저 할 일을 한 문단으로"], ["조치요청서", "담당 부서용 문서를 DOCX로"], ["상태 반영", "조치가 늦으면 순위가 오름"], ["설정만 바꿔 이관", "구역·부서·유형은 설정 데이터"]];
  feats.forEach(([h, d], i) => {
    const x = 0.6 + (i % 2) * 3.65, y = 1.65 + Math.floor(i / 2) * 1.75;
    panel(s, x, y, 3.45, 1.55, h);
    T(s, h, { x: x + 0.25, y: y + 0.2, w: 3.0, h: 0.5, fontSize: 22, bold: true, color: C.accent1 });
    T(s, d, { x: x + 0.25, y: y + 0.75, w: 3.0, h: 0.7, fontSize: 15, color: C.accent5 });
  });
  shot(s, "flow.png", 8.6, 1.65, 3.4, 4.87, "AI 동작 보기 캡처");
  T(s, "AI 동작 보기 — 에이전트가 부른 도구 기록", { x: 8.2, y: 6.6, w: 4.6, h: 0.3, fontSize: 12, color: C.text2, align: "center" });
  s.addNotes("핵심 기능은 여섯 가지입니다. QR 접수와 개인정보 가림, 자동 분류와 확인 필요 처리, 관제 카드와 브리핑, 담당 부서 조치요청서, 조치 상태 반영, 그리고 설정만 바꿔 다른 축제로 옮기는 것입니다. 오른쪽은 에이전트가 실제로 부른 도구 기록 화면입니다.");
}

// 7. 시연 ──────────────────────────────────────────────
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "핵심 기능과 시연" });
  s.addText("시연영상 2분 57초", { placeholder: "title" });
  shot(s, "doc.png", 0.6, 1.6, 6.1, 4.97, "조치요청서 캡처");
  const flow = [["입력", "방문객이 QR로 민원을 남김"], ["판단", "분류 에이전트가 「안전」으로 분류"], ["도구 호출", "혼잡 민원이 1위로, 요청서 작성"], ["결과", "운영자가 상태를 바꾸면 다시 판정"]];
  flow.forEach(([h, d], i) => {
    const y = 1.7 + i * 1.2;
    T(s, h, { x: 7.2, y, w: 1.7, h: 0.5, fontSize: 22, bold: true, color: C.accent1 });
    T(s, d, { x: 8.9, y: y + 0.05, w: 4.0, h: 0.9, fontSize: 18 });
  });
  T(s, "이태원 112 재현 · 설정 · DOCX 등 모든 기능을 영상에 담았습니다", { x: 7.2, y: 6.45, w: 5.6, h: 0.4, fontSize: 13, color: C.text2 });
  s.addNotes("(시연영상 재생, 2분 57초) 실제 입력부터 에이전트 판단, 도구 호출, 결과까지 이어서 보여 드리겠습니다. 배경 민원은 시연용으로 만든 가상 민원입니다.");
}

// 8. 성과 ──────────────────────────────────────────────
pres.addSection({ title: "성과와 다음 단계" });
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "성과와 다음 단계" });
  s.addText("개발 단계에서 확인한 것", { placeholder: "title" });
  const stats = [["5/5", "대표 테스트 케이스", "정상 · 모호 · 데이터 없음 · API 오류 · 악의적 입력"], ["96.9%", "분류 정확도", "합성 32건 기준 참고값"], ["26/26", "프롬프트 공격 점검", ""], ["18:34", "첫 신고에서 ‘즉시’", "이태원 112 공개 녹취 시간순 재현 · 규칙 분류"]];
  stats.forEach(([v, h, d], i) => {
    const x = 0.6 + (i % 2) * 6.15, y = 1.65 + Math.floor(i / 2) * 2.6;
    panel(s, x, y, 5.95, 2.4, h);
    T(s, v, { x: x + 0.35, y: y + 0.25, w: 5.3, h: 1.0, fontSize: 54, bold: true, color: C.accent1 });
    T(s, h, { x: x + 0.35, y: y + 1.3, w: 5.3, h: 0.45, fontSize: 22, bold: true });
    if (d) T(s, d, { x: x + 0.35, y: y + 1.8, w: 5.3, h: 0.4, fontSize: 14, color: C.text2 });
  });
  s.addNotes("개발 단계 결과입니다. 정상, 모호, 데이터 없음, API 오류, 악의적 입력 다섯 가지 대표 테스트를 모두 통과했고, 합성 민원 32건에서 분류 정확도는 96.9%였습니다. 프롬프트 공격 점검 26건도 모두 통과했습니다. 이태원 참사 당일 공개된 112 신고를 시간순으로 넣었을 때, 첫 신고 시각인 18시 34분에 바로 '즉시' 등급이 떴습니다. 이 재현은 규칙 분류로 한 것입니다.");
}

// 9. 비즈니스 모델 ─────────────────────────────────────
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "성과와 다음 단계" });
  s.addText("설정만 바꾸면 다른 축제로 옮겨 갑니다", { placeholder: "title" });
  panel(s, 0.6, 1.7, 5.6, 4.6, "고객");
  T(s, "고객", { x: 0.95, y: 1.95, w: 5, h: 0.4, fontSize: 16, color: C.text2 });
  T(s, "시군 축제 담당 부서", { x: 0.95, y: 2.4, w: 5, h: 0.6, fontSize: 26, bold: true });
  T(s, "18개 시군", { x: 0.95, y: 3.4, w: 5, h: 0.9, fontSize: 48, bold: true, color: C.accent1 });
  T(s, "축제 135개", { x: 0.95, y: 4.4, w: 5, h: 0.9, fontSize: 48, bold: true, color: C.accent1 });
  T(s, "경상남도 기준", { x: 0.95, y: 5.5, w: 5, h: 0.4, fontSize: 14, color: C.text2 });
  const bm = [["시작", "행사 단위 패키지"], ["확장", "연간 구독 (금액은 실증 후)"], ["이관", "구역·부서·유형만 설정에서 바꿈"]];
  bm.forEach(([h, d], i) => {
    const y = 1.75 + i * 1.5;
    num(s, String(i + 1), 6.8, y + 0.1);
    T(s, h, { x: 7.6, y, w: 5, h: 0.5, fontSize: 24, bold: true });
    T(s, d, { x: 7.6, y: y + 0.55, w: 5.2, h: 0.5, fontSize: 18, color: C.accent5 });
  });
  s.addNotes("고객은 시군의 축제 담당 부서입니다. 경상남도만 해도 18개 시군에 축제가 135개 있습니다. 행사 단위 패키지로 시작해 연간 구독으로 넓히고, 금액은 실증을 거쳐 정하려 합니다. 구역, 부서, 민원 유형이 설정 데이터라서 다른 축제로 옮길 때 코드를 고치지 않습니다.");
}

// 10. 한계와 다음 단계 ─────────────────────────────────
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "성과와 다음 단계" });
  s.addText("남은 과제와 다음 단계", { placeholder: "title" });
  const lim = [["합성 데이터로만 검증", "실제 축제 민원은 아직"], ["응답 지연 측정 5회", "더 많은 반복 측정 필요"], ["관리자 로그인 없음", "운영 전 접근 제어 추가"]];
  lim.forEach(([h, d], i) => {
    const y = 1.7 + i * 1.5;
    panel(s, 0.6, y, 6.2, 1.3, h);
    T(s, h, { x: 0.95, y: y + 0.2, w: 5.6, h: 0.5, fontSize: 22, bold: true });
    T(s, d, { x: 0.95, y: y + 0.75, w: 5.6, h: 0.4, fontSize: 16, color: C.text2 });
  });
  panel(s, 7.3, 1.7, 5.4, 4.3, "다음 단계");
  T(s, "다음 단계", { x: 7.65, y: 1.95, w: 4.8, h: 0.4, fontSize: 16, color: C.text2 });
  T(s, "실제 축제 민원으로\n다시 검증", { x: 7.65, y: 2.5, w: 4.8, h: 1.4, fontSize: 32, bold: true, color: C.accent1, lineSpacingMultiple: 1.15 });
  T(s, "그 뒤 시군 축제에서 실증", { x: 7.65, y: 4.2, w: 4.8, h: 0.5, fontSize: 22 });
  T(s, "감사합니다 · 팀 철철철", { x: 7.65, y: 5.2, w: 4.8, h: 0.5, fontSize: 18, color: C.text2 });
  s.addNotes("한계도 분명합니다. 아직 합성 데이터로만 검증했고, 응답 지연은 다섯 번만 쟀으며, 관리자 로그인이 없습니다. 다음 단계는 실제 축제 민원으로 다시 검증하고, 시군 축제에서 실증하는 것입니다. 감사합니다.");
}

(async () => {
  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote", OUT);
})();
