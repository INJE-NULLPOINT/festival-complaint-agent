// 담당 부서 연락처 표시 (D5-87 · D5-90): 기본 예시 번호(055-000-NNNN)인 동안은 '(예시 번호)'를 붙이고 전화 링크를 걸지 않는다.
// 설정 화면에서 실제 번호로 바꾸면 이 패턴에서 벗어나 링크가 걸린다.
import { esc } from "../ui";

export const isExampleNumber = (contact: string | null | undefined): boolean => /^\s*055-000-\d{4}\s*$/.test(contact ?? "");

/** 연락처 한 칸의 HTML — 예시 번호면 글자만 + '(예시 번호)', 아니면 전화 링크 */
export function contactHtml(contact: string): string {
  if (isExampleNumber(contact)) return `${esc(contact)} <span class="ex-num">(예시 번호)</span>`;
  return `<a href="tel:${esc(contact.replace(/[^0-9+]/g, ""))}">${esc(contact)}</a>`;
}
