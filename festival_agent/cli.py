"""터미널 인터페이스 — 브라우저 없이 전체 흐름을 다룬다.

개발·검증·시연 리허설용. Streamlit 화면과 같은 DB를 보므로 둘을 동시에 켜도 된다.

    python cli.py status                     현재 상태 (관제 화면의 터미널판)
    python cli.py submit "진입로가 어두워요"   민원 접수
    python cli.py cycle                      ①②③④ 한 바퀴
    python cli.py replay start --speed 300   리플레이
    python cli.py db log                     DB 조회
    python cli.py demo --stub                E2E 자동 실행 (LLM 없이)
    python cli.py reset --all                초기화
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import config, db, replay

# ── 출력 유틸 ─────────────────────────────────────────────────────
_COLOR = os.environ.get("NO_COLOR") is None and sys.stdout.isatty()


def c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def bold(t): return c(t, "1")
def dim(t): return c(t, "2")
def red(t): return c(t, "31")
def yellow(t): return c(t, "33")
def green(t): return c(t, "32")
def cyan(t): return c(t, "36")


GRADE_COLOR = {"immediate": red, "high": yellow, "mid": lambda s: s, "low": dim}
GRADE_MARK = {"immediate": "!!", "high": "! ", "mid": "  ", "low": "  "}


def rule(title: str = "") -> None:
    line = "─" * 64
    print(f"\n{dim(line)}" if not title else f"\n{bold(title)}  {dim('─' * max(0, 62 - len(title)))}")


def _backend_line() -> str:
    """지금 어떤 백엔드로 도는지. 시연 중 모르면 안 되는 정보다."""
    from core import llm
    if llm.is_local():
        return yellow("  백엔드 local — 규칙 기반 대역입니다. 제출본이 아닙니다.")
    if llm.is_cli():
        return yellow(f"  백엔드 claude_code ({config.MODEL}, Claude Code CLI 경유) — "
                      "실제 모델이지만 개발용 경로입니다. 제출은 anthropic.")
    return green(f"  백엔드 anthropic ({config.MODEL})")


def ranked_now(window: int | None = None):
    win = window or config.DEFAULT_WINDOW_MIN
    return db.ranked(win), len(db.window_rows(win))


# ── status ────────────────────────────────────────────────────────
def cmd_status(args) -> None:
    with db.connect() as conn:
        fest = conn.execute("SELECT * FROM festival LIMIT 1").fetchone()
        brief = conn.execute("SELECT * FROM briefing ORDER BY id DESC LIMIT 1").fetchone()
        alerts = conn.execute(
            "SELECT * FROM alert WHERE acked=0 ORDER BY id DESC LIMIT 5").fetchall()

    win = args.window or config.DEFAULT_WINDOW_MIN
    total_counts = db.label_counts()          # 누적 (전 기간)
    counts = db.label_counts(win)             # 창 기준 — 심각도와 같은 모집단
    ranked, win_total = ranked_now(win)
    pending = db.pending_count()

    print(f"\n{bold(fest['name'] if fest else '축제')}   "
          f"{dim(f'누적 {sum(total_counts.values()) + pending}건 · '
                f'분류완료 {sum(total_counts.values())} · 대기 {pending}'
                + (f' · 확인필요 {db.review_count()}' if db.review_count() else ''))}")
    print(dim(f"  데이터 기준 {db.data_now().strftime('%m-%d %H:%M')} · "
              f"창 {win}분 ({win_total}건)"))
    print(_backend_line())
    if win_total < sum(total_counts.values()) * 0.3:
        print(dim(f"  창 밖 데이터가 많습니다.  --window {win * 24}  처럼 넓혀 보세요"))

    prog = replay.progress()
    if prog and prog["active"]:
        print(dim(f"  리플레이 {prog['speed']:.0f}배속 · {prog['cursor']}/{prog['total']} · "
                  f"시뮬 {prog['sim_now']}"))

    # 브리핑
    rule("통합 에이전트 브리핑")
    if brief:
        print(f"  {cyan(brief['text'])}")
        if brief["rationale"]:
            print(dim(f"  근거: {brief['rationale']}"))
        print(dim(f"  {brief['created_at']}"))
    else:
        print(dim("  아직 없음.  python cli.py brief  로 생성"))

    # 알림
    if alerts:
        rule("알림")
        kind = {"spike": "급증", "safety_threshold": "안전 임계", "grade_up": "등급 상승"}
        for a in alerts:
            print(f"  {red('▲')} {bold(kind.get(a['kind'], a['kind']))} "
                  f"{config.LABELS.get(a['label'], a['label'])}  {dim(a['created_at'][11:19])}")
            print(f"    {a['detail']}")

    # 두 순위
    rule(f"건수 순위  vs  심각도 순위  (최근 {win}분)")
    print(f"  {'':<4}{'건수':<22}{'':<4}{'심각도':<28}")
    cl = list(counts.items())
    for i in range(max(len(cl), len(ranked))):
        left = ""
        if i < len(cl):
            left = f"{i+1}. {config.LABELS.get(cl[i][0], cl[i][0]):<9}{cl[i][1]:>4}건"
        right = ""
        if i < len(ranked):
            r = ranked[i]
            col = GRADE_COLOR.get(r["grade"], lambda s: s)
            right = col(f"{GRADE_MARK[r['grade']]}{i+1}. "
                        f"{config.LABELS.get(r['label'], r['label']):<9}"
                        f"{r['score']:>6}  {r['grade']}")
        print(f"  {left:<28}  {right}")

    if ranked:
        rule("판정 근거 (상위 3)")
        for r in ranked[:3]:
            print(f"  {bold(config.LABELS.get(r['label'], r['label']))}  "
                  f"{r['score']}점 · {r['freq']}건")
            print(dim(f"    {r['formula']}"))
            if r["spike"]["spiked"]:
                print(yellow(f"    급증: 최근 {config.SPIKE_WINDOW_MIN}분 {r['spike']['rate']}/분 "
                             f"(기준 {r['spike']['baseline']}/분, {r['spike']['multiplier']}배)"))

    # 조치
    actions = db.open_actions()
    if actions:
        rule("조치요청서")
        st = {"requested": "요청", "in_progress": "조치중", "done": "완료"}
        for a in actions[:6]:
            print(f"  [{st.get(a['status'], a['status']):<3}] {a['department']:<10} "
                  f"{config.LABELS.get(a['label'], a['label']):<9} {a['count']:>3}건  "
                  f"{dim(a['created_at'][5:16])}")
    print()


# ── check ─────────────────────────────────────────────────────────
def cmd_check(args) -> None:
    """키가 유효한지 최소 비용으로 확인한다. 전체 cycle 전에 먼저 돌린다."""
    import os

    from core import llm

    print(bold("\n백엔드"))
    print(_backend_line())
    print(dim("  LLM_BACKEND 로 전환합니다 (anthropic | claude_code | local). "
              "미지정이면 키 유무로 자동 판단합니다."))

    if llm.is_cli():
        exe = llm.cli_path()
        print(bold("\nClaude Code CLI"))
        print(f"  claude  {green(exe) if exe else red('찾을 수 없음 (PATH 확인)')}")
        print(dim("  구독 사용량을 씁니다. worker 상시 구동보다 cycle 1회·소량 측정으로 확인하세요."))
        print(bold("\n실행 규모"))
        print(f"  분류 대기 {db.pending_count()}건")
        return

    print(bold("\n자격증명"))
    key = os.getenv("ANTHROPIC_API_KEY")
    env = Path(__file__).resolve().parent / ".env"
    print(f"  ANTHROPIC_API_KEY  {green('설정됨') if key else red('미설정')}"
          f"{dim(f'  (…{key[-6:]})') if key else ''}")
    print(f"  .env 파일          {green('있음') if env.exists() else dim('없음')}")

    from core import tourapi
    print(f"  TOURAPI_KEY        "
          f"{green('설정됨') if tourapi.available() else dim('미설정 (선택)')}")

    if llm.is_local():
        print(dim("\n  local 백엔드라 API 를 호출하지 않습니다."))
        print(dim("  실제 모델로 검증하려면 .env 에 ANTHROPIC_API_KEY 를 넣거나"))
        print(dim("  LLM_BACKEND=anthropic 을 설정하십시오."))
        print(bold("\n실행 규모"))
        print(f"  분류 대기 {db.pending_count()}건")
        return

    if not key and not env.exists():
        print(red("\n  키가 없습니다.") + " .env 파일을 만들고 아래 한 줄을 넣으십시오.")
        print(dim("    ANTHROPIC_API_KEY=sk-ant-..."))
        return

    print(bold("\nAPI 호출 (최소 토큰)"))
    try:
        import anthropic

        from core import config, llm
        r = llm.client().messages.create(
            model=config.MODEL,
            max_tokens=16,
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": "OK 라고만 답해."}],
        )
        txt = "".join(b.text for b in r.content if b.type == "text").strip()
        u = r.usage
        print(f"  {green('성공')}  모델 {config.MODEL}")
        print(f"  응답: {txt[:40]}")
        print(dim(f"  토큰: 입력 {u.input_tokens} / 출력 {u.output_tokens}"))
    except anthropic.AuthenticationError:
        print(red("  인증 실패") + " — 키가 잘못됐거나 만료됐습니다.")
        return
    except anthropic.NotFoundError:
        print(red(f"  모델을 찾을 수 없음") + f" — core/config.py 의 MODEL 확인")
        return
    except anthropic.RateLimitError:
        print(yellow("  요청 한도 초과") + " — 잠시 후 다시 시도하십시오.")
        return
    except anthropic.APIStatusError as exc:
        print(red(f"  API 오류 {exc.status_code}") + f" — {str(exc)[:120]}")
        return
    except anthropic.APIConnectionError:
        print(red("  연결 실패") + " — 네트워크를 확인하십시오.")
        return

    print(bold("\n실행 규모"))
    pending = db.pending_count()
    print(f"  분류 대기 {pending}건")
    if pending > 30:
        print(yellow(f"  대기가 많습니다. 먼저  python cli.py classify --batch 10  으로 "
                     f"소량만 돌려 보십시오."))
    print(dim("\n  준비됐습니다.  python cli.py cycle  로 ①②③④ 한 바퀴를 돌립니다."))


# ── submit ────────────────────────────────────────────────────────
def cmd_submit(args) -> None:
    zones = db.zones()
    names = [z["name"] for z in zones]
    if args.zone:
        match = [z for z in zones if args.zone in z["name"]]
        if not match:
            print(red(f"구역을 찾을 수 없습니다: {args.zone}"))
            print(dim("  " + " / ".join(names)))
            return
        zid, zname = match[0]["id"], match[0]["name"]
    else:
        zid, zname = zones[0]["id"], zones[0]["name"]

    fid = db.insert_feedback(zid, args.text, source="cli")
    if fid is None:
        print(yellow("이미 접수된 내용입니다."))
        return

    with db.connect() as conn:
        stored = conn.execute("SELECT raw_text FROM feedback WHERE id=?", (fid,)).fetchone()
    print(green(f"접수 #{fid}") + f"  {zname}")
    print(f"  저장: {stored['raw_text']}")
    if stored["raw_text"] != args.text:
        print(yellow("  개인정보가 마스킹되었습니다."))
    print(dim(f"  대기열 {db.pending_count()}건 ·  python cli.py classify  로 분류"))


# ── 에이전트 ──────────────────────────────────────────────────────
def cmd_classify(args) -> None:
    from agents.classifier import run_once
    n = db.pending_count()
    if not n:
        print(dim("대기 중인 민원이 없습니다.")); return
    print(dim(f"①분류 에이전트 실행 (대기 {n}건)…"))
    out = run_once(limit=args.batch)
    print(f"  {out or '(응답 없음)'}")
    print(dim(f"  남은 대기 {db.pending_count()}건"))


def cmd_monitor(args) -> None:
    from agents.monitor import run_once
    print(dim("②심각도·감시 에이전트 실행…"))
    print(f"  {run_once(args.window or config.DEFAULT_WINDOW_MIN) or '(데이터 없음)'}")


def cmd_dispatch(args) -> None:
    from agents.dispatcher import pending_labels, run_for
    win = args.window or config.DEFAULT_WINDOW_MIN
    targets = pending_labels()
    if args.label:
        targets = [t for t in targets if t["label"] == args.label]
    if not targets:
        print(dim("조치요청서가 필요한 유형이 없습니다.")); return
    for t in targets[: args.limit]:
        print(dim(f"③조치 에이전트 실행 — {config.LABELS.get(t['label'], t['label'])}…"))
        print(f"  {run_for(t['label'], t['score'], t['grade'], t['formula'], win)}")


def cmd_brief(args) -> None:
    from agents.supervisor import run_once
    print(dim("④통합 에이전트 실행…"))
    print(f"  {run_once(args.window or config.DEFAULT_WINDOW_MIN) or '(데이터 없음)'}")


def cmd_cycle(args) -> None:
    """①②③④ 한 바퀴."""
    injected = replay.step()
    if injected:
        print(dim(f"리플레이 {injected}건 투입"))
    cmd_classify(args)
    cmd_monitor(args)
    cmd_dispatch(args)
    cmd_brief(args)


# ── replay ────────────────────────────────────────────────────────
def cmd_replay(args) -> None:
    seed_dir = Path(__file__).resolve().parent / "seed"
    if args.action == "start":
        path = seed_dir / args.file
        if not path.exists():
            print(red(f"시드 없음: {path}"))
            print(dim("  python scripts/make_dev_seed.py  로 생성")); return
        info = replay.start(path, speed=args.speed)
        print(green(f"재생 시작") + f"  {info['total']}건 · {info['speed']:.0f}배속 · "
              f"시작 {info['sim_start']}")
    elif args.action == "stop":
        replay.stop(); print("정지")
    elif args.action == "step":
        n = replay.step()
        print(f"{n}건 투입 · 대기열 {db.pending_count()}건")
    else:
        p = replay.progress()
        print(p if p else dim("재생 기록 없음"))


# ── db ────────────────────────────────────────────────────────────
TABLES = ["feedback", "classification", "severity", "alert", "action_request",
          "agent_log", "briefing", "issue", "zone", "festival", "classify_cache"]


def _secs(a, b):
    """두 ISO 시각의 차이(초). 없거나 해석 못 하면 None."""
    from datetime import datetime
    try:
        return (datetime.fromisoformat(str(b)) - datetime.fromisoformat(str(a))).total_seconds()
    except (TypeError, ValueError):
        return None


def show_feedback(target) -> None:
    """민원 1건의 시각·분류 상태. 접수부터 분류까지 걸린 시간을 DB 시각으로 잰다 (실사용자 검증 S2)."""
    import re
    s = str(target or "").strip()
    m_inbox = re.fullmatch(r"[Ww]-?(\d+)", s)            # 접수 완료 창의 'W-38' 은 접수번호(feedback_inbox.id)
    m_fb = re.fullmatch(r"#?(\d+)", s)                    # '#202'·'202' 는 민원 번호(feedback.id)
    if not (m_inbox or m_fb):
        print(red("사용법: python cli.py db show <번호>   W-38 = 접수 완료 창의 접수번호, #202 또는 202 = 민원 번호(관제 유입)"))
        return
    inbox_id = None
    with db.connect() as conn:
        if m_inbox:
            ib = conn.execute("SELECT id, feedback_id FROM feedback_inbox WHERE id = ?",
                              (int(m_inbox.group(1)),)).fetchone()
            if not ib:
                print(red(f"없는 접수번호입니다: W-{m_inbox.group(1)}")); return
            inbox_id = ib["id"]
            if ib["feedback_id"] is None:
                print(yellow(f"W-{inbox_id} 는 아직 접수 대기 중입니다 (워커가 가져가기 전). 잠시 뒤에 다시 보세요.")); return
            if ib["feedback_id"] < 0:
                print(yellow(f"W-{inbox_id} 는 저장되지 않았습니다 (같은 내용이 이미 있거나 내용이 없는 민원).")); return
            fid = ib["feedback_id"]
        else:
            fid = int(m_fb.group(1))
        row = conn.execute(
            """SELECT f.id, f.raw_text, f.ingested_at, f.posted_at, f.source, f.deleted_at,
                      COALESCE(z.name, ?) zone, c.label, c.status, c.processed_at, c.confidence,
                      c.is_safety, c.agent_note
               FROM feedback f
               LEFT JOIN zone z ON z.id = f.zone_id
               LEFT JOIN classification c ON c.feedback_id = f.id
               WHERE f.id = ?""", (config.ZONE_UNKNOWN, fid)).fetchone()
        inbox = conn.execute(
            "SELECT id, created_at FROM feedback_inbox WHERE feedback_id = ?", (fid,)).fetchone()
    if not row:
        print(red(f"없는 민원입니다: {fid}")); return
    # 두 번호를 같이 보여 준다: W-번호(방문객이 본 접수번호) · #번호(관제 유입의 민원 번호)
    rule(f"W-{inbox['id']} · 민원 #{fid}" if inbox else f"민원 #{fid}")
    print(f"  내용        {row['raw_text']}")
    print(f"  구역        {row['zone']}    출처 {row['source']}" + ("    " + red("지움(숨김)") if row["deleted_at"] else ""))
    if inbox:
        print(f"  접수함 시각 {inbox['created_at']}    (방문객이 제출한 시각)")
    print(f"  접수 시각   {row['ingested_at']}    (워커가 마스킹해서 feedback 에 넣은 시각)")
    print(f"  분류 시각   {row['processed_at'] or '-'}")
    label = config.LABELS.get(row["label"], row["label"]) if row["label"] else "-"
    print(f"  유형·상태   {label} · {row['status']}" +
          (f"  (신뢰도 {row['confidence']})" if row["confidence"] is not None else ""))
    d_ing = _secs(row["ingested_at"], row["processed_at"])
    d_inbox = _secs(inbox["created_at"], row["processed_at"]) if inbox else None
    print(f"  접수→분류   {'-' if d_ing is None else f'{d_ing:.0f}초'}")
    if d_inbox is not None:
        print(f"  제출→분류   {d_inbox:.0f}초    ← 방문객이 체감하는 반영 시간 (웹 접수만)")
    if row["status"] == "review" and row["agent_note"]:
        print(f"  확인 필요   {row['agent_note']}")
    print()


def cmd_db(args) -> None:
    if args.what == "tables":
        rule("테이블")
        with db.connect() as conn:
            for t in TABLES:
                try:
                    n = conn.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()["c"]
                    print(f"  {t:<20}{n:>7}행")
                except Exception:
                    print(dim(f"  {t:<20}      -"))
        print()

    elif args.what == "log":
        rule(f"에이전트 활동 로그 (최근 {args.limit})")
        for g in reversed(db.recent_logs(args.limit)):
            lat = f"{g['latency_ms']}ms" if g["latency_ms"] else ""
            print(f"  {dim(g['created_at'][11:19])} {cyan(g['agent']):<18} "
                  f"{g['action']:<22} {dim(lat)}")
            if g["output_summary"]:
                print(dim(f"      → {g['output_summary'][:90]}"))
        print()

    elif args.what == "feed":
        rule(f"최근 민원 (최근 {args.limit})")
        for f in db.recent_feedback(args.limit):
            label = config.LABELS.get(f["label"], "분류중") if f["label"] else "분류중"
            print(f"  #{f['id']:<4} {dim(str(f['ingested_at'])[11:19])} "
                  f"{bold(label):<12} {f['zone'] or config.ZONE_UNKNOWN:<16} {f['raw_text'][:40]}")
        print()

    elif args.what == "show":
        show_feedback(args.target)

    else:  # dump
        if args.what not in TABLES:
            print(red(f"모르는 테이블: {args.what}"))
            print(dim("  " + " / ".join(TABLES))); return
        rule(args.what)
        with db.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM {args.what} ORDER BY rowid DESC LIMIT ?", (args.limit,)
            ).fetchall()
        if not rows:
            print(dim("  (비어 있음)")); return
        cols = rows[0].keys()
        print("  " + dim(" | ".join(cols)))
        for r in reversed(rows):
            print("  " + " | ".join(str(r[k])[:28] for k in cols))
        print()


# ── reset ─────────────────────────────────────────────────────────
def cmd_reset(args) -> None:
    with db.connect() as conn:
        if args.all:
            for t in ["feedback", "classification", "severity", "alert",
                      "action_request", "agent_log", "briefing", "issue", "classify_cache"]:
                conn.execute(f"DELETE FROM {t}")
            conn.execute("DELETE FROM replay_state")
            print("전체 초기화 완료 (구역·축제 설정은 유지)")
        else:
            conn.execute("DELETE FROM severity")
            conn.execute("DELETE FROM alert")
            conn.execute("DELETE FROM briefing")
            conn.execute("UPDATE classification SET status='pending', label=NULL, "
                         "sentiment=NULL, is_safety=NULL, confidence=NULL")
            print(f"판정 초기화 완료 · 대기열 {db.pending_count()}건")
        conn.commit()


# ── demo ──────────────────────────────────────────────────────────
def cmd_demo(args) -> None:
    """E2E 한 번에 — 시드 투입 → 분류 → 판정 → 조치 → 브리핑."""
    seed = Path(__file__).resolve().parent / "seed" / args.file
    if not seed.exists():
        print(red(f"시드 없음: {seed}"))
        print(dim("  python scripts/make_dev_seed.py  로 생성")); return

    print(bold("\n[1/5] 시드 투입"))
    replay.start(seed, speed=1_000_000)          # 전량 즉시 도달
    total = 0
    while (n := replay.step(max_batch=80)):
        total += n
    print(f"  {total}건 투입 · 대기열 {db.pending_count()}건")

    print(bold("\n[2/5] 분류"))
    if args.stub:
        import subprocess
        subprocess.run([sys.executable, "scripts/stub_classify.py"], check=False)
    else:
        from agents.classifier import run_once
        while db.pending_count():
            out = run_once(limit=20)
            print(f"  {out[:100] if out else ''}")

    print(bold("\n[3/5] 심각도 판정"))
    span = _seed_span_minutes(seed)
    win = args.window or span
    print(dim(f"  시드가 {span // 60 // 24}일치라 창을 {win}분으로 잡습니다 "
              f"(실운영 기본값은 {config.DEFAULT_WINDOW_MIN}분)"))
    ranked, _ = ranked_now(win)
    for r in ranked[:5]:
        col = GRADE_COLOR.get(r["grade"], lambda s: s)
        print(col(f"  {config.LABELS.get(r['label'], r['label']):<10}"
                  f"{r['score']:>6}  {r['grade']:<10}{r['freq']:>4}건"))
    if ranked:
        counts = db.label_counts(win)
        top_count = max(counts, key=counts.get)
        if top_count != ranked[0]["label"]:
            print(green(f"\n  ★ 역전: 건수 1위는 {config.LABELS.get(top_count)}"
                        f"({counts[top_count]}건)이지만, "
                        f"심각도 1위는 {config.LABELS.get(ranked[0]['label'])}"
                        f"({ranked[0]['freq']}건)"))
            print(dim(f"    {ranked[0]['formula']}"))

    if args.stub:
        print(dim("\n[4/5] 조치·브리핑 — 스텁 모드에서는 건너뜁니다 (LLM 필요)"))
        print(dim("[5/5] 완료.  python cli.py status  로 확인"))
        return

    print(bold("\n[4/5] 조치요청서"))
    cmd_dispatch(argparse.Namespace(label=None, limit=1))

    print(bold("\n[5/5] 통합 브리핑"))
    cmd_brief(args)
    print(dim("\n완료.  python cli.py status  로 확인"))


def _seed_span_minutes(path) -> int:
    """시드 CSV가 몇 분치인지. 창 기본값을 데이터에 맞추는 데 쓴다."""
    import csv
    from datetime import datetime
    with open(path, encoding="utf-8-sig", newline="") as f:
        ts = [r["posted_at"] for r in csv.DictReader(f) if r.get("posted_at")]
    if len(ts) < 2:
        return config.DEFAULT_WINDOW_MIN
    lo, hi = datetime.fromisoformat(min(ts)), datetime.fromisoformat(max(ts))
    return max(config.DEFAULT_WINDOW_MIN, int((hi - lo).total_seconds() // 60) + 60)


# ── watch ─────────────────────────────────────────────────────────
BAR = "█"


def _bar(n: int, top: int, width: int = 18) -> str:
    if top <= 0:
        return ""
    return BAR * max(1, round(n / top * width)) if n else ""


def _frame(win: int, drive: bool) -> str:
    """한 프레임을 문자열로 만든다. watch 와 스냅샷이 같은 것을 쓴다."""
    from datetime import datetime

    out: list[str] = []
    A = out.append

    if drive:
        injected = replay.step()
        if db.pending_count():
            from agents.classifier import run_once
            run_once(limit=30)

    counts = db.label_counts(win)
    ranked = ranked_now(win)[0]
    pending = db.pending_count()
    prog = replay.progress()

    with db.connect() as conn:
        fest = conn.execute("SELECT name FROM festival LIMIT 1").fetchone()
        brief = conn.execute(
            "SELECT * FROM briefing ORDER BY id DESC LIMIT 1").fetchone()
        alerts = conn.execute(
            "SELECT * FROM alert ORDER BY id DESC LIMIT 3").fetchall()

    A(f"{bold(fest['name'] if fest else '축제')}  "
      f"{dim(datetime.now().strftime('%H:%M:%S'))}  "
      f"{_backend_line().strip()}")

    line = f"  분류완료 {sum(counts.values()):>4}  대기 {pending:>4}"
    if db.review_count():
        line += f"  확인필요 {db.review_count():>3}"     # 신뢰도 낮아 유형 미정 — 순위·알림 제외
        if db.review_safety_count():
            line += f" (안전의심 {db.review_safety_count()})"
    if prog and prog["total"]:
        pct = prog["cursor"] / prog["total"]
        state = "재생중" if prog["active"] else "정지"
        line += (f"   재생 [{BAR * round(pct * 20):<20}] "
                 f"{prog['cursor']}/{prog['total']} {state}")
        if prog["active"]:
            line += f"  시뮬 {prog['sim_now']}"
    A(dim(line))
    A("")

    top_c = max(counts.values()) if counts else 0
    top_s = max((r["score"] for r in ranked), default=0)
    A(f"  {'건수 순위':<26}{'심각도 순위'}")
    A(dim("  " + "─" * 62))
    cl = list(counts.items())
    for i in range(max(len(cl), len(ranked), 1)):
        left = right = ""
        if i < len(cl):
            k, v = cl[i]
            left = f"{config.LABELS.get(k, k):<9}{v:>4} {_bar(v, top_c, 10)}"
        if i < len(ranked):
            r = ranked[i]
            col = GRADE_COLOR.get(r["grade"], lambda s: s)
            right = col(f"{GRADE_MARK[r['grade']]}"
                        f"{config.LABELS.get(r['label'], r['label']):<9}"
                        f"{r['score']:>6} {_bar(int(r['score']), int(top_s), 10)}")
        A(f"  {left:<26}{right}")

    if ranked and cl and ranked[0]["label"] != cl[0][0]:
        A("")
        A(green(f"  ★ 역전  건수 1위 {config.LABELS.get(cl[0][0])}({cl[0][1]}건) "
                f"→ 심각도 1위 {config.LABELS.get(ranked[0]['label'])}"
                f"({ranked[0]['freq']}건)"))
        A(dim(f"    {ranked[0]['formula']}"))

    if alerts:
        A("")
        A(bold("  알림"))
        kind = {"spike": "급증", "safety_threshold": "안전 임계",
                "grade_up": "등급 상승"}
        for a in alerts:
            A(f"  {red('▲')} {kind.get(a['kind'], a['kind'])} "
              f"{config.LABELS.get(a['label'], a['label'])} "
              f"{dim(a['created_at'][11:19])}")

    if brief:
        A("")
        A(bold("  통합 브리핑") + dim(f"  {brief['created_at'][11:19]}"))
        text = brief["text"]
        for i in range(0, len(text), 60):
            A(f"  {cyan(text[i:i + 60])}")

    A("")
    A(bold("  에이전트 활동"))
    for g in reversed(db.recent_logs(6)):
        lat = f"{g['latency_ms']}ms" if g["latency_ms"] else ""
        A(f"  {dim(g['created_at'][11:19])} {cyan(g['agent']):<18}"
          f"{g['action']:<22}{dim(lat)}")
    return "\n".join(out)


def cmd_watch(args) -> None:
    """실시간 모니터. 화면을 지우고 다시 그린다."""
    import time as _t

    win = args.window or config.DEFAULT_WINDOW_MIN
    if args.once:
        print(_frame(win, args.drive))
        return

    print(dim("Ctrl+C 로 종료"))
    try:
        while True:
            frame = _frame(win, args.drive)
            # 커서를 원점으로 옮기고 화면을 지운다 (깜빡임 없이 다시 그리기)
            sys.stdout.write("\033[H\033[J")
            sys.stdout.write(frame + "\n")
            sys.stdout.flush()
            _t.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n종료")


# ── todo ──────────────────────────────────────────────────────────
def cmd_todo(args) -> None:
    """할 일 목록을 시스템 상태에서 다시 판정해 그린다."""
    import time as _t

    from core import todo

    if args.show:
        print(todo.render())
        return

    def once() -> None:
        done, total, changed = todo.refresh()
        mark = green("갱신") if changed else dim("변경 없음")
        pct = round(done / total * 100) if total else 0
        print(f"  {mark}  진행 {done}/{total} ({pct}%)  {dim(str(todo.TODO_PATH))}")

    if not args.watch:
        once()
        return

    # 파일이나 파이프로 넘길 때도 바로 보이도록 줄 단위로 내보낸다
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    print(dim(f"{todo.TODO_PATH} 감시 중 · Ctrl+C 로 종료"))
    once()
    last = todo.TODO_PATH.stat().st_mtime if todo.TODO_PATH.exists() else 0
    try:
        while True:
            _t.sleep(args.interval)
            now = todo.TODO_PATH.stat().st_mtime if todo.TODO_PATH.exists() else 0
            if now != last:                      # 사람이 고쳤다
                print(dim(f"  {_time()} 파일 변경 감지"))
                once()
                last = todo.TODO_PATH.stat().st_mtime
            else:                                # 시스템 상태가 바뀌었을 수 있다
                done, total, changed = todo.refresh()
                if changed:
                    print(f"  {_time()} {green('상태 변화 반영')}  진행 {done}/{total}")
                    last = todo.TODO_PATH.stat().st_mtime
    except KeyboardInterrupt:
        print("\n" + "종료")


def _time() -> str:
    from datetime import datetime
    return datetime.now().strftime("%H:%M:%S")


# ── main ──────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser(
        prog="cli.py", description="축제 민원 관제 — 터미널 인터페이스")
    ap.add_argument("--window", type=int, help="심각도 윈도우(분)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="현재 상태")
    sub.add_parser("check", help="API 키 확인 (최소 비용)")

    p = sub.add_parser("todo", help="할 일 목록 자동 갱신")
    p.add_argument("--watch", action="store_true", help="파일 변경을 감시해 실시간 반영")
    p.add_argument("--show", action="store_true", help="파일에 쓰지 않고 출력만")
    p.add_argument("--interval", type=float, default=2.0, help="감시 주기(초)")

    p = sub.add_parser("watch", help="실시간 모니터")
    p.add_argument("--interval", type=float, default=2.0, help="갱신 주기(초)")
    p.add_argument("--drive", action="store_true",
                   help="워커 없이 직접 리플레이 투입 + 분류까지 수행")
    p.add_argument("--once", action="store_true", help="한 프레임만 출력")

    p = sub.add_parser("submit", help="민원 접수")
    p.add_argument("text")
    p.add_argument("--zone", help="구역명 일부")

    p = sub.add_parser("classify", help="①분류 에이전트")
    p.add_argument("--batch", type=int, default=20)

    sub.add_parser("monitor", help="②심각도·감시 에이전트")

    p = sub.add_parser("dispatch", help="③조치 에이전트")
    p.add_argument("--label"); p.add_argument("--limit", type=int, default=1)

    sub.add_parser("brief", help="④통합 에이전트")

    p = sub.add_parser("cycle", help="①②③④ 한 바퀴")
    p.add_argument("--batch", type=int, default=20)
    p.add_argument("--label"); p.add_argument("--limit", type=int, default=1)

    p = sub.add_parser("replay", help="리플레이 제어")
    p.add_argument("action", choices=["start", "stop", "step", "status"])
    p.add_argument("--file", default="dev_sample.csv")
    p.add_argument("--speed", type=float, default=60.0)

    p = sub.add_parser("db", help="DB 조회")
    p.add_argument("what", nargs="?", default="tables",
                   help="tables | log | feed | show <민원번호> | <테이블명>")
    p.add_argument("target", nargs="?", help="show 의 민원 번호(feedback id)")
    p.add_argument("--limit", type=int, default=20)

    p = sub.add_parser("reset", help="초기화")
    p.add_argument("--all", action="store_true", help="민원까지 전부 삭제")

    p = sub.add_parser("demo", help="E2E 자동 실행")
    p.add_argument("--file", default="dev_sample.csv")
    p.add_argument("--stub", action="store_true", help="LLM 없이 (개발용 스텁 분류)")
    p.add_argument("--window", type=int, help="심각도 창(분). 기본은 시드 기간 전체")
    p.add_argument("--batch", type=int, default=20)
    p.add_argument("--label"); p.add_argument("--limit", type=int, default=1)

    args = ap.parse_args()
    db.init_db()
    replay.ensure()

    {
        "status": cmd_status, "check": cmd_check, "watch": cmd_watch,
        "todo": cmd_todo,
        "submit": cmd_submit, "classify": cmd_classify,
        "monitor": cmd_monitor, "dispatch": cmd_dispatch, "brief": cmd_brief,
        "cycle": cmd_cycle, "replay": cmd_replay, "db": cmd_db,
        "reset": cmd_reset, "demo": cmd_demo,
    }[args.cmd](args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n중단")
