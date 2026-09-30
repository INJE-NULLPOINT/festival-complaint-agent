// 한국관광공사 TourAPI 4.0 연동 (외부 API — 심사 'Tool 4점' 근거). (core/tourapi.py 와 1:1)
//
// 서비스: 한국관광공사_국문 관광정보 서비스_GW  (공공데이터포털 데이터 15101578)
// 엔드포인트: http://apis.data.go.kr/B551011/KorService2   사용 오퍼레이션: searchFestival2 (축제정보), detailCommon2 (공통 상세)
// 키: .env 에 TOURAPI_KEY=... (일반 인증키 Decoding)
//
// ★ 설계 원칙: 이 API가 실패해도 시스템은 계속 돈다. 키가 없거나 호출이 실패하면 config.ZONES 수기 시드가 그대로 쓰인다.
import * as db from "./db.ts";

export type Row = Record<string, any>;

export const BASE = "http://apis.data.go.kr/B551011/KorService2";
export const AREA_GYEONGNAM = "36";          // 경상남도
export const MOBILE_APP = "GnFestivalAgent";
export const TIMEOUT = 10;

export class TourAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TourAPIError";
  }
}

export function api_key(): string | null {
  return process.env.TOURAPI_KEY || null;
}

export function available(): boolean {
  return api_key() !== null;
}

/** TourAPI 호출 → items 리스트. 실패하면 TourAPIError. */
export async function _call(operation: string, params: Record<string, string | number> = {}): Promise<Row[]> {
  const key = api_key();
  if (!key) throw new TourAPIError("TOURAPI_KEY 미설정");

  const query = new URLSearchParams(Object.entries({
    serviceKey: key, MobileOS: "ETC", MobileApp: MOBILE_APP, _type: "json", numOfRows: 50, pageNo: 1, ...params,
  }).map(([k, v]): [string, string] => [k, String(v)]));
  const url = `${BASE}/${operation}?${query.toString()}`;

  let raw: string;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT * 1000) });
    raw = await resp.text();
  } catch (exc) {
    throw new TourAPIError(`네트워크 오류: ${(exc as Error).message}`);
  }

  // 키가 틀리면 JSON 대신 XML 오류문서가 온다
  if (raw.trimStart().startsWith("<")) {
    const snippet = raw.trim().slice(0, 200).replace(/\n/g, " ");
    throw new TourAPIError(`XML 오류 응답 (키 확인 필요): ${snippet}`);
  }

  let body: Row;
  try {
    body = JSON.parse(raw).response.body;
    if (body === undefined) throw new Error("no body");
  } catch {
    throw new TourAPIError(`응답 파싱 실패: ${raw.slice(0, 200)}`);
  }

  const items = (body.items || {}).item || [];
  return Array.isArray(items) ? items : [items];
}

const yyyymmdd = (d: Date): string => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/** 경남 축제 목록. event_start 는 YYYYMMDD (해당일 이후 시작·진행 중인 축제). */
export async function search_festivals(area_code = AREA_GYEONGNAM, event_start: string | null = null,
                                       keyword: string | null = null): Promise<Row[]> {
  const items = await _call("searchFestival2", {
    areaCode: area_code, eventStartDate: event_start || yyyymmdd(new Date()), arrange: "A",
  });
  let out = items.map((it) => ({
    content_id: it.contentid,
    title: (it.title || "").trim(),
    addr: (it.addr1 || "").trim(),
    start_date: it.eventstartdate,
    end_date: it.eventenddate,
    tel: (it.tel || "").trim(),
    mapx: it.mapx,
    mapy: it.mapy,
    image: it.firstimage,
  }));
  if (keyword) out = out.filter((f) => f.title.includes(keyword));
  return out;
}

/** 축제 1건의 공통 상세 (주최·홈페이지·개요). */
export async function festival_detail(content_id: string): Promise<Row> {
  const items = await _call("detailCommon2", { contentId: content_id });
  if (!items.length) throw new TourAPIError(`contentId ${content_id} 조회 결과 없음`);
  const it = items[0];
  return {
    content_id,
    title: (it.title || "").trim(),
    addr: (it.addr1 || "").trim(),
    homepage: (it.homepage || "").trim(),
    overview: (it.overview || "").trim(),
    tel: (it.tel || "").trim(),
  };
}

// ── DB 캐시 ── 호출 결과를 저장해 두면 시연 중 네트워크가 끊겨도 화면이 유지된다.
export const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS festival_info (
  content_id TEXT PRIMARY KEY,
  title TEXT, addr TEXT, start_date TEXT, end_date TEXT,
  tel TEXT, homepage TEXT, overview TEXT,
  mapx TEXT, mapy TEXT, fetched_at TEXT
);
`;

export async function ensure_cache(): Promise<void> {
  const conn = await db.connect();
  await conn.executescript(CACHE_SCHEMA);
  await conn.commit();
}

export async function save_festival(info: Row): Promise<void> {
  await ensure_cache();
  const conn = await db.connect();
  await conn.execute(
    `INSERT OR REPLACE INTO festival_info
     (content_id, title, addr, start_date, end_date, tel, homepage, overview, mapx, mapy, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [info.content_id, info.title, info.addr, info.start_date, info.end_date, info.tel,
      info.homepage, info.overview, info.mapx, info.mapy, db.now()]);
  await conn.commit();
}

export async function cached_festival(keyword: string | null = null): Promise<Row | null> {
  await ensure_cache();
  let sql = "SELECT * FROM festival_info";
  let params: unknown[] = [];
  if (keyword) {
    sql += " WHERE title LIKE ?";
    params = [`%${keyword}%`];
  }
  sql += " ORDER BY fetched_at DESC LIMIT 1";
  const conn = await db.connect();
  const row = (await conn.execute(sql, params)).fetchone();
  return row ? { ...row } : null;
}

/** 캐시 우선 조회 → 없으면 API → 실패하면 null (Fallback). ③조치 에이전트가 조치요청서에 축제 공식 정보를 넣을 때 호출한다. */
export async function lookup(keyword: string): Promise<Row | null> {
  const hit = await cached_festival(keyword);
  if (hit) return hit;
  if (!available()) return null;
  try {
    const found = await search_festivals(AREA_GYEONGNAM, null, keyword);
    if (!found.length) return null;
    const info = found[0];
    try {
      Object.assign(info, await festival_detail(info.content_id));
    } catch (e) {
      if (!(e instanceof TourAPIError)) throw e;      // 상세 실패해도 목록 정보는 쓴다
    }
    await save_festival(info);
    await db.log_agent("tourapi", "lookup", keyword, info.title, "관광공사 API 호출 성공");
    return info;
  } catch (exc) {
    if (!(exc instanceof TourAPIError)) throw exc;
    await db.log_agent("tourapi", "lookup_failed", keyword, String(exc.message).slice(0, 150), "API 실패 → 수기 시드로 대체");
    return null;
  }
}
