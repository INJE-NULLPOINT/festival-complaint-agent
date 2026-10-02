// 최소 CSV 파서 — Python csv.DictReader(utf-8-sig) 와 같은 결과 (따옴표·쉼표·줄바꿈 안의 따옴표). 외부 의존성 없음.
import { readFileSync } from "node:fs";

/** 텍스트 → 행 배열(문자열 배열). 따옴표 안의 쉼표·줄바꿈·"" 이스케이프를 처리한다. */
export function parse(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);       // utf-8-sig
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inq = false;
      } else field += c;
    } else if (c === '"') {
      inq = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));   // 빈 줄은 건너뛴다 (DictReader 동작)
}

/** csv.DictReader — 첫 줄을 열 이름으로 쓴다. 모자란 칸은 null(Python None), 넘치는 칸은 버린다. */
export function dict_reader(path: string): Record<string, string | null>[] {
  const rows = parse(readFileSync(path, "utf-8"));
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => {
    const o: Record<string, string | null> = {};
    head.forEach((h, i) => { o[h] = i < r.length ? r[i] : null; });
    return o;
  });
}
