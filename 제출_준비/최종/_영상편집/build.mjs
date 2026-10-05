// 시연영상 편집본 생성기: 아래 SCENES 순서대로 시작 시각을 계산해 index.html 을 쓴다.
// 실행: node build.mjs  →  npx hyperframes render --fps 60
// 녹화 원본 시각(from)은 src/rec_pc_marks.txt 기준. 문구·숫자는 [총괄] 확정본만 쓴다.
import { writeFileSync } from "node:fs";

const PHONE_AT = 15.7, PHONE_LEN = 13.4;   // rec_phone 0초 = rec_pc 15.7초 (marks 마지막 줄)

const SCENES = [
  { type: "card", id: "s-title", dur: 4, html: `
    <div class="label">진주남강유등축제 · 민원 관제 · 시연</div>
    <h1>실시간 축제 민원 관제 <span class="hl">AI Agent</span></h1>
    <div class="team">팀 철철철 · 강은진 · 김동우 · 인제대학교</div>` },
  { type: "card", id: "s-prob", dur: 6, html: `
    <h2>건수가 아니라 <span class="hl">심각도</span>로 순위를 매깁니다</h2>
    <div class="vs">
      <div class="panel before"><div class="label">건수 1위</div><div class="what">주차/교통 54건</div><span class="badge mid">보통</span></div>
      <div class="arrow">→</div>
      <div class="panel after"><div class="label">심각도 1위</div><div class="what hl">안전 11건</div><span class="badge high">높음</span></div>
    </div>
    <div class="foot">개발용 합성 민원 160건 · 규칙 분류 기준</div>` },
  { type: "rec", from: 0, dur: 18.6, caps: [
      [0, "운영자가 띄워 두는 관제 화면 — 맨 위 ‘지금 조치할 일’이 에이전트가 쓴 브리핑입니다."],
      [8.5, "‘AI 동작 보기’를 켜면 다섯 에이전트가 부른 도구가 실시간으로 기록됩니다."],
      [13.6, "심각도 탭: 점수는 AI가 아니라 공개된 계산식(코드)이 정합니다."],
    ], zoom: [[9.5, [1240, 90, 680, 760]]] },
  { type: "rec", from: 18.6, dur: 17.4, phone: true, caps: [
      [0, "방문객이 QR 화면에서 민원을 남깁니다 — 이름·연락처 없이."],
      [5, "입력 문장은 시연용으로 지어낸 것입니다."],
      [10.5, "분류 에이전트가 유형과 안전 여부를 판정합니다."],
      [13.3, "방금 민원은 「안전」으로 분류 — 오른쪽에 save_classification 호출이 남습니다."],
    ], zoom: [[11, [1240, 90, 680, 760]]] },
  { type: "rec", from: 40.4, dur: 14, caps: [
      [0, "유등터널에서 몰림 민원 2건이 들어옵니다."],
      [7.5, "건수가 더 많은 주차보다 혼잡 카드가 1위로 올라옵니다."],
    ], zoom: [[8.5, [372, 120, 840, 700]]] },
  // 관제 화면 전체를 위에서 아래로 (src/page/page_control.png, 구역 좌표 = .json, 설명 = 사용설명서_관리자.md 4.2)
  { type: "tour", img: "src/page/page_control.png", cssW: 1920, cssH: 2582, cropX: 520, cropW: 1120, stops: [
      { z: [532, 20, 1088, 230], dur: 4, cap: "혼잡 카드가 1위가 된 관제 화면을 위에서부터 — 맨 위는 접수 누적 · 조치할 일 · 확인 필요 · 알림 숫자입니다." },
      { z: [532, 260, 1088, 299], dur: 5.5, cap: "‘지금 조치할 일’ — 에이전트가 쓴 브리핑. 첫 문장이 결론이고 아래에 근거가 붙습니다." },
      { z: [532, 576, 1088, 598], dur: 6, cap: "1번 카드 — 지금 가장 먼저: 해야 할 일 · 담당 부서 · 판단 근거가 된 민원 원문." },
      { z: [532, 1185, 1088, 386], dur: 4.5, cap: "나머지 카드는 심각도 순서로 한 줄씩 — 등급 배지와 건수만 보입니다." },
      { z: [1110, 1666, 510, 877], dur: 5, cap: "실시간 유입 — 방금 들어온 민원 원문과 유형 · 접수번호 · 구역 · 시각." },
    ] },
  { type: "rec", from: 101.6, dur: 6, caps: [
      [0, "[조치요청서 생성]을 누르면 조치 에이전트가 요청서를 씁니다."],
    ] },
  { type: "rec", from: 123, dur: 10, caps: [
      [0, "안전총괄과에 보낼 요청서 — 근거 민원 문장과 판정 이유가 들어 있습니다."],
    ], zoom: [[3.5, [360, 40, 1200, 860]]] },
  // 조치 화면 전체 (src/page/page_action.png, 설명 = 사용설명서_관리자.md 4.3)
  { type: "tour", img: "src/page/page_action.png", cssW: 1920, cssH: 1570, cropX: 520, cropW: 1120, stops: [
      { z: [553, 748, 1046, 70], dur: 4.5, cap: "조치요청서 · 처리 현황 — 상태를 요청 → 조치중 → 완료로 바꾸고, DOCX로 내려받습니다." },
      { z: [553, 827, 760, 591], dur: 5.5, cap: "요청서에는 유형 · 건수 · 심각도 · 판정 근거, 민원 원문 인용, 조치 제안이 들어갑니다." },
    ] },
  // AI 동작 보기 패널 (src/page/page_dev_log.png, 패널 폭 440)
  { type: "tour", img: "src/page/page_dev_log_top.png", cssW: 440, cssH: 900, cropX: 0, cropW: 440, k: 1.9, stops: [
      { z: [1, 118, 439, 135], dur: 4.5, cap: "다섯 에이전트 흐름 — 지금 어느 에이전트가 일하고 있는지 표시됩니다." },
      { z: [13, 319, 415, 420], dur: 5.5, cap: "기록 한 줄마다 에이전트 · 부른 도구 · 입력 · 결과가 그대로 남습니다." },
    ] },
  { type: "rec", from: 139.7, dur: 7, caps: [
      [0, "운영자가 상태를 ‘조치중’으로 바꿉니다."],
    ], zoom: [[0.6, [700, 40, 1220, 700]]] },
  { type: "rec", from: 152.1, dur: 6.6, caps: [
      [0, "다음 판정에 반영되어 관제 브리핑이 바뀐 상태로 다시 쓰입니다."],
    ] },
  { type: "card", id: "s-res", dur: 8, html: `
    <h2>개발 단계에서 <span class="hl">확인한 것</span></h2>
    <div class="stats">
      <div class="panel"><div class="big">5/5</div><div class="t">대표 테스트 케이스</div><div class="d">정상 · 모호 · 데이터 없음 · API 오류 · 악의적 입력</div></div>
      <div class="panel"><div class="big">96.9%</div><div class="t">분류 정확도 (31/32)</div><div class="d">합성 32건 기준 참고값</div></div>
      <div class="panel"><div class="big">18:34</div><div class="t">첫 신고에서 ‘즉시’</div><div class="d">이태원 112 공개 녹취 11건 시간순 재현 · 규칙 분류</div></div>
      <div class="panel"><div class="big">26/26</div><div class="t">프롬프트 공격 점검</div></div>
    </div>` },
  { type: "card", id: "s-end", dur: 4, html: `
    <h1>실시간 축제 민원 관제 <span class="hl">AI Agent</span></h1>
    <div class="team">팀 철철철 · 강은진 · 김동우 · 인제대학교</div>` },
];

