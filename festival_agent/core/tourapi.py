"""한국관광공사 TourAPI 4.0 연동 (외부 API — 심사 'Tool 4점' 근거).

서비스: 한국관광공사_국문 관광정보 서비스_GW  (공공데이터포털 데이터 15101578)
엔드포인트: http://apis.data.go.kr/B551011/KorService2
사용 오퍼레이션: searchFestival2 (축제정보), detailCommon2 (공통 상세)

키 발급
  1. data.go.kr 에서 위 서비스 '활용신청'  (자동승인)
  2. 마이페이지 → 개발계정 → **일반 인증키(Decoding)** 복사
  3. .env 에  TOURAPI_KEY=...  로 저장

★ 설계 원칙: 이 API가 실패해도 시스템은 계속 돈다.
   키가 없거나 호출이 실패하면 config.ZONES 수기 시드가 그대로 쓰인다.
   (설명회 자료: "API 실패 시 샘플 데이터로 대체" — Fallback 확보)
"""
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

from . import db

BASE = "http://apis.data.go.kr/B551011/KorService2"
AREA_GYEONGNAM = "36"          # 경상남도
MOBILE_APP = "GnFestivalAgent"
TIMEOUT = 10


class TourAPIError(RuntimeError):
    pass


def api_key() -> str | None:
    return os.getenv("TOURAPI_KEY") or None


def available() -> bool:
    return api_key() is not None


def _call(operation: str, **params) -> list[dict]:
    """TourAPI 호출 → items 리스트. 실패하면 TourAPIError."""
    key = api_key()
    if not key:
        raise TourAPIError("TOURAPI_KEY 미설정")

    query = {
        "serviceKey": key,
        "MobileOS": "ETC",
        "MobileApp": MOBILE_APP,
        "_type": "json",
        "numOfRows": 50,
        "pageNo": 1,
        **params,
    }
    url = f"{BASE}/{operation}?" + urllib.parse.urlencode(query)

    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT, context=ctx) as resp:
            raw = resp.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise TourAPIError(f"네트워크 오류: {exc}") from exc

    # 키가 틀리면 JSON 대신 XML 오류문서가 온다
    if raw.lstrip().startswith("<"):
        snippet = raw.strip()[:200].replace("\n", " ")
        raise TourAPIError(f"XML 오류 응답 (키 확인 필요): {snippet}")

    try:
        body = json.loads(raw)["response"]["body"]
    except (json.JSONDecodeError, KeyError) as exc:
        raise TourAPIError(f"응답 파싱 실패: {raw[:200]}") from exc

    items = (body.get("items") or {}).get("item") or []
    return items if isinstance(items, list) else [items]


def search_festivals(area_code: str = AREA_GYEONGNAM,
                     event_start: str | None = None,
                     keyword: str | None = None) -> list[dict]:
    """경남 축제 목록. event_start 는 YYYYMMDD (해당일 이후 시작·진행 중인 축제)."""
    items = _call(
        "searchFestival2",
        areaCode=area_code,
        eventStartDate=event_start or datetime.now().strftime("%Y%m%d"),
        arrange="A",
    )
    out = [{
        "content_id": it.get("contentid"),
        "title": (it.get("title") or "").strip(),
        "addr": (it.get("addr1") or "").strip(),
        "start_date": it.get("eventstartdate"),
        "end_date": it.get("eventenddate"),
        "tel": (it.get("tel") or "").strip(),
        "mapx": it.get("mapx"),
        "mapy": it.get("mapy"),
        "image": it.get("firstimage"),
    } for it in items]

    if keyword:
        out = [f for f in out if keyword in f["title"]]
    return out


def festival_detail(content_id: str) -> dict:
    """축제 1건의 공통 상세 (주최·홈페이지·개요)."""
    items = _call("detailCommon2", contentId=content_id)
    if not items:
        raise TourAPIError(f"contentId {content_id} 조회 결과 없음")
    it = items[0]
    return {
        "content_id": content_id,
        "title": (it.get("title") or "").strip(),
        "addr": (it.get("addr1") or "").strip(),
        "homepage": (it.get("homepage") or "").strip(),
        "overview": (it.get("overview") or "").strip(),
        "tel": (it.get("tel") or "").strip(),
    }


# ── DB 캐시 ────────────────────────────────────────────────────────
# 호출 결과를 저장해 두면 시연 중 네트워크가 끊겨도 화면이 유지된다.

CACHE_SCHEMA = """
CREATE TABLE IF NOT EXISTS festival_info (
  content_id TEXT PRIMARY KEY,
  title TEXT, addr TEXT, start_date TEXT, end_date TEXT,
  tel TEXT, homepage TEXT, overview TEXT,
  mapx TEXT, mapy TEXT, fetched_at TEXT
);
"""


def ensure_cache() -> None:
    with db.connect() as conn:
        conn.executescript(CACHE_SCHEMA)
        conn.commit()


def save_festival(info: dict) -> None:
    ensure_cache()
    with db.connect() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO festival_info
               (content_id, title, addr, start_date, end_date, tel,
                homepage, overview, mapx, mapy, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (info.get("content_id"), info.get("title"), info.get("addr"),
             info.get("start_date"), info.get("end_date"), info.get("tel"),
             info.get("homepage"), info.get("overview"),
             info.get("mapx"), info.get("mapy"), db.now()),
        )
        conn.commit()


def cached_festival(keyword: str | None = None) -> dict | None:
    ensure_cache()
    sql = "SELECT * FROM festival_info"
    params: tuple = ()
    if keyword:
        sql += " WHERE title LIKE ?"
        params = (f"%{keyword}%",)
    sql += " ORDER BY fetched_at DESC LIMIT 1"
    with db.connect() as conn:
        row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def lookup(keyword: str) -> dict | None:
    """캐시 우선 조회 → 없으면 API → 실패하면 None (Fallback).

    ③조치 에이전트가 조치요청서에 축제 공식 정보(기간·주최·연락처)를
    넣을 때 호출한다.
    """
    hit = cached_festival(keyword)
    if hit:
        return hit
    if not available():
        return None
    try:
        found = search_festivals(keyword=keyword)
        if not found:
            return None
        info = found[0]
        try:
            info.update(festival_detail(info["content_id"]))
        except TourAPIError:
            pass                      # 상세 실패해도 목록 정보는 쓴다
        save_festival(info)
        db.log_agent("tourapi", "lookup", keyword, info["title"],
                     "관광공사 API 호출 성공")
        return info
    except TourAPIError as exc:
        db.log_agent("tourapi", "lookup_failed", keyword, str(exc)[:150],
                     "API 실패 → 수기 시드로 대체")
        return None
