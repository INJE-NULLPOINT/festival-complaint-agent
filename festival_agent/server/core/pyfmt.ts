// Python 과 같은 숫자 표기 — 점수·계산식 문자열이 Python 과 글자까지 같아야 테스트를 그대로 옮겨 비교할 수 있다.
// (JS toFixed 는 딱 반(0.125 → '0.13')에서 올림하지만 Python 은 짝수로 맞춘다('0.12'). 이 차이를 여기서 맞춘다.)

/** Python f"{x:.{d}f}" */
export function fixed(x: number, d: number): string {
  if (!Number.isFinite(x)) return String(x);
  // toFixed 는 이진 double 의 정확한 십진 전개를 쓴다. 정확히 반(…5000…)이면 Python 처럼 짝수 쪽으로.
  const wide = Math.abs(x).toFixed(Math.min(d + 25, 100));
  const cut = wide.length - 25;
  if (/^50*$/.test(wide.slice(cut)) && wide.slice(cut).replace(/0/g, "") === "5") {
    const kept = wide.slice(0, cut).replace(/\.$/, "");
    const lastDigit = Number(kept[kept.length - 1]);
    const base = kept;
    let s: string;
    if (lastDigit % 2 === 0) s = base;
    else s = (Math.abs(x) + 10 ** -d * 0.5).toFixed(d);        // 홀수면 올림
    if (d === 0 && s.includes(".")) s = s.split(".")[0];
    return (x < 0 && Number(s) !== 0 ? "-" : x < 0 ? "-" : "") + s;
  }
  return x.toFixed(d);
}

/** Python round(x, n) — 반올림(짝수 반올림), 결과는 number */
export function round(x: number, n = 0): number {
  return Number(fixed(x, n));
}

/** Python str(float) — 정수값도 '2.0' 처럼 소수점을 붙인다 (계산식의 '안전2.0' 같은 표기) */
export function floatstr(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}
