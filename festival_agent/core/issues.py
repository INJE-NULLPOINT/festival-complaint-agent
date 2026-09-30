"""관제 '지금 조치할 일' 카드 (할일 D5-29).

카드 = (유형, 구역). 심각도 창 안의 status='done' 민원만 쓴다 (positive·review 제외).
구역이 없는 민원(zone_id NULL)은 '구역 미상' 카드 하나로 모은다.

결정적인 것 (이 모듈이 계산 — 같은 입력이면 같은 결과)
  등급      유형 등급을 그대로 물려받는다 (S-04·B-01~B-04). 안전 3건이 세 구역에 흩어져도 세 카드 모두 즉시.
  카드 점수 P = 유형 심각도 S × 집중 C × 최근 R
            C = 0.5 + 0.5 × (구역 건수 / 유형 건수)     0.5~1.0   ('구역 미상'은 0.5 고정)
            R = 1 − 0.5 × min(마지막 민원 경과분 / 창 길이, 1)   0.5~1.0
  정렬      ① 조치 그룹(본 목록 → 조치 중 → 조치 완료; 완료 뒤 새 민원이 오면 본 목록 복귀,
               요청서 이후 새로 생긴 구역의 카드는 '조치 중'이어도 본 목록에 남고 new_since_request 표시)
            ② 등급 ③ 안전 계열(안전·혼잡) 먼저 ④ 카드 점수 ⑤ 마지막 민원 시각(최신 우선)
            (같은 등급이면 안전 계열이 먼저 — 비안전 카드가 집중도 덕에 점수가 더 높아도 안전·혼잡을 앞지르지 못한다)
  노출      유형 등급이 mid 이상이거나 안전 유형. 본 목록은 상위 5장, 나머지는 '그 밖'.
  건수·마지막 시각·최신 민원(latest_quotes)은 매 주기 LLM 없이 바로 갱신한다.

AI 가 정하는 것 (④통합이 기존 1회 호출 안에서)
  문제 한 줄(title) · 해야 할 일(2~4개, 각각 근거 민원 quote_id 1개) → 실시간 근거 민원을 읽고 판단·정리한다.
  숫자(건수·시각·점수)는 코드가 넣는다. 저장 전에 결정적으로 검사하고, 실패한 카드는 템플릿으로 채운다.
  조치 목록(config.ACTION_CATALOG)은 프롬프트의 '참고 예시'일 뿐 고르도록 강제하지 않는다.
  문구는 카드마다 최소 CARD_TEXT_MIN_INTERVAL 초 간격으로만 다시 쓴다 (등급·조치 그룹이 바뀌면 즉시).
  evidence_quotes(문구의 근거)는 문구를 다시 쓸 때만 바뀐다. latest_quotes 는 매 주기 바뀐다.

저장은 issue 테이블 한 행 = 카드 한 장. 계산 열은 refresh() 가, 문장 열은 apply_entries() 가 따로 갱신한다.
"""
import json
import re
from datetime import datetime

from . import config, db, privacy

GRADE_ORDER = {"immediate": 0, "high": 1, "mid": 2, "low": 3}
GROUP_ORDER = {"main": 0, "in_progress": 1, "done": 2}

TOP_N = 3               # ④가 문장을 만드는 카드 수
MAIN_MAX = 5            # 본 목록 최대 장수 (넘치면 group='more')
CANDIDATES = 5          # 카드마다 근거 후보 민원 수 (최신 순, 지시문 형태 민원은 뺀 것)
INJECTED_KEEP = 2       # 지시문 형태 민원은 근거가 못 되고, 원문 복사 검사와 투명한 표시용으로만 뒤에 붙여 둔다
LATEST_SHOWN = 3        # latest_quotes 에 담는 최신 민원 수
TITLE_MAX = 40
ACTION_MIN, ACTION_MAX, ACTION_LEN = 2, 4, 50
MAX_FAIL = 2            # 같은 서명에서 AI 문장이 이만큼 실패하면 템플릿으로 두고 다시 부르지 않는다
COPY_RUN = 12           # 조치 문장이 민원 원문과 연속 이만큼 같으면 거부 (민원이 조치를 조종하는 것을 막음)

