"""출처 식별(D5-40 · D5-33 ②) — 접속 주소(IP)를 '하루마다 바뀌는 비밀값'으로 해시한 짧은 문자열.

운영자 코드 실패 횟수를 출처별로 세는 데 쓴다. 원문 IP 는 저장하지 않는다.
  · 비밀값은 프로세스 메모리에만 있고 날짜가 바뀌거나 재시작하면 새로 만든다 → 해시는 하루 안에서만 같은 출처를 가리킨다.
  · 해시는 16자 (HMAC-SHA256 앞부분). 민원 행과는 연결하지 않는다.
  · IP 를 알 수 없으면 '' (출처 구분 없음 = 예전처럼 전체 공용) 이다.

프록시: webapi 앞에 vite 프록시(같은 PC)가 있으면 webapi 가 보는 접속 주소는 127.0.0.1 이다.
그래서 접속자가 루프백(127.0.0.1·::1)일 때만 X-Forwarded-For 의 첫 값을 믿는다. 밖에서 온 요청이 이 헤더를
직접 붙여도 루프백이 아니면 무시한다.
"""
import hashlib
import hmac
import os
import threading
from datetime import date

_lock = threading.Lock()
_keys: dict[str, bytes] = {}
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"}


def _day_key() -> bytes:
    today = date.today().isoformat()
    with _lock:
        if today not in _keys:
            _keys.clear()                      # 어제 비밀값은 버린다
            _keys[today] = os.urandom(32)
        return _keys[today]


def source_hash(ip: str | None) -> str:
    """IP → 출처 해시. IP 가 없으면 ''."""
    if not ip:
        return ""
    return hmac.new(_day_key(), ip.strip().encode("utf-8"), hashlib.sha256).hexdigest()[:16]


def client_ip(peer: str | None, forwarded_for: str | None = None) -> str | None:
    """접속 주소. 접속자가 루프백(같은 PC 의 프록시)일 때만 X-Forwarded-For 의 첫 값을 쓴다."""
    if peer and peer in LOOPBACK and forwarded_for:
        first = forwarded_for.split(",")[0].strip()
        if first:
            return first
    return peer


def client_source(peer: str | None, forwarded_for: str | None = None) -> str:
    return source_hash(client_ip(peer, forwarded_for))
