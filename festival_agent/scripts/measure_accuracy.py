"""분류 정확도 측정 — ①분류 에이전트의 출력을 정답 라벨과 대조한다.

신청서의 '분류 정확도 85% 이상' 목표를 숫자로 확인하는 스크립트다.
운영 DB(festival.db)는 건드리지 않는다. 임시 SQLite 에 시드를 넣고
실제 분류 에이전트(classifier.run_once)를 그대로 돌린 뒤 결과를 비교한다.

두 가지 모드
  시드 모드   --seed (기본 seed/dev_sample.csv). 정답은 `_label_hint` 열. 같은 문장은 1번만 센다
              (중복은 캐시로 처리돼 정확도를 부풀리기 때문이다). 합성 시드라 **참고값**이다.
  평가셋 모드 --labels <csv>. 사람이 직접 모은 실제 리뷰 + 2인 독립 라벨.
              열: text · label_a · label_b · label_final (+ zone · posted_at · source_url · …)
              scripts/templates/eval_labels_template.csv, 라벨 방법은 제출_준비/라벨링_가이드.md.
              라벨은 사람이 붙인다. 합성·생성 문장으로 채우면 안 된다 (source_url 이 없는 행은 제외하고,
              dev_sample.csv 는 거부한다).

출력: 정확도와 안전 재현율을 Wilson 95% 신뢰구간과 함께 보여 준다. --repeat N 번(평가셋 모드 기본 3) 돌려
반복 사이의 편차와 예측 안정도를 보이고, 평가셋 모드는 라벨러 간 일치율·Cohen's κ 도 보인다.
건수가 적으면 구간이 넓다 — 32건 합성에서 정확도 100% 는 [89%, 100%], 안전 4/4 는 [51%, 100%] 일 뿐이다.

사용법
    python scripts/measure_accuracy.py                        local 대역
    python scripts/measure_accuracy.py --backend anthropic    실제 모델 (API 비용 발생)
    python scripts/measure_accuracy.py --backend anthropic --limit 40
    python scripts/measure_accuracy.py --backend claude_code --limit 10   CLI 경유 참고값
    python scripts/measure_accuracy.py --seed seed/real.csv   다른 시드
    python scripts/measure_accuracy.py --backend anthropic --labels ../평가셋.csv --repeat 3   실제 평가셋

결과는 tests/accuracy_report.md 의 백엔드별 절에 기록된다(다른 절은 보존).
"""
import argparse
import csv
import math
import os
import random
import re
import statistics
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "tests" / "accuracy_report.md"
LABELS = ("parking", "restroom", "price", "guide", "crowd", "safety", "positive")   # core/config.py LABELS 와 같게


# ── 통계 ──────────────────────────────────────────────────────────

def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """이항 비율 k/n 의 Wilson 95% 신뢰구간. 건수가 적어도 [0,1] 안에서 믿을 만하다."""
    if n <= 0:
        return 0.0, 0.0
    p = k / n
    d = 1 + z * z / n
    center = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, center - half), min(1.0, center + half)


def cohen_kappa(a: list[str], b: list[str]) -> float | None:
    """두 라벨러 a, b 의 Cohen's κ. 우연 일치를 뺀 일치도. 계산할 수 없으면 None (표본 없음·한쪽이 한 가지 라벨뿐)."""
    n = len(a)
    if n == 0 or n != len(b):
        return None
    po = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    if pe >= 1.0:
        return None
    return (po - pe) / (1 - pe)


def kappa_word(k: float | None) -> str:
    """Landis & Koch 의 해석 구간."""
    if k is None:
        return "계산 불가"
    if k <= 0.2:
        return "거의 없음"
    if k <= 0.4:
        return "약함"
    if k <= 0.6:
        return "보통"
    if k <= 0.8:
        return "상당함"
    return "거의 완전"


def pct(x: float) -> str:
    return f"{x:.1%}"


def ci_text(k: int, n: int) -> str:
    lo, hi = wilson(k, n)
    return f"[{lo:.0%}, {hi:.0%}]"


# ── 데이터 ────────────────────────────────────────────────────────

def load_gold(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.DictReader(f)
                if (r.get("text") or "").strip() and (r.get("_label_hint") or "").strip()]
    seen, out = set(), []
    for r in rows:
        t = r["text"].strip()
        if t in seen:
            continue
        seen.add(t)
        out.append(r)
    return out