# 한글 수사 + 단위("세 명", "오십 대", "열 분")도 숫자와 같은 '수치 약속'으로 보고 거부한다.
# "이번"·"한 건물"·"한 장소"·"분명" 같은 평범한 말과 겹치지 않게: 한 글자 한자어 수사(이·삼·오…)와 단위 건·장·마리·배는
# 제외하고, 대·개·회·분 뒤에 흔한 글자(기·선·의·명 …)가 이어지면 단위로 보지 않는다.
_NATIVE_NUM = r"(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스물|서른|마흔|쉰|예순|일흔|여든|아흔)"
_SINO_NUM = r"(?:(?:이|삼|사|오|육|칠|팔|구)?십|백|천|만)"
_UNIT = (r"(?:명|곳|번|차례|군데|시간"
         r"|대(?!기|표|체|책|응|학|원|략)|개(?!선|소|방|최|인|념)|회(?!의|사|원|복|전)|분(?!명|야|석|리|위|량)"
         r"|배(?!치|려|경|달|출|정|포|송|분|급|열|수|상|우|움))")      # '두 배로 늘림' 같은 배수 표현도 수량 약속
NUMBER_WORDS_RE = re.compile(rf"(?:{_NATIVE_NUM}|{_SINO_NUM})\s?{_UNIT}")
_ONCE = re.compile(r"한\s?(?:번|차례)")     # '한 번 더 안내방송' 은 수량 약속이 아니다


class _NumberWords:
    """NUMBER_WORDS.search(text) — '한 번'·'한 차례'는 빼고 찾는다."""

    @staticmethod
    def search(text: str):
        return NUMBER_WORDS_RE.search(_ONCE.sub("", text or ""))


NUMBER_WORDS = _NumberWords()

# 계산 열 — refresh() 가 바꾼다
_COMPUTED = ("rank_no", "grp", "label", "zone_id", "zone_name", "grade", "is_safety", "type_score",
             "conc", "rec", "card_score", "formula", "freq", "type_freq", "last_at",
             "same_zone_others", "recurred", "new_since_request", "action_status", "action_request_id", "department",
             "contact", "signature", "latest_quotes")


def _zone_key(zone_id) -> str:
    return "x" if zone_id is None else str(zone_id)


def issue_key(label: str, zone_id) -> str:
    return f"{label}:{_zone_key(zone_id)}"


def _dumps(v) -> str:
    return json.dumps(v, ensure_ascii=False)


# ── 카드 계산 (결정적) ─────────────────────────────────────────────

def build_cards(window_min: int | None = None) -> list[dict]:
    """지금 상태에서 카드 목록을 만든다. 정렬·rank_no·grp 까지 채워 돌려준다."""
    win = window_min or config.DEFAULT_WINDOW_MIN
    rows = [dict(r) for r in db.window_rows(win)]
    ranked = db.ranked(win)
    ref = db.data_now()
    zone_names = {z["id"]: z["name"] for z in db.zones()}
    actions = db.latest_actions()

    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        if r["label"] in config.EXCLUDED_FROM_SEVERITY:
            continue
        groups.setdefault((r["label"], r["zone_id"]), []).append(r)

    cards: list[dict] = []
    for sev in ranked:
        label = sev["label"]
        if sev["grade"] == "low" and not sev["safety_w"] > 1:     # 노출 조건: mid 이상 또는 안전
            continue
        for (lb, zone_id), items in groups.items():
            if lb == label:
                cards.append(_card(sev, zone_id, items, win, ref, zone_names, actions.get(label)))

    # 같은 구역의 다른 문제 수 (구역 미상은 위치가 아니므로 세지 않는다)
    per_zone: dict = {}
    for c in cards:
        if c["zone_id"] is not None:
            per_zone[c["zone_id"]] = per_zone.get(c["zone_id"], 0) + 1
    for c in cards:
        c["same_zone_others"] = per_zone[c["zone_id"]] - 1 if c["zone_id"] is not None else 0

    cards.sort(key=lambda c: c["last_at"], reverse=True)         # 마지막 시각 최신 우선 (동점 처리)
    cards.sort(key=lambda c: (GROUP_ORDER[c["raw_group"]], GRADE_ORDER[c["grade"]],
                              -c["is_safety"], -c["card_score"]))
    main_seen = 0
    for i, c in enumerate(cards, 1):
        c["rank_no"] = i
        if c["raw_group"] == "main":
            main_seen += 1
            c["grp"] = "main" if main_seen <= MAIN_MAX else "more"
        else:
            c["grp"] = c["raw_group"]
    return cards