// ── 시각 계산 · HTML 조립 ─────────────────────────────────────────
const FW = 1498, FH = 843;   // 녹화 창 크기 (아래 CSS .win 과 같음)
let t = 0, cards = "", recs = "", js = "", caps = "", recN = 0, tourN = 0;
const r = (x) => Math.round(x * 100) / 100;
for (const s of SCENES) {
  s.at = t;
  if (s.type === "card") {
    cards += `<section id="${s.id}" class="scene clip" data-start="${r(t)}" data-duration="${s.dur}" data-track-index="2">${s.html}</section>\n`;
    js += `rise("#${s.id} > *", ${r(t + 0.2)}, 0.15);\n`;
    js += `tl.to("#${s.id}", { opacity: 0, duration: 0.35 }, ${r(t + s.dur - 0.35)});\n`;
  } else if (s.type === "tour") {
    // 긴 캡처를 녹화 창과 같은 자리에 띄우고, 구역마다 멈추며 테두리 + 자막으로 짚는다
    const id = `tour${++tourN}`, k = s.k ?? FW / s.cropW;
    const ox = r((FW - s.cropW * k) / 2 - s.cropX * k);
    const yOf = ([, y, , h]) => r(Math.min(0, Math.max(FH - s.cssH * k, FH / 2 - k * (y + h / 2))));
    let boxes = "", tt = t + 0.4;
    s.dur = r(0.4 + s.stops.reduce((a, st) => a + st.dur, 0) + 0.3);
    js += `tl.set("#${id} .pan", { y: ${yOf(s.stops[0].z)} }, ${r(t)});\n`;
    js += `tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: 0.35 }, ${r(t)});\n`;
    s.stops.forEach((st, i) => {
      const [x, y, w, h] = st.z;
      boxes += `<div class="box" id="${id}b${i}" style="left:${r(x * k - 6)}px;top:${r(y * k - 6)}px;width:${r(w * k + 12)}px;height:${r(h * k + 12)}px"></div>`;
      if (i > 0) js += `tl.to("#${id} .pan", { y: ${yOf(st.z)}, duration: 1.1, ease: "power2.inOut" }, ${r(tt)});\n`;
      js += `tl.to("#${id}b${i}", { opacity: 1, duration: 0.4 }, ${r(tt + (i > 0 ? 0.9 : 0.2))});\n`;
      js += `tl.to("#${id}b${i}", { opacity: 0, duration: 0.3 }, ${r(tt + st.dur - 0.3)});\n`;
      caps += `<div class="cap clip" data-start="${r(tt)}" data-duration="${st.dur}" data-track-index="3">${st.cap}</div>\n`;
      tt += st.dur;
    });
    js += `tl.to("#${id}", { opacity: 0, duration: 0.3 }, ${r(t + s.dur - 0.3)});\n`;
    cards += `<section id="${id}" class="tour clip" data-start="${r(t)}" data-duration="${s.dur}" data-track-index="2"><div class="tview"><div class="pan" style="left:${ox}px;width:${r(s.cssW * k)}px;height:${r(s.cssH * k)}px"><img src="${s.img}" alt="">${boxes}</div></div></section>\n`;
  } else {
    const id = `z${++recN}`;
    recs += `<div class="zoom" id="${id}"><video id="v-${id}" class="clip" src="src/rec_pc.mp4" muted data-start="${r(t)}" data-duration="${s.dur}" data-media-start="${s.from}" data-track-index="1"></video></div>\n`;
    for (const [at, rect] of s.zoom ?? []) js += `zoomTo("#${id}", ${JSON.stringify(rect)}, ${r(t + at)});\n`;
    s.caps.forEach(([at, text], i) => {
      const end = i + 1 < s.caps.length ? s.caps[i + 1][0] : s.dur;
      caps += `<div class="cap clip" data-start="${r(t + at)}" data-duration="${r(end - at)}" data-track-index="3">${text}</div>\n`;
    });
    if (s.phone) {
      s.phoneSkip = Math.max(0, s.from - PHONE_AT);
      s.phoneAt = t + Math.max(0, PHONE_AT - s.from);
      s.phoneDur = PHONE_LEN - s.phoneSkip;
    }
  }
  t += s.dur;
}
const TOTAL = r(t);

