// 출처 식별(D5-40 · D5-33 ②) — 접속 주소(IP)를 '하루마다 바뀌는 비밀값'으로 해시한 짧은 문자열. (core/source_id.py 와 1:1)
//
// 접수·개발자 보기 호출 빈도를 출처별로 세는 데 쓴다. 원문 IP 는 저장하지 않는다.
//   · 비밀값은 프로세스 메모리에만 있고 날짜가 바뀌거나 재시작하면 새로 만든다 → 해시는 하루 안에서만 같은 출처를 가리킨다.
//   · 해시는 16자 (HMAC-SHA256 앞부분). 민원 행과는 연결하지 않는다.
//   · IP 를 알 수 없으면 '' (출처 구분 없음 = 전체 공용) 이다.
//
// 프록시: webapi 앞에 vite 프록시(같은 PC, xfwd)가 있으면 webapi 가 보는 접속 주소는 127.0.0.1 이다.
// 그래서 접속자가 **믿는 프록시(루프백 127.0.0.1·::1)일 때만** X-Forwarded-For 를 본다. 밖에서 온 요청이 이 헤더를
// 직접 붙여도 루프백이 아니면 무시하고 소켓 주소를 그대로 쓴다.
// 그때도 **맨 오른쪽(마지막으로 붙은) 값**만 쓴다 (D5-43). 왼쪽 값은 접속한 쪽이 직접 넣어 보낸 것일 수 있다.
import { createHmac, randomBytes } from "node:crypto";

export const _keys = new Map<string, Buffer>();
export const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function _day_key(): Buffer {
  const t = today();
  if (!_keys.has(t)) {
    _keys.clear();                      // 어제 비밀값은 버린다
    _keys.set(t, randomBytes(32));
  }
  return _keys.get(t)!;
}

/** IP → 출처 해시. IP 가 없으면 ''. */
export function source_hash(ip: string | null | undefined): string {
  if (!ip) return "";
  return createHmac("sha256", _day_key()).update(ip.trim(), "utf8").digest("hex").slice(0, 16);
}

/** 접속 주소. 접속자가 루프백(같은 PC 의 믿는 프록시)일 때만 X-Forwarded-For 의 **맨 오른쪽 값**을 쓴다. */
export function client_ip(peer: string | null | undefined, forwarded_for: string | null | undefined = null): string | null {
  if (peer && LOOPBACK.has(peer) && forwarded_for) {
    const parts = forwarded_for.split(",");
    const last = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return peer ?? null;
}

export function client_source(peer: string | null | undefined, forwarded_for: string | null | undefined = null): string {
  return source_hash(client_ip(peer, forwarded_for));
}