def _card(sev: dict, zone_id, items: list[dict], win: int, ref: datetime,
          zone_names: dict, act: dict | None) -> dict:
    label = sev["label"]
    fz, fl, S = len(items), sev["freq"], sev["score"]
    C = 0.5 if zone_id is None else 0.5 + 0.5 * (fz / fl if fl else 0.0)
    ordered = sorted(items, key=lambda i: (i["posted_at"] or "", i["feedback_id"]), reverse=True)
    last_at = ordered[0]["posted_at"] or ""
    try:
        elapsed = max((ref - datetime.fromisoformat(last_at)).total_seconds() / 60.0, 0.0)
    except ValueError:
        elapsed = float(win)
    R = 1.0 - 0.5 * min(elapsed / win, 1.0)
    P = round(S * C * R, 1)
    zone_name = zone_names.get(zone_id) if zone_id is not None else None
    zone_name = zone_name or config.ZONE_UNKNOWN
    conc_note = "구역 미상 고정" if zone_id is None else f"{fz}/{fl}건"
    formula = (f"유형 {S:.1f} × 집중 {C:.2f}({conc_note}) × 최근 {R:.2f}"
               f"({int(elapsed)}분 전/창 {win}분) = {P:.1f}")

    # 조치 그룹 — 조치 상태는 1차에서 유형 단위 요청서 상태를 쓴다
    status = act["status"] if act else None
    recurred, new_since, raw_group = False, False, "main"
    if status == "in_progress":
        # 유형 단위 요청서라 다른 구역에서 새로 생긴 같은 유형 카드도 '조치 중'으로 접히는 문제:
        # 이 카드의 민원이 전부 요청서를 만든 뒤에 들어왔으면 본 목록에 두고 '요청서 이후 새 구역'을 표시한다.
        first_in = min((i["ingested_at"] or "" for i in items), default="")
        new_since = bool(act.get("created_at")) and first_in > act["created_at"]
        raw_group = "main" if new_since else "in_progress"
    elif status == "done":
        closed = act.get("closed_at") or act.get("created_at") or ""
        recurred = any((i["ingested_at"] or "") > closed for i in items)   # 적재 시각(실제 시계)으로 비교
        raw_group = "main" if recurred else "done"

    dept, contact = config.DEPARTMENT_MAP.get(label, ("미지정", "-"))
    # 지시문 형태 민원("AI 에게: … 조치에 넣어라")은 근거 후보에서 빼고 맨 뒤로 보낸다. 근거로 인정하면 공격 원문에 적힌
    # 시설명·조치가 그대로 통과하기 때문이다. 원문 복사 검사에는 계속 쓰인다 (injection=True).
    bad = [i for i in ordered if privacy.looks_like_injection(i["raw_text"] or "")]
    ok = [i for i in ordered if not privacy.looks_like_injection(i["raw_text"] or "")]
    cands = [{"id": i["feedback_id"], "text": i["raw_text"], "posted_at": i["posted_at"], "injection": False}
             for i in ok[:CANDIDATES]]
    cands += [{"id": i["feedback_id"], "text": i["raw_text"], "posted_at": i["posted_at"], "injection": True}
              for i in bad[:INJECTED_KEEP]]
    # 최신 민원 표시에도 지시문 형태는 뺀다 (지시문뿐인 카드만 그대로 보여 준다)
    shown = [{k: c[k] for k in ("id", "text", "posted_at")}
             for c in ([c for c in cands if not c["injection"]][:LATEST_SHOWN] or cands[:LATEST_SHOWN])]
    return {
        "key": issue_key(label, zone_id), "label": label, "zone_id": zone_id, "zone_name": zone_name,
        "grade": sev["grade"], "is_safety": int(sev["safety_w"] > 1), "type_score": S,
        "conc": round(C, 2), "rec": round(R, 2), "card_score": P, "formula": formula,
        "freq": fz, "type_freq": fl, "last_at": last_at, "same_zone_others": 0,
        "recurred": int(recurred), "new_since_request": int(new_since), "raw_group": raw_group,
        "action_status": status or "none", "action_request_id": act["id"] if act else None,
        "department": dept, "contact": contact,
        "signature": f"{label}|{_zone_key(zone_id)}|{sev['grade']}|{raw_group}",
        "member_ids": [i["feedback_id"] for i in items],
        "candidates": cands, "latest_quotes": _dumps(shown),
        "rank_no": 0, "grp": raw_group,
    }