// 녹화 창은 녹화 장면 동안만 보인다 (카드 장면에서는 숨김)
let winJs = "";
for (let i = 0; i < SCENES.length; i++) {
  const s = SCENES[i], prev = SCENES[i - 1], next = SCENES[i + 1];
  if (s.type !== "rec") continue;
  if (!prev || prev.type !== "rec") winJs += `tl.to("#w-pc", { opacity: 1, duration: 0.35 }, ${r(s.at)});\n`;
  if (!next || next.type !== "rec") winJs += `tl.to("#w-pc", { opacity: 0, duration: 0.3 }, ${r(s.at + s.dur - 0.3)});\n`;
}
const ph = SCENES.find((s) => s.phone);
const phoneHtml = ph ? `
<div class="phone" id="w-phone" data-layout-allow-overflow><video id="v-phone" class="clip" src="src/rec_phone.mp4" muted data-start="${r(ph.phoneAt)}" data-duration="${r(ph.phoneDur)}" data-media-start="${r(ph.phoneSkip)}" data-track-index="4"></video></div>
<div class="phone-tag" id="t-phone">방문객 휴대폰 · QR 접수 화면</div>` : "";
const phoneJs = ph ? `
tl.to("#w-pc", { x: -200, duration: 0.8, ease: "power2.inOut" }, ${r(Math.max(ph.at, ph.phoneAt - 0.8))});
tl.to("#w-phone, #t-phone", { opacity: 1, duration: 0.4 }, ${r(ph.phoneAt)});
tl.to("#w-phone, #t-phone", { opacity: 0, duration: 0.4 }, ${r(ph.phoneAt + ph.phoneDur - 0.4)});
tl.to("#w-pc", { x: 0, duration: 0.8, ease: "power2.inOut" }, ${r(ph.phoneAt + ph.phoneDur - 0.2)});` : "";

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=1920, height=1080">
<!-- build.mjs 가 만든 파일. 직접 고치지 말고 build.mjs 를 고친 뒤 다시 만든다. -->
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700;800&display=swap">
<style>
@font-face { font-family: "Pretendard"; font-weight: 400; src: url("assets/fonts/Pretendard-Regular.woff2") format("woff2"); }
@font-face { font-family: "Pretendard"; font-weight: 600; src: url("assets/fonts/Pretendard-SemiBold.woff2") format("woff2"); }
@font-face { font-family: "Pretendard"; font-weight: 700; src: url("assets/fonts/Pretendard-Bold.woff2") format("woff2"); }
@font-face { font-family: "Pretendard"; font-weight: 800; src: url("assets/fonts/Pretendard-ExtraBold.woff2") format("woff2"); }
:root { --bg: #0e131c; --card: #141c33; --line: rgba(120,150,200,.18); --cyan: #5cc8e8; --text: #f2f5fa; --muted: #8a94a6; --dim: #5d6678;
  --mono: "JetBrains Mono", ui-monospace, monospace; --b-high: #a84d00; --b-mid: #f2c94c; --b-mid-ink: #1b1b1b; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 1920px; height: 1080px; overflow: hidden; background: var(--bg); }
#root { position: relative; width: 100%; height: 100%; font-family: Pretendard, sans-serif; color: var(--text);
  background: radial-gradient(1000px 760px at 0% 100%, rgba(40,140,150,.14), transparent 70%), var(--bg); }