def load_labels(path: Path) -> tuple[list[dict], dict]:
    """평가셋 CSV → (정답 행 목록, 집계·제외 사유). 사람이 붙인 라벨만 쓴다.

    포함 조건: text 가 있고, source_url 이 있고(실제 리뷰 증빙), label_final 이 7개 유형 중 하나.
    label_a·label_b 가 둘 다 유효한 행만 κ 에 쓴다. 같은 문장은 1번만 센다.
    """
    if path.name == "dev_sample.csv":
        raise ValueError("dev_sample.csv 는 합성 데이터입니다. 평가셋에는 실제 리뷰만 넣으세요.")
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        need = {"text", "label_a", "label_b", "label_final"} - set(reader.fieldnames or [])
        if need:
            raise ValueError(f"필수 열이 없습니다: {', '.join(sorted(need))} "
                             "(scripts/templates/eval_labels_template.csv 참고)")
        raw = list(reader)
    stat = {"input": len(raw), "no_text": 0, "no_source": 0, "no_final": 0, "dup": 0,
            "a": [], "b": [], "disagree": 0}
    out, seen = [], set()
    for r in raw:
        text = (r.get("text") or "").strip()
        if not text:
            stat["no_text"] += 1
            continue
        if not (r.get("source_url") or "").strip():
            stat["no_source"] += 1                       # 출처 없는 행은 실제 수집분이라는 증빙이 없다
            continue
        fin = (r.get("label_final") or "").strip()
        if fin not in LABELS:
            stat["no_final"] += 1                        # 합의가 안 됐거나 모르는 유형
            continue
        if text in seen:
            stat["dup"] += 1
            continue
        seen.add(text)
        a, b = (r.get("label_a") or "").strip(), (r.get("label_b") or "").strip()
        if a in LABELS and b in LABELS:
            stat["a"].append(a)
            stat["b"].append(b)
            stat["disagree"] += a != b
        out.append({**r, "text": text, "_label_hint": fin})
    return out, stat


def drop_operator(expected: dict, got: dict) -> list:
    """운영자가 유형을 지정했거나 닫은 건(decided_by='operator')은 모델이 맞힌 것이 아니라서 정답 집합에서 뺀다.
    빼낸 민원 id 목록을 돌려준다 (expected 를 직접 고친다)."""
    operator = [f for f in expected if got.get(f, {}).get("decided_by") == "operator"]
    for f in operator:
        expected.pop(f)
    return operator


# ── 한 번 돌리기 ──────────────────────────────────────────────────