# ── 문장: 템플릿 · 결정적 검사 ─────────────────────────────────────

def catalog_examples(label: str) -> list[str]:
    """프롬프트의 '참고 예시'이자 템플릿 조치의 재료. 고르도록 강제하지 않는다."""
    return list(config.ACTION_CATALOG.get(label, []))


def escalation_allowed(card: dict) -> bool:
    """중단·폐쇄·대피 같은 고위험 표현은 안전 유형 카드이면서 즉시 등급일 때만 허용."""
    return bool(card["is_safety"]) and card["grade"] == "immediate"


def escalation_hits(text: str) -> list[str]:
    """고위험 표현이 든 것. 공백은 무시하고 비교한다 ('진입  통제' 도 잡는다). '통제선' 같은 평범한 말은 잡지 않는다."""
    flat = _flat(text)
    return [w for w in config.ESCALATION_WORDS if _flat(w) in flat]


def template_entry(card: dict) -> dict:
    """AI 문장이 없거나 검사에 실패한 카드의 기본 문장.

    제목은 '{구역} — {유형} 민원', 조치는 참고 예시 앞 2개(고위험 표현은 허용된 카드에서만),
    근거는 가장 최근 민원 1건.
    """
    label_ko = config.LABELS.get(card["label"], card["label"])
    ok = escalation_allowed(card)
    acts = [a for a in catalog_examples(card["label"]) if ok or not escalation_hits(a)][:2]
    acts = acts or ["담당 부서 현장 확인 후 조치 방안 수립"]
    qid = _usable(card)[0]["id"] if _usable(card) else card["candidates"][0]["id"]
    return {"issue_key": card["key"], "title": f"{card['zone_name']} — {label_ko} 민원",
            "actions": [{"text": a, "quote_id": qid} for a in acts]}


def _usable(card: dict) -> list[dict]:
    """근거로 쓸 수 있는 후보 — 지시문 형태 민원은 제외."""
    return [c for c in card["candidates"] if not c.get("injection")]