.hl { color: var(--cyan); }
.label { font-family: var(--mono); font-size: 22px; font-weight: 700; letter-spacing: .2em; color: var(--muted); }
#notice { position: absolute; top: 0; left: 0; right: 0; height: 48px; z-index: 50; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 600; color: var(--muted); }
/* 녹화 창: 원본 1920x1080 을 0.78배로 띄운다 (자르지 않음) */
.win { position: absolute; left: 211px; top: 60px; width: 1498px; height: 843px; overflow: hidden; border-radius: 18px; border: 1px solid var(--line); background: #000; opacity: 0; }
.zoom { position: absolute; top: 0; left: 0; width: 1920px; height: 1080px; transform-origin: 0 0; }
.zoom video { width: 1920px; height: 1080px; display: block; }
.phone { position: absolute; left: 1530px; top: 92px; width: 360px; height: 779px; overflow: hidden; z-index: 5; border-radius: 28px; border: 1px solid var(--line); box-shadow: 0 16px 50px rgba(0,0,0,.55); opacity: 0; }
.phone video { width: 360px; height: 779px; display: block; }
.phone-tag { position: absolute; left: 1530px; top: 58px; width: 360px; text-align: center; z-index: 6; font-family: var(--mono); font-size: 17px; font-weight: 700; letter-spacing: .08em; color: var(--muted); opacity: 0; }
.tour { position: absolute; inset: 0; }
.tview { position: absolute; left: 211px; top: 60px; width: 1498px; height: 843px; overflow: hidden; border-radius: 18px; border: 1px solid var(--line); background: #000; }
.pan { position: absolute; top: 0; }
.pan img { display: block; width: 100%; height: 100%; }
.box { position: absolute; border: 3px solid var(--cyan); border-radius: 14px; box-shadow: 0 0 24px rgba(92,200,232,.35); opacity: 0; }
.cap { position: absolute; left: 0; right: 0; top: 925px; height: 120px; display: flex; align-items: center; justify-content: center; font-size: 38px; font-weight: 700; letter-spacing: -.01em; }
.scene { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.scene h1 { font-size: 96px; font-weight: 800; letter-spacing: -.03em; margin-top: 30px; }
.scene h2 { font-size: 62px; font-weight: 800; letter-spacing: -.02em; }
.scene .team { font-size: 32px; color: var(--muted); margin-top: 50px; }
.foot { margin-top: 50px; font-size: 26px; color: var(--muted); }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 22px; }
.badge { display: inline-block; font-size: 30px; font-weight: 800; padding: 4px 24px; border-radius: 99px; color: #fff; }
.badge.high { background: var(--b-high); } .badge.mid { background: var(--b-mid); color: var(--b-mid-ink); }
.big { font-family: var(--mono); font-weight: 800; color: var(--cyan); text-shadow: 0 0 28px rgba(92,200,232,.35); }
.vs { display: flex; align-items: center; gap: 56px; margin-top: 70px; }
.vs .panel { width: 600px; height: 420px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; }
.vs .what { font-size: 66px; font-weight: 800; } .vs .before .what { color: var(--muted); }
.vs .arrow { font-size: 56px; color: var(--dim); }
.stats { display: grid; grid-template-columns: 760px 760px; gap: 30px; margin-top: 60px; }
.stats .panel { height: 250px; padding: 40px 50px; display: flex; flex-direction: column; justify-content: center; text-align: left; }
.stats .big { font-size: 96px; line-height: 1; } .stats .t { font-size: 30px; font-weight: 700; margin-top: 22px; color: #c9d1de; }
.stats .d { font-size: 22px; color: var(--muted); margin-top: 8px; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1920" data-height="1080">
<div class="win" id="w-pc" data-layout-allow-overflow>
${recs}
</div>${phoneHtml}
${caps}${cards}
<div id="notice">※ 배경 민원 24건과 유등터널 혼잡 2건은 시연용으로 만든 가상 민원입니다.</div>
</div>
<script>
const tl = gsap.timeline({ paused: true });
const ease = "power3.out";
const rise = (sel, at, stagger = 0.12) => tl.fromTo(sel, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6, ease, stagger }, at);
// 원본 좌표 [x, y, w, h] 영역이 창 가운데에 오도록 확대 (빈 가장자리는 안 보이게 고정)
const B = 0.78, FW = 1498, FH = 843;
tl.set(".zoom", { x: 0, y: 0, scale: B }, 0);
function zoomTo(id, [x, y, w, h], at, dur = 1.2) {
  const s = Math.max(B, Math.min(FW / w, FH / h, 1.4));
  const tx = Math.min(0, Math.max(FW - 1920 * s, FW / 2 - s * (x + w / 2)));
  const ty = Math.min(0, Math.max(FH - 1080 * s, FH / 2 - s * (y + h / 2)));
  tl.to(id, { x: tx, y: ty, scale: s, duration: dur, ease: "power2.inOut" }, at);
}
${winJs}${phoneJs}
${js}
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>
`;
writeFileSync(new URL("./index.html", import.meta.url), html);
console.log(`index.html: ${TOTAL}s, 장면 ${SCENES.length}개`);
for (const s of SCENES) console.log(`  ${String(Math.floor(s.at / 60))}:${String(Math.floor(s.at % 60)).padStart(2, "0")}  ${s.type === "card" ? s.id : s.type === "tour" ? "투어 " + s.img : "녹화 " + s.from + "s"}`);