def run_once(args, gold: list[dict], run_no: int) -> dict:
    """새 임시 DB 에 gold 를 넣고 분류 에이전트를 돌려 결과를 모은다. 반복마다 DB 가 새것이라 캐시가 섞이지 않는다."""
    from core import config, db
    from agents import classifier

    config.DB_PATH = str(Path(tempfile.mkdtemp()) / f"accuracy_{run_no}.db")
    db.init_db()
    zone_by_name = {z["name"]: z["id"] for z in db.zones()}
    expected: dict[int, str] = {}
    texts: dict[int, str] = {}
    for r in gold:
        fid = db.insert_feedback(zone_by_name.get((r.get("zone") or "").strip()),      # 모르면 NULL(구역 미상)
                                 r["text"], source="eval", posted_at=r.get("posted_at") or None)
        if fid is not None:
            expected[fid] = r["_label_hint"].strip()
            texts[fid] = r["text"].strip()

    print(f"[{args.backend}] {run_no}회차 · {len(expected)}건 분류 시작 (임시 DB {config.DB_PATH})", flush=True)
    started = datetime.now()
    for _ in range(len(expected) // max(args.batch, 1) + 5):
        if db.pending_count() == 0:
            break
        classifier.run_once(limit=args.batch)
    elapsed = (datetime.now() - started).total_seconds()

    with db.connect() as conn:
        got = {r["feedback_id"]: dict(r) for r in conn.execute(
            "SELECT feedback_id, label, is_safety, confidence, status, decided_by FROM classification")}
        tok = conn.execute(
            """SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) i,
                      COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_read_tokens),0) c
               FROM agent_log WHERE action IN ('api_call','cli_call')""").fetchone()
    operator = drop_operator(expected, got)        # 운영자가 처리한 건은 정확도에서 뺀다 (모델 정답이 아님)
    safety_ids = [f for f, y in expected.items() if y == "safety"]
    return {
        "expected": expected, "texts": texts, "got": got, "operator": operator, "elapsed": elapsed,
        "tok": dict(tok), "n": len(expected),
        "unfinished": sum(1 for f in expected if got.get(f, {}).get("status") not in ("done", "review")),
        "held": sum(1 for f in expected if got.get(f, {}).get("status") == "review"),   # 신뢰도 낮아 유형 미정
        "correct": sum(1 for f, y in expected.items() if got.get(f, {}).get("label") == y),
        "safety_n": len(safety_ids),
        # 안전: 놓치면 안 되는 쪽이라 재현율을 따로 본다 (라벨=safety 또는 is_safety 플래그)
        "safety_hit": sum(1 for f in safety_ids
                          if got.get(f, {}).get("label") == "safety" or got.get(f, {}).get("is_safety")),
        "pred": {texts[f]: (got.get(f, {}).get("label") or "-") for f in expected},
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["local", "anthropic", "claude_code"], default="local")
    ap.add_argument("--seed", default=str(ROOT / "seed" / "dev_sample.csv"))
    ap.add_argument("--labels", default="", help="실제 평가셋 CSV (text·label_a·label_b·label_final). 사람이 라벨을 붙인 것만")
    ap.add_argument("--repeat", type=int, default=0,
                    help="같은 평가를 N번 돌려 반복 편차를 본다 (평가셋 모드 기본 3, 시드 모드 기본 1)")
    ap.add_argument("--limit", type=int, default=0, help="표본 수 (0=전부)")
    ap.add_argument("--batch", type=int, default=20, help="에이전트 1회 처리 건수")
    ap.add_argument("--no-report", action="store_true")
    args = ap.parse_args()
    repeat = args.repeat or (3 if args.labels else 1)

    # core 를 import 하기 전에 환경을 고정한다 (config 가 import 시점에 읽는다)
    os.environ["DB_PATH"] = str(Path(tempfile.mkdtemp()) / "accuracy.db")
    os.environ["SUPABASE_DB_URL"] = ""
    os.environ["LLM_BACKEND"] = args.backend
    sys.path.insert(0, str(ROOT))

    from core import config, llm

    if args.backend == "claude_code" and not llm.cli_path():
        print("claude CLI 를 찾을 수 없습니다 (PATH 확인).")
        return 1
    if args.backend == "anthropic" and not os.getenv("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY 가 없습니다. .env 를 확인하세요.")
        return 1

    lab = None
    if args.labels:
        try:
            gold, lab = load_labels(Path(args.labels))
        except (ValueError, OSError) as e:
            print(f"평가셋을 읽을 수 없습니다: {e}")
            return 1
        source = f"평가셋 `{Path(args.labels).name}`"
        print(f"평가셋 {lab['input']}행 → 사용 {len(gold)}행  "
              f"(제외: 출처 URL 없음 {lab['no_source']} · 합의 라벨 없음 {lab['no_final']} · 문장 없음 {lab['no_text']} · 중복 {lab['dup']})")
        if lab["no_source"]:
            print("  ※ 출처 URL 이 없는 행은 실제 수집분이라는 증빙이 없어 뺐습니다.")
    else:
        gold = load_gold(Path(args.seed))
        source = f"시드 `{Path(args.seed).name}`"
    if not gold:
        print("정답 라벨이 있는 행이 없습니다." if not args.labels else "쓸 수 있는 평가 행이 없습니다.")
        return 1
    if args.limit and args.limit < len(gold):
        random.Random(42).shuffle(gold)            # 라벨 분포를 유지하도록 고정 시드로 표본 추출
        gold = gold[:args.limit]

    runs = [run_once(args, gold, i + 1) for i in range(repeat)]
    r0 = runs[0]
    n = r0["n"]
    operator_total = sum(len(r["operator"]) for r in runs)

    # 반복 평균과 편차
    accs = [r["correct"] / r["n"] if r["n"] else 0.0 for r in runs]
    mean_k = round(sum(r["correct"] for r in runs) / repeat)
    safety_n = r0["safety_n"]
    mean_safe_k = round(sum(r["safety_hit"] for r in runs) / repeat)
    safe_rates = [r["safety_hit"] / r["safety_n"] for r in runs if r["safety_n"]]
    stable = None
    if repeat > 1:
        same = sum(1 for t in r0["pred"] if len({r["pred"].get(t) for r in runs}) == 1)
        stable = same / len(r0["pred"]) if r0["pred"] else None

    labels = list(config.LABELS)
    confusion = Counter((y, r0["got"].get(f, {}).get("label") or "-") for f, y in r0["expected"].items())
    rows = []
    for lb in labels:
        tp = confusion[(lb, lb)]
        support = sum(v for (y, _), v in confusion.items() if y == lb)
        predicted = sum(v for (_, p), v in confusion.items() if p == lb)
        if support == 0 and predicted == 0:
            continue
        rows.append((lb, support, tp / predicted if predicted else 0.0, tp / support if support else 0.0))
    wrong = [(r0["texts"][f], y, r0["got"].get(f, {}).get("label") or "-")
             for f, y in r0["expected"].items() if r0["got"].get(f, {}).get("label") != y]

    cost_line = ""
    if any(r["tok"]["calls"] for r in runs):
        pin, pout, pcache = config.PRICE_PER_MTOK.get(config.MODEL, (0, 0, 0))
        calls = sum(r["tok"]["calls"] for r in runs)
        tin, tout, tcache = (sum(r["tok"][k] for r in runs) for k in ("i", "o", "c"))
        usd = (tin * pin + tout * pout + tcache * pcache) / 1_000_000
        cost_line = (f"모델 호출 {calls}회({repeat}회 반복 합) · 입력 {tin:,} · 출력 {tout:,} · "
                     f"캐시읽기 {tcache:,} 토큰 · 약 ${usd:.4f} "
                     f"(평가 1건당 ${usd / (n * repeat):.5f}, {config.MODEL} 단가 기준)")

    kappa = agree = None
    if lab and lab["a"]:
        kappa = cohen_kappa(lab["a"], lab["b"])
        agree = 1 - lab["disagree"] / len(lab["a"])

    # ── 출력 ──
    tag = "평균" if repeat > 1 else ""
    print(f"\n정확도{tag} {mean_k}/{n} = {mean_k / n:.1%}   Wilson 95% CI {ci_text(mean_k, n)}   "
          f"(미처리 {r0['unfinished']}건, 확인 필요 {r0['held']}건, 1회 {r0['elapsed']:.0f}초)")
    if repeat > 1:
        sd = statistics.stdev(accs) if repeat > 1 else 0.0
        print(f"  반복별 {', '.join(pct(a) for a in accs)} · 편차 sd {sd * 100:.1f}%p · 범위 {pct(min(accs))}~{pct(max(accs))}")
        if stable is not None:
            print(f"  예측 안정도(반복해도 같은 답) {pct(stable)}")
    if r0["held"]:
        print(f"  ※ 확인 필요 {r0['held']}건은 유형을 정하지 않아 오답으로 셉니다")
    if operator_total:
        print("  ※ 운영자가 처리한 건은 정확도에서 뺐습니다 (모델 정답이 아님)")
    print(f"안전 재현율{tag} {mean_safe_k}/{safety_n}"
          + (f" = {mean_safe_k / safety_n:.1%}   Wilson 95% CI {ci_text(mean_safe_k, safety_n)}" if safety_n else ""))
    if repeat > 1 and safe_rates:
        print(f"  반복별 {', '.join(pct(a) for a in safe_rates)}")
    if lab:
        if kappa is None and not lab["a"]:
            print("라벨러 간 일치: 2인 라벨(label_a·label_b)이 유효한 행이 없어 계산하지 못했습니다.")
        else:
            print(f"라벨러 간 일치 {pct(agree)} ({len(lab['a'])}행 중 불일치 {lab['disagree']}건) · "
                  f"Cohen's κ = {'-' if kappa is None else f'{kappa:.2f}'} ({kappa_word(kappa)})")
            if kappa is not None and kappa < 0.6:
                print("  ※ κ 가 0.6 미만이면 유형 정의부터 다시 맞춘 뒤 라벨링해야 합니다 (제출_준비/라벨링_가이드.md)")
    for lb, s, p, r in rows:
        print(f"  {lb:9s} n={s:3d}  정밀도 {p:5.1%}  재현율 {r:5.1%}")
    if cost_line:
        print(cost_line)
    for t, y, p in wrong[:15]:
        print(f"  ✗ [{y}→{p}] {t}")
    if not args.labels:
        print("  ※ 합성 시드 기준 참고값입니다. 실제 평가셋(--labels)으로 다시 재야 합니다.")

    if args.no_report:
        return 0

    head = "| 정답＼예측 | " + " | ".join(labels + ["-"]) + " |"
    sep = "|" + "---|" * (len(labels) + 2)
    mat = [f"| **{y}** | " + " | ".join(str(confusion[(y, p)] or "") for p in labels + ["-"]) + " |"
           for y in labels if any(confusion[(y, p)] for p in labels + ["-"])]
    lo, hi = wilson(mean_k, n)
    slo, shi = wilson(mean_safe_k, safety_n)
    model_name = "규칙 기반 대역" if args.backend == "local" else config.MODEL
    key = args.backend if not args.labels else f"{args.backend} · 평가셋"
    section = "\n".join([
        f"## {key}",
        "",
        f"측정 {datetime.now():%Y-%m-%d %H:%M} · {source} · 고유 문장 {n}건 · 반복 {repeat}회 · 모델 `{model_name}`"
        + (" (Claude Code CLI 경유 — 참고값, 최종값은 anthropic)" if args.backend == 'claude_code' else ""),
        *([] if args.labels else ["", "> 합성 시드 기준 **참고값**입니다. 실제 평가셋으로 다시 재야 합니다."]),
        "",
        f"- **정확도{tag} {mean_k / n:.1%}** ({mean_k}/{n}) · Wilson 95% CI [{lo:.1%}, {hi:.1%}] · 미처리 {r0['unfinished']}건 · 1회 {r0['elapsed']:.0f}초",
        *([f"- 반복별 {', '.join(pct(a) for a in accs)} · 편차 sd {statistics.stdev(accs) * 100:.1f}%p · "
           f"범위 {pct(min(accs))}~{pct(max(accs))}"] if repeat > 1 else []),
        *([f"- 예측 안정도(반복해도 같은 답) {pct(stable)}"] if stable is not None else []),
        f"- 안전 재현율{tag} {mean_safe_k}/{safety_n}"
        + (f" = {mean_safe_k / safety_n:.1%} · Wilson 95% CI [{slo:.1%}, {shi:.1%}]" if safety_n else "")
        + " (라벨 safety 이거나 is_safety=true)",
        *([f"- 라벨러 간 일치 {pct(agree)} · Cohen's κ = {'-' if kappa is None else f'{kappa:.2f}'} ({kappa_word(kappa)})"]
          if lab and lab["a"] else []),
        *([f"- {cost_line}"] if cost_line else []),
        "",
        "| 라벨 | 건수 | 정밀도 | 재현율 |",
        "|---|---|---|---|",
        *[f"| {lb} | {s} | {p:.1%} | {r:.1%} |" for lb, s, p, r in rows],
        "",
        "혼동 행렬 (첫 반복)",
        "",
        head, sep, *mat,
        "",
        f"오분류 {len(wrong)}건" + (" (상위 20)" if len(wrong) > 20 else ""),
        "",
        *[f"- `{y}`→`{p}` {t}" for t, y, p in wrong[:20]],
        "",
    ])

    header = ("# 분류 정확도 리포트\n\n"
              "`python scripts/measure_accuracy.py --backend <local|anthropic|claude_code> [--labels 평가셋.csv --repeat 3]` 로 생성.\n"
              "정답은 시드의 `_label_hint`(합성·참고값) 또는 평가셋의 `label_final`(사람이 합의한 라벨). 같은 문장은 1번만 센다.\n"
              "정확도·안전 재현율에는 Wilson 95% 신뢰구간을 함께 적는다 — 건수가 적으면 구간이 넓다.\n\n")
    old = REPORT.read_text(encoding="utf-8") if REPORT.exists() else header
    parts = re.split(r"(?m)^(?=## )", old)
    body = {p.split("\n", 1)[0][3:].strip(): p for p in parts[1:]}
    body[key] = section + "\n"
    known = [b for b in ("local", "claude_code", "anthropic") if b in body]
    order = known + [k for k in body if k not in known]
    REPORT.write_text(parts[0] + "".join(body[b] for b in order), encoding="utf-8")
    print(f"\n→ {REPORT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