def _as_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _flat(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _shares_run(a: str, b: str, n: int = COPY_RUN) -> bool:
    """a 와 b 가 공백을 뺀 채 연속 n자 이상 같은가."""
    a, b = _flat(a), _flat(b)
    return len(a) >= n and any(a[i:i + n] in b for i in range(len(a) - n + 1))


def check_entry(card: dict, entry) -> tuple[list[str], dict]:
    """AI 가 만든 카드 문장을 저장 전에 결정적으로 검사한다. (오류 목록, 정리된 문장). 오류가 없으면 통과.

    ① 조치마다 quote_id 1개, 이 카드의 근거 후보 안에 있어야 함
    ② 조치는 2~4개, 각 50자 이하. title 은 2~40자
    ③ 숫자 없음 (title·조치. 한글 수사+단위 '세 명'·'오십 대' 포함, 긴급 전화 119·112 는 예외), title 에 다른 구역 이름 없음
    ④ title·조치의 장소·시설 단어(config.PLACE_WORDS)는 이 카드의 근거 민원 원문(후보 전체)이나
       구역 이름에 있어야 함. '조명'은 민원에 '어둡다'는 말이 있어도 인정(config.PLACE_ALIASES).
       실제 모델로 재 보니 조치가 인용한 민원 1건만 기준으로 하면 통과율이 너무 낮아(4장 중 1장) 카드 단위로 넓혔다.
    ⑤ 조치가 근거 민원 원문과 연속 12자 이상 같으면 거부 (민원 문장을 조치로 옮겨 적지 못하게)
    ⑥ 고위험 표현(config.ESCALATION_WORDS): 안전 유형 + 즉시 등급 카드에서만 허용하고
       needs_judgment=1 로 표시한다. 그 밖의 카드에서는 그 조치만 뺀다 (뺀 뒤 2개 미만이면 실패).
       title 에 있으면 허용되지 않는 카드에서는 실패.
    """
    if not isinstance(entry, dict):
        return ["문장을 주지 않음"], {}
    errs: list[str] = []
    pool = _usable(card)                              # 지시문 형태 민원은 근거도, 장소 단어의 출처도 아니다
    cand = {c["id"]: c for c in pool}
    zone = card["zone_name"]
    all_text = " ".join(c["text"] or "" for c in pool) + " " + zone
    if not pool:
        errs.append("근거로 쓸 수 있는 민원이 없음 (지시문 형태 민원뿐)")

    def grounded(word: str) -> bool:
        return word in all_text or any(a in all_text for a in config.PLACE_ALIASES.get(word, []))

    title = entry.get("title")
    title = title.strip() if isinstance(title, str) else ""
    if not 2 <= len(title) <= TITLE_MAX:
        errs.append(f"title 은 2~{TITLE_MAX}자여야 함 (지금 {len(title)}자)")
    if re.search(r"\d", title) or NUMBER_WORDS.search(title):
        errs.append("title 에 숫자(한글 수사 포함)가 있음")
    for z in config.ZONES:                                    # 다른 구역 이름 금지
        if z != zone and z in title:
            errs.append(f"title 에 다른 구역 이름 '{z}' 이 있음")
    for w in config.PLACE_WORDS:
        if w in title and not grounded(w):
            errs.append(f"title 의 '{w}' 가 근거 민원·구역 이름에 없음 (지어낸 장소·시설 의심)")
    if escalation_hits(title) and not escalation_allowed(card):
        errs.append(f"title 에 고위험 표현 {escalation_hits(title)} (안전·즉시 카드만 허용)")

    raw = entry.get("actions")
    if not isinstance(raw, list) or len(raw) > ACTION_MAX:
        errs.append(f"actions 는 {ACTION_MIN}~{ACTION_MAX}개 목록이어야 함")
        raw = raw[:ACTION_MAX] if isinstance(raw, list) else []
    kept: list[dict] = []
    judged, dropped = 0, []
    for a in raw:
        if not isinstance(a, dict):
            errs.append("조치는 {text, quote_id} 형식이어야 함")
            continue
        text = a.get("text").strip() if isinstance(a.get("text"), str) else ""
        qid = _as_int(a.get("quote_id"))
        if not text or len(text) > ACTION_LEN:
            errs.append(f"조치 문장은 1~{ACTION_LEN}자여야 함: {text[:15]}…")
            continue
        if qid not in cand:
            errs.append(f"조치 '{text[:12]}…' 의 quote_id {a.get('quote_id')!r} 가 근거 후보 {sorted(cand)} 밖에 있음")
            continue
        if re.search(r"\d", re.sub(r"119|112", "", text)) or NUMBER_WORDS.search(text):
            errs.append(f"조치 문장에 숫자(한글 수사 포함)가 있음: {text[:15]}…")
            continue
        bad = [w for w in config.PLACE_WORDS if w in text and not grounded(w)]
        if bad:
            errs.append(f"조치 '{text[:12]}…' 의 {bad} 가 이 카드의 근거 민원·구역 이름에 없음 (지어낸 장소·시설 의심)")
            continue
        if any(_shares_run(text, c["text"]) for c in card["candidates"]):      # 지시문 민원도 포함해서 본다
            errs.append(f"조치 '{text[:12]}…' 가 민원 원문과 연속 {COPY_RUN}자 이상 같음 (원문을 옮겨 적음)")
            continue
        if escalation_hits(text):
            if escalation_allowed(card):
                judged = 1
            else:
                dropped.append(text)
                continue                                       # 허용되지 않는 카드 — 그 조치만 뺀다
        kept.append({"text": text, "quote_id": qid})
    if len(kept) < ACTION_MIN:
        errs.append(f"통과한 조치가 {len(kept)}개뿐 (2개 이상 필요)"
                    + (f", 고위험 표현으로 뺀 조치 {len(dropped)}개" if dropped else ""))
    return errs, {"title": title, "actions": kept, "needs_judgment": judged, "dropped": dropped}


def _evidence(card: dict, actions: list[dict]) -> list[dict]:
    """조치가 인용한 민원 (중복 없이, 조치 순서대로). 스냅샷이라 문구를 다시 쓸 때만 바뀐다."""
    cand = {c["id"]: c for c in card["candidates"]}
    seen: dict[int, dict] = {}
    for a in actions:
        q = cand.get(a["quote_id"])
        if q and q["id"] not in seen:
            seen[q["id"]] = {"id": q["id"], "text": q["text"], "posted_at": q["posted_at"]}
    return list(seen.values())


def _text_columns(card: dict, cleaned: dict, source: str) -> dict:
    acts = [{"text": a["text"], "quote_id": a["quote_id"], "source": source} for a in cleaned["actions"]]
    return {"title": cleaned["title"], "actions": _dumps(acts),
            "evidence_quotes": _dumps(_evidence(card, cleaned["actions"])),
            "needs_judgment": int(cleaned.get("needs_judgment", 0))}


def _same_text(old: dict, new: dict) -> bool:
    """문구가 실제로 같은가 — 제목과 조치 문장만 본다 (근거·시각은 제외)."""
    def texts(s):
        try:
            return [a["text"] for a in json.loads(s or "[]")]
        except (ValueError, KeyError, TypeError):
            return []
    return old.get("title") == new["title"] and texts(old.get("actions")) == texts(new["actions"])


# ── 저장 ──────────────────────────────────────────────────────────

def _computed_values(c: dict) -> tuple:
    return tuple(c[k] for k in _COMPUTED)


def refresh(window_min: int | None = None) -> tuple[int, list[dict]]:
    """카드를 다시 계산해 issue 테이블에 반영한다. (바뀐 행 수, 카드 목록).

    새 카드는 템플릿 문장으로 넣는다. 계산 열(건수·마지막 시각·최신 민원 포함)만 갱신하고,
    AI 문장(title·actions·evidence_quotes)은 text_source 가 'template' 인 행만 다시 쓴다.
    값이 그대로면 쓰지 않는다 (SSE 지문이 흔들리지 않게).
    """
    cards = build_cards(window_min)
    now = db.now()
    changed = 0
    cols = ", ".join(_COMPUTED)
    marks = ",".join("?" * len(_COMPUTED))
    with db.connect() as conn:
        rows = {r["issue_key"]: dict(r) for r in conn.execute("SELECT * FROM issue").fetchall()}
        deleted_ids = {r["id"] for r in conn.execute(
            "SELECT id FROM feedback WHERE deleted_at IS NOT NULL").fetchall()}
        for c in cards:
            old = rows.get(c["key"])
            tpl = _text_columns(c, template_entry(c), "template")
            if old is None:
                conn.execute(
                    f"""INSERT OR IGNORE INTO issue (festival_id, issue_key, active, updated_at,
                          title, actions, evidence_quotes, needs_judgment, text_source, fail_count,
                          gen_max_id, text_updated_at, {cols})
                        VALUES (?,?,1,?,?,?,?,?,'template',0,0,?,{marks})""",
                    (db.festival_id(), c["key"], now, tpl["title"], tpl["actions"],
                     tpl["evidence_quotes"], tpl["needs_judgment"], now, *_computed_values(c)),
                )
                changed += 1
                continue
            touched = False
            if not (old["active"] == 1 and tuple(old[k] for k in _COMPUTED) == _computed_values(c)):
                conn.execute(
                    f"UPDATE issue SET {', '.join(f'{k}=?' for k in _COMPUTED)}, active=1, updated_at=? "
                    "WHERE issue_key=?", (*_computed_values(c), now, c["key"]))
                touched = True
            # 문장 열은 ④ 가 같은 때 쓸 수 있다. 읽은 값 그대로일 때만 덮어써서 서로의 쓰기를 지우지 않는다.
            if old["text_source"] != "template" and deleted_ids:
                # 운영자가 지운 민원은 문구의 근거 인용에서도 바로 뺀다 (문구는 다음 재생성 때 고친다)
                try:
                    ev = json.loads(old["evidence_quotes"] or "[]")
                except ValueError:
                    ev = []
                kept = [e for e in ev if e.get("id") not in deleted_ids]
                if len(kept) != len(ev):
                    conn.execute("UPDATE issue SET evidence_quotes=?, updated_at=? "
                                 "WHERE issue_key=? AND evidence_quotes=?",
                                 (_dumps(kept), now, c["key"], old["evidence_quotes"]))
                    touched = True
            if old["text_source"] == "template" and any(old[k] != tpl[k] for k in tpl):
                sets = [f"{k}=?" for k in tpl]
                vals = list(tpl.values())
                if not _same_text(old, tpl):
                    sets.append("text_updated_at=?")
                    vals.append(now)
                conn.execute(f"UPDATE issue SET {', '.join(sets)}, updated_at=? "
                             "WHERE issue_key=? AND text_source='template'", (*vals, now, c["key"]))
                touched = True
            changed += touched
        live = {c["key"] for c in cards}
        for k, r in rows.items():
            if r["active"] == 1 and k not in live:        # 창 밖으로 나간 카드 — 문장은 남긴다
                conn.execute("UPDATE issue SET active=0, updated_at=? WHERE issue_key=?", (now, k))
                changed += 1
        conn.commit()
    return changed, cards


def stored() -> dict[str, dict]:
    with db.connect() as conn:
        return {r["issue_key"]: dict(r) for r in conn.execute("SELECT * FROM issue").fetchall()}


def _age_sec(ts: str | None, now: datetime) -> float:
    try:
        return (now - datetime.fromisoformat(ts)).total_seconds()
    except (TypeError, ValueError):
        return float("inf")


def needs_text(card: dict, row: dict | None, now: datetime | None = None) -> bool:
    """이 카드의 문장을 AI 가 (다시) 만들어야 하는가.

    ① 새 카드이거나 서명(유형·구역·등급·조치 그룹)이 바뀜 → 간격과 상관없이 바로
    ② 마지막 생성 뒤 CARD_TEXT_MIN_INTERVAL 초가 지났고, 새 민원이 들어왔거나 저장한 근거가 창 밖으로 나감
    ③ 템플릿으로 떨어진 카드는 MAX_FAIL 번까지만, 같은 간격으로 다시 시도
    """
    if row is None or row["gen_signature"] != card["signature"]:
        return True
    if _age_sec(row["gen_at"], now or datetime.now()) < config.CARD_TEXT_MIN_INTERVAL:
        return False
    if row["text_source"] == "template":
        return (row["fail_count"] or 0) < MAX_FAIL
    if max(card["member_ids"], default=0) > (row["gen_max_id"] or 0):
        return True
    try:
        quote_ids = {q["id"] for q in json.loads(row["evidence_quotes"] or "[]")}
    except (ValueError, KeyError, TypeError):
        quote_ids = set()
    return not quote_ids <= set(card["member_ids"])


def plan(window_min: int | None = None) -> dict:
    """④ 호출 전 계획. 카드를 새로 계산·저장하고 상위 TOP_N 중 문장을 만들 카드를 고른다.

    sig 는 상위 카드의 서명 묶음 — 브리핑에 저장해 두었다가 같고 만들 카드가 없으면
    ④ 호출 자체를 건너뛴다.
    """
    _, cards = refresh(window_min)
    top = cards[:TOP_N]
    rows = stored()
    now = datetime.now()
    need = [c for c in top if needs_text(c, rows.get(c["key"]), now)]
    return {"cards": cards, "top": top, "need": need,
            "sig": "||".join(c["signature"] for c in top), "rows": rows}


def apply_entries(entries, source: str = "llm", window_min: int | None = None) -> dict:
    """④ 가 준 카드 문장을 검사해 저장한다. 문장이 필요한 카드(plan 의 need)만 받는다.

    source='llm'   검사에 실패했거나 문장을 주지 않은 카드는 템플릿으로 저장하고 agent_log 에 사유를
                   남긴다. 재호출은 하지 않는다 — 다음 주기에 다시 시도한다 (MAX_FAIL 까지).
    source='local' 규칙 기반 대역 — 템플릿 문장을 그대로 저장한다 (검사 대상 아님).
    """
    p = plan(window_min)
    by_key = {e.get("issue_key"): e for e in (entries or []) if isinstance(e, dict)}
    need_keys = {c["key"] for c in p["need"]}
    out = {"saved": 0, "template": 0, "ignored": sorted(k for k in by_key if k not in need_keys),
           "errors": {}}
    now = db.now()
    with db.connect() as conn:
        for c in p["need"]:
            old = p["rows"].get(c["key"]) or {}
            errs: list[str] = []
            if source == "local":
                cleaned, src = template_entry(c), "local"
                cleaned["needs_judgment"] = int(any(escalation_hits(a["text"]) for a in cleaned["actions"]))
            else:
                errs, cleaned = check_entry(c, by_key.get(c["key"]))
                src = "llm"
            fails = 0
            if errs:
                cleaned, src = template_entry(c), "template"
                cleaned["needs_judgment"] = int(any(escalation_hits(a["text"]) for a in cleaned["actions"]))
                fails = ((old.get("fail_count") or 0) + 1) if old.get("gen_signature") == c["signature"] else 1
                out["template"] += 1
                out["errors"][c["key"]] = errs
            else:
                out["saved"] += 1
            cols = _text_columns(c, cleaned, src)
            sets = [f"{k}=?" for k in cols] + [
                "text_source=?", "gen_signature=?", "gen_max_id=?", "gen_at=?", "fail_count=?", "updated_at=?"]
            vals = [*cols.values(), src, c["signature"], max(c["member_ids"], default=0), now, fails, now]
            if not _same_text(old, cols) or not old.get("text_updated_at"):
                sets.append("text_updated_at=?")
                vals.append(now)
            conn.execute(f"UPDATE issue SET {', '.join(sets)} WHERE issue_key=?", (*vals, c["key"]))
        conn.commit()
    for key, errs in out["errors"].items():
        db.log_agent("supervisor", "issue_check_failed", key, "; ".join(errs)[:200],
                     "결정적 검사 실패 — 템플릿으로 저장, 다음 주기에 다시 시도")
    return out


def actions_for_label(label: str, limit: int = ACTION_MAX) -> list[str]:
    """조치요청서(③)에 넘길 조치 — 그 유형의 관제 카드들에서 AI 가 정리한 조치를 카드 순서대로.

    템플릿 카드의 조치는 쓰지 않는다 (AI 가 판단한 문장이 아니므로 ③이 스스로 쓰게 둔다).
    """
    out: list[str] = []
    for r in list_active():
        if r["label"] != label or r["text_source"] not in ("llm", "local"):
            continue
        try:
            for a in json.loads(r["actions"] or "[]"):
                if a["text"] not in out:
                    out.append(a["text"])
        except (ValueError, KeyError, TypeError):
            continue
    return out[:limit]


def list_active() -> list[dict]:
    """API 용 — 지금 보이는 카드, 화면 순서대로. 표의 열 그대로 (JSON 열은 문자열)."""
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM issue WHERE active=1 ORDER BY rank_no").fetchall()
    return [dict(r) for r in rows]
