"""민원 1건 처리 원가 — agent_log 의 모델 호출 토큰 기록을 합산한다.

실제 모델(LLM_BACKEND=anthropic)로 돌린 기록만 센다. local 대역은 API 를
부르지 않으므로 기록이 없고, 그 경우 원가측정.md 를 만들지 않는다
(숫자 없는 문서를 만들면 할일.md 가 완료로 오판한다).

--backend claude_code 는 참고 모드다. Claude Code CLI 경유 기록(cli_call)을 세고,
비용은 CLI 가 보고한 금액(total_cost_usd)을 쓴다. 결과는 원가측정_참고.md 로만
쓴다 — 제출용 원가측정.md 는 API 실측으로만 만든다 (할일 D6-5).

사용법
    python cli.py cycle                  # 실제 모델로 한 바퀴 이상 돌린 뒤
    python scripts/measure_cost.py       # → ../제출_준비/원가측정.md
    python scripts/measure_cost.py --since 2026-10-03T00:00
    python scripts/measure_cost.py --backend claude_code   # → 원가측정_참고.md
"""
import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import config, db  # noqa: E402

OUT = {
    "anthropic": ROOT.parent / "제출_준비" / "원가측정.md",
    "claude_code": ROOT.parent / "제출_준비" / "원가측정_참고.md",
}
ACTION = {"anthropic": "api_call", "claude_code": "cli_call"}
CLI_USD = re.compile(r"\$([0-9.]+)")        # cli_call 요약 예: "success · $0.0622"

