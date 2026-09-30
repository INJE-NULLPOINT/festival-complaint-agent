// QR 만들기 (관리자) — 방문객 접수 화면(?v=qr) 주소 하나를 큰 QR 한 장으로 만들고, PNG 로 저장하거나 A4 한 장에 크게 인쇄한다.
// 조회 전용이라 운영자 코드가 필요 없다. QR 은 npm 패키지(qrcode)를 번들해 이 브라우저 안에서 만든다 — 외부 API 를 쓰지 않는다.
// 설정: 오류 정정 M · 여백 4칸 · PNG 한 칸 12픽셀. 구역은 QR 로 정하지 않는다(방문객이 화면에서 고른다).
import "./qr.css";
import QRCode from "qrcode";
import { esc } from "../ui";

const KEY = "festival_qr_base";

function loadBase(): string {
  try { return localStorage.getItem(KEY) || location.origin; } catch { return location.origin; }
}
function saveBase(v: string): void {
  try { localStorage.setItem(KEY, v); } catch { /* 저장을 못 해도 화면은 그대로 쓴다 */ }
}
/** 입력값 → 기본 주소. 비면 지금 origin, 주소 틀이 없으면 http:// 를 붙이고, 끝의 / 는 뗀다. */
function normalizeBase(raw: string): string {
  let v = raw.trim();
  if (!v) return location.origin;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "http://" + v;
  return v.replace(/\/+$/, "");
}
const isLocalOnly = (base: string) => /^https?:\/\/(localhost|127\.|\[?::1\]?)(:|\/|$)/i.test(base);

export async function renderQr(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <section class="card qr-top">
      <label class="qr-base">
        <span class="qr-l">접수 주소의 기본 URL</span>
        <input id="qr-base" type="text" inputmode="url" autocomplete="off" spellcheck="false" value="${esc(loadBase())}" />
      </label>
      <p class="qr-hint muted small">방문객 폰이 열 수 있는 주소여야 합니다(공개 주소, 또는 같은 Wi-Fi 의 PC 주소). 바꾸면 아래 QR 이 바로 다시 만들어집니다.</p>
      <p class="qr-warn small" id="qr-warn" role="status" hidden>이 주소(localhost)는 이 PC 에서만 열립니다. 폰에서는 열리지 않으니 공개 주소나 PC 의 Wi-Fi 주소로 바꿔 주세요.</p>
      <div class="qr-bar"><button type="button" class="btn primary" id="qr-print">인쇄</button><span class="muted small">A4 한 장에 크게 인쇄됩니다</span></div>
    </section>
    <section class="card qr-card" id="qr-card" aria-label="접수 QR"></section>`;

  const input = root.querySelector<HTMLInputElement>("#qr-base")!;
  const card = root.querySelector<HTMLElement>("#qr-card")!;
  const warn = root.querySelector<HTMLElement>("#qr-warn")!;
  let seq = 0;

  async function draw(): Promise<void> {
    const my = ++seq;
    const base = normalizeBase(input.value);
    warn.hidden = !isLocalOnly(base);
    const url = `${base}/?v=qr`;
    // 글자 전체를 byte 모드 한 덩어리로 넣는다 (주소는 영문·숫자·기호라 크기 차이가 작고, 읽기 호환성이 가장 넓다)
    const png = await QRCode.toDataURL([{ data: new TextEncoder().encode(url), mode: "byte" }], { errorCorrectionLevel: "M", margin: 4, scale: 12 });
    if (my !== seq) return;          // 입력이 더 바뀌었으면 이 결과는 버린다
    card.innerHTML = `
      <h2 class="qr-name">불편 접수</h2>
      <img class="qr-img" src="${png}" alt="불편 접수 QR" width="320" height="320" />
      <p class="qr-url">${esc(url)}</p>
      <p class="qr-cap">휴대폰 카메라로 찍으면 접수 화면이 열립니다</p>
      <a class="btn qr-save" href="${png}" download="qr_report.png">PNG 저장</a>`;
  }

  let timer: number | undefined;
  input.addEventListener("input", () => {
    saveBase(input.value);
    clearTimeout(timer);
    timer = window.setTimeout(() => void draw(), 200);
  });
  root.querySelector<HTMLButtonElement>("#qr-print")!.addEventListener("click", () => window.print());
  await draw();
}