# 모델이 직접 분류한 건만 센다 — 캐시·local 대역·스텁 분류에는 모델 비용이 없다
MODEL_CLASSIFIED = """status='done' AND processed_at >= ?
    AND COALESCE(agent_note,'') <> 'cache'
    AND COALESCE(agent_note,'') NOT LIKE '%(local 대역)%'
    AND COALESCE(agent_note,'') NOT LIKE 'STUB%'"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["anthropic", "claude_code"], default="anthropic",
                    help="claude_code = CLI 경유 참고값 (원가측정_참고.md)")
    ap.add_argument("--since", default="", help="이 시각 이후 기록만 (ISO)")
    ap.add_argument("--note", default="", help="측정 조건 한 줄 (문서 머리에 그대로 적는다 — 합성 시드 여부 등)")
    ap.add_argument("--previous", default="", help="이전 측정 문서 경로 — 끝에 '이전 측정'으로 붙인다")
    ap.add_argument("--usd-krw", type=float, default=0.0,
                    help="환율 (지정하면 원화도 표기, 근거 날짜를 문서에 직접 적을 것)")
    args = ap.parse_args()
    cli = args.backend == "claude_code"
    action, out_path = ACTION[args.backend], OUT[args.backend]

    db.init_db()
    with db.connect() as conn:
        per_agent = conn.execute(
            """SELECT agent, COUNT(*) calls, SUM(input_tokens) i, SUM(output_tokens) o,
                      SUM(cache_read_tokens) c, AVG(latency_ms) lat,
                      MIN(created_at) first, MAX(created_at) last
               FROM agent_log WHERE action=? AND created_at >= ?
               GROUP BY agent ORDER BY agent""", (action, args.since)).fetchall()
        reported: dict[str, float] = {}
        if cli:
            for r in conn.execute(
                "SELECT agent, output_summary s FROM agent_log WHERE action=? AND created_at >= ?",
                (action, args.since),
            ).fetchall():
                m = CLI_USD.search(r["s"] or "")
                reported[r["agent"]] = reported.get(r["agent"], 0.0) + (float(m.group(1)) if m else 0.0)
        n_done = conn.execute(
            f"SELECT COUNT(*) n FROM classification WHERE {MODEL_CLASSIFIED}",
            (args.since,)).fetchone()["n"]
        n_cache = conn.execute(
            """SELECT COUNT(*) n FROM classification
               WHERE status='done' AND processed_at >= ? AND agent_note='cache'""",
            (args.since,)).fetchone()["n"]

    if not per_agent:
        print(f"{action} 기록이 없습니다. LLM_BACKEND={args.backend} 로 `python cli.py cycle` 을 "
              "먼저 돌리세요. (local 대역은 모델을 부르지 않습니다)")
        return 1

    pin, pout, pcache = config.PRICE_PER_MTOK[config.MODEL]

    def usd(r) -> float:
        if cli:                       # CLI 가 보고한 금액 (캐시 생성 할증 포함)
            return reported.get(r["agent"], 0.0)
        return ((r["i"] or 0) * pin + (r["o"] or 0) * pout + (r["c"] or 0) * pcache) / 1e6

    total = sum(usd(r) for r in per_agent)
    calls = sum(r["calls"] for r in per_agent)
    cls = next((usd(r) for r in per_agent if r["agent"] == "classifier"), 0.0)
    krw = (lambda x: f" (약 {x * args.usd_krw:,.1f}원)") if args.usd_krw else (lambda x: "")
    first = min(r["first"] for r in per_agent)
    last = max(r["last"] for r in per_agent)

    if cli:
        lines = [
            "# 민원 1건 처리 원가 — 참고값 (Claude Code CLI 경유)",
            "",
            "> **참고값입니다. 제출용 원가가 아닙니다.** API 키 없이 `LLM_BACKEND=claude_code` 로",
            "> 돌린 기록입니다. CLI 는 호출마다 자체 프롬프트와 캐시 생성이 붙어 API 직접 호출과",
            "> 토큰·금액이 다릅니다. 제출용 `원가측정.md` 는 `--backend anthropic` 실측으로 만듭니다.",
            "",
            f"측정 {datetime.now():%Y-%m-%d %H:%M} · 모델 `{config.MODEL}` · "
            "비용 = CLI 가 보고한 금액(total_cost_usd)의 합",
        ]
    else:
        lines = [
            "# 민원 1건 처리 원가 실측",
            "",
            f"측정 {datetime.now():%Y-%m-%d %H:%M} · 모델 `{config.MODEL}` · "
            f"단가 입력 ${pin}/출력 ${pout}/캐시읽기 ${pcache} (100만 토큰당)",
        ]
    if args.note:
        lines += [f"측정 조건: {args.note}"]
    lines += [
        f"집계 범위: agent_log `{action}` 기록"
        + (f", {args.since} 이후" if args.since else " 전체") + f" ({first} ~ {last})",
        "",
        "| 에이전트 | 호출 | 입력 토큰 | 출력 토큰 | 캐시 읽기 | 평균 지연 | 비용(USD) | 호출 1회당 |"
        + (" 민원 1건당 |" if n_done else ""),
        "|---|---|---|---|---|---|---|---|" + ("---|" if n_done else ""),
        *[f"| {r['agent']} | {r['calls']} | {r['i'] or 0:,} | {r['o'] or 0:,} | {r['c'] or 0:,} "
          f"| {(r['lat'] or 0) / 1000:.1f}s | ${usd(r):.4f} | ${usd(r) / r['calls']:.4f} |"
          + (f" ${usd(r) / n_done:.5f} |" if n_done else "")
          for r in per_agent],
        f"| **합계** | {calls} | | | | | **${total:.4f}**{krw(total)} | |"
        + (f" **${total / n_done:.5f}** |" if n_done else ""),
        "",
        f"- 모델이 직접 분류한 민원 {n_done}건 · 캐시로 처리 {n_cache}건 "
        "(local 대역·스텁 분류는 세지 않음)",
    ]
    if n_done:
        lines += [
            f"- **분류 원가: 민원 1건당 ${cls / n_done:.5f}**{krw(cls / n_done)} (①분류 에이전트만)",
            f"- **전체 원가: 민원 1건당 ${total / n_done:.5f}**{krw(total / n_done)} "
            "(②③④ 배후 에이전트 비용을 분류 건수로 나눈 값)",
        ]
    if n_cache:
        both = n_done + n_cache
        lines.append(f"- 캐시 포함 시 1건당 ${total / both:.5f}{krw(total / both)} ({both}건 기준 · "
                     "캐시를 누가 채웠는지는 구분하지 않음 — local 대역 분류가 채운 캐시도 포함될 수 있음)")
    lines += [
        "",
        "주의: ②③④는 민원 건수가 아니라 주기마다 돈다. 민원이 적은 시간대에는 1건당",
        "원가가 올라가고 붐빌 때는 내려간다. 비즈니스 모델에는 측정 조건(건수·주기)을 함께 적을 것.",
        "",
    ]
    if args.previous and Path(args.previous).exists():
        prev = Path(args.previous).read_text(encoding="utf-8").strip().splitlines()
        body = [l for l in prev if not l.startswith("> ")][1:]        # 제목·참고 안내 박스는 중복이라 뺀다
        lines += ["---", "", "## 이전 측정 (이 측정 전 기록 · 조건이 달라 직접 비교하지 말 것)", "", *body, ""]
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"→ {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
