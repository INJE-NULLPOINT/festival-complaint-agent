"""DB 접근 계층. SQLite(로컬) 또는 Supabase Postgres.

설계 원칙: 화면은 상태를 들고 있지 않는다. 모든 상태는 여기에만 있다.
Streamlit이 5초마다 다시 그려도, 웹 화면이 실시간 구독으로 다시 그려도
깨지지 않는 이유가 이것이다.

백엔드 선택: SUPABASE_DB_URL 이 있으면 Postgres, 없으면 SQLite.
SQL 은 SQLite 문법으로 한 벌만 쓰고, Postgres 에서는 _translate() 가
바꿔 준다. 에이전트·화면 코드를 두 벌로 만들지 않기 위해서다.
Postgres 스키마는 supabase/schema.sql 이 관리한다.
"""
import json
import re
import sqlite3
import threading
from datetime import datetime, timedelta

from . import config

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS festival (
  id INTEGER PRIMARY KEY, name TEXT, region TEXT,
  start_date TEXT, end_date TEXT
);

CREATE TABLE IF NOT EXISTS zone (
  id INTEGER PRIMARY KEY, festival_id INTEGER, name TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY,
  festival_id INTEGER,
  zone_id     INTEGER,       -- NULL = 구역 미상 (config.ZONE_UNKNOWN)
  source      TEXT,          -- qr | replay | staff
  raw_text    TEXT,
  posted_at   TEXT,          -- 리플레이는 원본 시각
  ingested_at TEXT,          -- 실제 수신 시각 (실시간 증명)
  hash        TEXT UNIQUE,
  deleted_at  TEXT           -- NULL = 살아 있음, 값 = 운영자가 지움(숨김·되돌리기 가능)
);

CREATE TABLE IF NOT EXISTS classification (
  feedback_id  INTEGER PRIMARY KEY REFERENCES feedback(id),
  label        TEXT,
  sentiment    REAL,
  is_safety    INTEGER,
  confidence   REAL,
  status       TEXT DEFAULT 'pending',   -- pending | done | review(운영자 확인, 유형 없음) | dismissed(유형 없음으로 닫음) | failed
  processed_at TEXT,
  agent_note   TEXT,
  suggested_label TEXT,                  -- review 일 때 모델이 제안한 유형 (문자열 파싱 대신 열로 저장)
  reviewed_at  TEXT,                     -- 운영자가 처리한 시각
  review_action TEXT,                    -- label(유형 지정) | dismissed(유형 없음으로 닫음)
  decided_by   TEXT                      -- 'operator' = 운영자가 처리 (measure_accuracy 가 모델 정답으로 치지 않음)
);

CREATE TABLE IF NOT EXISTS severity (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  label TEXT, "window" TEXT, as_of TEXT,
  freq INTEGER, avg_sentiment REAL,
  base_score REAL, safety_w REAL, spike_w REAL, pending_w REAL,
  score REAL, grade TEXT, formula TEXT
);

CREATE TABLE IF NOT EXISTS alert (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  label TEXT, kind TEXT,      -- spike | safety_threshold | grade_up
  detail TEXT, created_at TEXT, acked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS department_map (
  label TEXT PRIMARY KEY, department TEXT, contact TEXT
);

CREATE TABLE IF NOT EXISTS action_request (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  label TEXT, department TEXT, count INTEGER,
  doc_path TEXT, status TEXT DEFAULT 'requested',
  created_at TEXT, closed_at TEXT,
  doc_url TEXT, doc_json TEXT
);

-- 웹 접수폼이 넣는 곳. 워커가 마스킹 후 feedback 으로 옮긴다.
CREATE TABLE IF NOT EXISTS feedback_inbox (
  id INTEGER PRIMARY KEY, zone_id INTEGER, text TEXT, created_at TEXT,
  feedback_id INTEGER
);

-- 웹의 '조치요청서 생성' 버튼이 넣는 곳. 워커가 처리한다.
CREATE TABLE IF NOT EXISTS doc_job (
  id INTEGER PRIMARY KEY, label TEXT,
  status TEXT DEFAULT 'queued',            -- queued | running | done | failed
  action_request_id INTEGER, error TEXT,
  created_at TEXT, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_task (
  id INTEGER PRIMARY KEY, agent TEXT, payload TEXT,
  state TEXT DEFAULT 'queued',
  created_at TEXT, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_log (
  id INTEGER PRIMARY KEY,
  agent TEXT, action TEXT,
  input_summary TEXT, output_summary TEXT, reasoning TEXT,
  latency_ms INTEGER, created_at TEXT,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS briefing (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  top_label TEXT, text TEXT, rationale TEXT, created_at TEXT,
  top_issue_key TEXT, issue_sig TEXT
);

-- 관제 '지금 조치할 일' 카드 한 장 = 한 행 (유형×구역). 계산 열은 core/issues.refresh() 가,
-- 문장 열(title·actions·evidence_quotes)은 ④통합 에이전트가 쓴다. JSON 열은 문자열이다.
CREATE TABLE IF NOT EXISTS issue (
  id INTEGER PRIMARY KEY, festival_id INTEGER,
  issue_key TEXT UNIQUE, active INTEGER DEFAULT 1, updated_at TEXT,
  label TEXT, zone_id INTEGER, zone_name TEXT,           -- zone_id NULL = 구역 미상
  rank_no INTEGER, grp TEXT,                              -- main | more | in_progress | done
  grade TEXT, is_safety INTEGER DEFAULT 0, type_score REAL, conc REAL, rec REAL,
  card_score REAL, formula TEXT, freq INTEGER, type_freq INTEGER, last_at TEXT,
  same_zone_others INTEGER DEFAULT 0, recurred INTEGER DEFAULT 0, new_since_request INTEGER DEFAULT 0,
  action_status TEXT, action_request_id INTEGER, department TEXT, contact TEXT,
  signature TEXT, latest_quotes TEXT,                     -- 최신 민원 (매 주기 갱신)
  title TEXT, actions TEXT, evidence_quotes TEXT,         -- 문구와 그 근거 (문구를 다시 쓸 때만 바뀜)
  needs_judgment INTEGER DEFAULT 0,                       -- 고위험 표현 포함 → 운영자 판단 필요
  text_source TEXT DEFAULT 'template',                    -- llm | local | template
  text_updated_at TEXT, gen_signature TEXT, gen_max_id INTEGER DEFAULT 0,
  gen_at TEXT, fail_count INTEGER DEFAULT 0
);

-- 운영자 코드를 틀린 시도 기록 (core/admin.py). 10분에 5번 넘게 틀리면 그 창 동안 거부한다.
CREATE TABLE IF NOT EXISTS admin_attempt (
  id INTEGER PRIMARY KEY, at TEXT
);

CREATE TABLE IF NOT EXISTS classify_cache (
  hash TEXT PRIMARY KEY, result TEXT
);

CREATE INDEX IF NOT EXISTS idx_cls_status ON classification(status);
CREATE INDEX IF NOT EXISTS idx_fb_ingested ON feedback(ingested_at);
"""


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# 운영자가 지운(숨긴) 민원을 모든 집계에서 빼는 공통 조건. feedback 을 f 로 조인한 쿼리에 붙인다.
# 건수·심각도·알림·브리핑·조치요청서 인용·카드(issues)·분류 대기열·유입이 모두 이것을 쓴다.
LIVE_FEEDBACK_SQL = "f.deleted_at IS NULL"


def set_feedback_deleted(feedback_id: int, deleted: bool, ts: str | None = None) -> None:
    """민원 1건을 숨기거나(deleted=True) 되돌린다. 없는 id 는 KeyError.

    이미 지운 것을 다시 지우거나 살아 있는 것을 되돌리는 것은 오류가 아니다 (멱등).
    """
    with connect() as conn:
        if not conn.execute("SELECT id FROM feedback WHERE id=?", (feedback_id,)).fetchone():
            raise KeyError(f"없는 민원입니다: {feedback_id}")
        conn.execute("UPDATE feedback SET deleted_at=? WHERE id=?",
                     ((ts or now()) if deleted else None, feedback_id))
        conn.commit()


def deleted_count() -> int:
    with connect() as conn:
        return conn.execute(
            "SELECT COUNT(*) c FROM feedback WHERE deleted_at IS NOT NULL").fetchone()["c"]


def is_pg() -> bool:
    return bool(config.SUPABASE_DB_URL)


# ── Postgres 어댑터 ───────────────────────────────────────────────
# id 자동 증가 컬럼이 있는 테이블. INSERT 에 RETURNING id 를 붙여 lastrowid 를 흉내 낸다.
_ID_TABLES = {"festival", "zone", "feedback", "severity", "alert", "action_request",
              "agent_task", "agent_log", "briefing", "feedback_inbox", "doc_job",
              "replay_state", "issue", "admin_attempt"}
# INSERT OR REPLACE 의 충돌 기준 컬럼
_UPSERT_KEY = {"department_map": "label", "classify_cache": "hash",
               "festival_info": "content_id"}
_INSERT_RE = re.compile(
    r"^\s*INSERT\s+(OR\s+(IGNORE|REPLACE)\s+)?INTO\s+(\w+)\s*\(([^)]*)\)", re.I | re.S)


def _translate(sql: str, has_params: bool) -> tuple[str, bool]:
    """SQLite 문법 → Postgres. (변환된 SQL, RETURNING id 를 붙였는지)"""
    returning = False
    m = _INSERT_RE.match(sql)
    if m:
        mode = (m.group(2) or "").upper()
        table = m.group(3).lower()
        cols = [c.strip() for c in m.group(4).split(",")]
        sql = _INSERT_RE.sub(lambda mm: f"INSERT INTO {mm.group(3)} ({mm.group(4)})", sql, 1)
        sql = sql.rstrip().rstrip(";")
        if mode == "IGNORE":
            sql += " ON CONFLICT DO NOTHING"
        elif mode == "REPLACE":
            key = _UPSERT_KEY[table]
            sets = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c != key)
            sql += f" ON CONFLICT ({key}) DO UPDATE SET {sets}"
        if table in _ID_TABLES and "RETURNING" not in sql.upper():
            sql += " RETURNING id"
            returning = True
    sql = re.sub(r"\browid\b", "ctid", sql)
    if has_params:
        sql = sql.replace("%", "%%").replace("?", "%s")
    return sql, returning


class _PgCursor:
    def __init__(self, cur, lastrowid=None):
        self._cur, self.lastrowid = cur, lastrowid

    def fetchone(self):
        return self._cur.fetchone() if self._cur.description else None

    def fetchall(self):
        return self._cur.fetchall() if self._cur.description else []

    def __iter__(self):
        return iter(self.fetchall())

    @property
    def rowcount(self):
        return self._cur.rowcount


class _PgConn:
    """sqlite3.Connection 처럼 쓰이는 얇은 래퍼.

    연결은 스레드마다 하나를 재사용한다(원격 DB 라 매번 새로 열면 느리다).
    with 블록이 끝나면 커밋만 하고 닫지 않는다.
    """

    def __init__(self, raw):
        self.raw = raw
        self._depth = 0

    def execute(self, sql: str, params=()):
        has = bool(params)
        q, returning = _translate(sql, has)
        cur = self.raw.cursor()
        cur.execute(q, tuple(params) if has else None)
        if returning:
            row = cur.fetchone()
            return _PgCursor(cur, lastrowid=row["id"] if row else None)
        return _PgCursor(cur)

    def executescript(self, _script: str) -> None:
        """Postgres 스키마는 supabase/schema.sql 로 관리한다."""

    def commit(self):
        self.raw.commit()

    def rollback(self):
        self.raw.rollback()

    def __enter__(self):
        self._depth += 1
        return self

    def __exit__(self, exc_type, *_):
        self._depth -= 1
        if exc_type:
            self.raw.rollback()
        elif self._depth == 0:
            self.raw.commit()
        return False


_local = threading.local()


def _pg_connect() -> _PgConn:
    conn = getattr(_local, "pg", None)
    if conn is None or conn.raw.closed or conn.raw.broken:
        import psycopg
        from psycopg.rows import dict_row
        # prepare_threshold=None: Supabase 트랜잭션 풀러(6543)에서도 동작하도록
        raw = psycopg.connect(config.SUPABASE_DB_URL, row_factory=dict_row,
                              prepare_threshold=None, connect_timeout=10)
        conn = _PgConn(raw)
        _local.pg = conn
    return conn


def _unique_errors() -> tuple:
    errs: tuple = (sqlite3.IntegrityError,)
    if is_pg():
        import psycopg
        errs += (psycopg.errors.UniqueViolation,)
    return errs


def connect():
    if is_pg():
        return _pg_connect()
    conn = sqlite3.connect(config.DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _migrate_sqlite(conn) -> None:
    """예전 festival.db 에 새 컬럼을 붙인다."""
    have = {r["name"] for r in conn.execute("PRAGMA table_info(action_request)")}
    for col in ("doc_url", "doc_json"):
        if col not in have:
            conn.execute(f"ALTER TABLE action_request ADD COLUMN {col} TEXT")
    have = {r["name"] for r in conn.execute("PRAGMA table_info(classification)")}
    for col in ("suggested_label", "reviewed_at", "review_action", "decided_by"):
        if col not in have:
            conn.execute(f"ALTER TABLE classification ADD COLUMN {col} TEXT")
    if "suggested_label" not in have:
        # 열이 생기기 전에 review 로 들어간 건은 agent_note 의 '모델 제안: 유형' 에서 한 번만 옮겨 채운다 (1회성 이전)
        import re
        for r in conn.execute("SELECT feedback_id, agent_note FROM classification "
                              "WHERE status='review' AND agent_note LIKE '%모델 제안:%'").fetchall():
            m = re.search(r"모델 제안:\s*(\w+)", r["agent_note"] or "")
            if m and m.group(1) in config.LABELS:
                conn.execute("UPDATE classification SET suggested_label=? WHERE feedback_id=?",
                             (m.group(1), r["feedback_id"]))
    have = {r["name"] for r in conn.execute("PRAGMA table_info(feedback)")}
    if "deleted_at" not in have:
        conn.execute("ALTER TABLE feedback ADD COLUMN deleted_at TEXT")
    have = {r["name"] for r in conn.execute("PRAGMA table_info(issue)")}
    if have and "new_since_request" not in have:
        conn.execute("ALTER TABLE issue ADD COLUMN new_since_request INTEGER DEFAULT 0")
    have = {r["name"] for r in conn.execute("PRAGMA table_info(briefing)")}
    for col in ("top_issue_key", "issue_sig"):
        if col not in have:
            conn.execute(f"ALTER TABLE briefing ADD COLUMN {col} TEXT")
    have = {r["name"] for r in conn.execute("PRAGMA table_info(agent_log)")}
    for col in ("input_tokens", "output_tokens", "cache_read_tokens"):
        if col not in have:
            conn.execute(f"ALTER TABLE agent_log ADD COLUMN {col} INTEGER DEFAULT 0")


def init_db() -> None:
    """스키마 생성 + 시드 투입. 몇 번 실행해도 안전하다."""
    with connect() as conn:
        conn.executescript(SCHEMA)
        if not is_pg():
            _migrate_sqlite(conn)

        row = conn.execute("SELECT id FROM festival LIMIT 1").fetchone()
        if row is None:
            cur = conn.execute(
                "INSERT INTO festival (name, region, start_date, end_date) VALUES (?,?,?,?)",
                (config.FESTIVAL["name"], config.FESTIVAL["region"],
                 config.FESTIVAL["start_date"], config.FESTIVAL["end_date"]),
            )
            fid = cur.lastrowid
        else:
            fid = row["id"]

        for z in config.ZONES:
            conn.execute(
                "INSERT OR IGNORE INTO zone (festival_id, name) VALUES (?,?)", (fid, z)
            )
        for label, (dept, contact) in config.DEPARTMENT_MAP.items():
            conn.execute(
                "INSERT OR REPLACE INTO department_map (label, department, contact) VALUES (?,?,?)",
                (label, dept, contact),
            )
        conn.commit()


def festival_id() -> int:
    with connect() as conn:
        return conn.execute("SELECT id FROM festival LIMIT 1").fetchone()["id"]


def zones() -> list:
    with connect() as conn:
        return conn.execute("SELECT id, name FROM zone ORDER BY id").fetchall()


# ── 쓰기 ──────────────────────────────────────────────────────────

def insert_feedback(zone_id: int | None, raw_text: str, source: str = "qr",
                    posted_at: str | None = None) -> int | None:
    """민원 1건 저장 + 분류 대기열 등록. 중복이거나 내용이 없으면 None.

    ★ 저장 전에 개인정보를 마스킹한다. 분류 저장소(feedback)에는 마스킹본만 들어간다.
    내용이 없는 입력('...', 'ㅋㅋ')은 저장하지 않는다 (privacy.has_content).
    zone_id=None 은 '구역 미상'이다 — 모르는 구역을 첫 구역으로 대신 넣지 않는다.
    """
    import hashlib

    from . import privacy

    if not privacy.has_content(raw_text):
        return None
    raw_text = privacy.mask(raw_text)

    ts = now()
    digest = hashlib.sha256(f"{zone_id}|{raw_text.strip()}|{posted_at or ts}".encode()).hexdigest()
    with connect() as conn:
        try:
            cur = conn.execute(
                """INSERT INTO feedback
                   (festival_id, zone_id, source, raw_text, posted_at, ingested_at, hash)
                   VALUES (?,?,?,?,?,?,?)""",
                (festival_id(), zone_id, source, raw_text.strip(), posted_at or ts, ts, digest),
            )
        except _unique_errors():
            conn.rollback()
            return None
        fid = cur.lastrowid
        conn.execute(
            "INSERT INTO classification (feedback_id, status) VALUES (?, 'pending')", (fid,)
        )
        conn.commit()
        return fid


def log_agent(agent: str, action: str, input_summary: str = "",
              output_summary: str = "", reasoning: str = "", latency_ms: int = 0,
              input_tokens: int = 0, output_tokens: int = 0,
              cache_read_tokens: int = 0) -> None:
    with connect() as conn:
        conn.execute(
            """INSERT INTO agent_log
               (agent, action, input_summary, output_summary, reasoning, latency_ms, created_at,
                input_tokens, output_tokens, cache_read_tokens)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (agent, action, input_summary[:200], output_summary[:200],
             reasoning[:300], latency_ms, now(),
             input_tokens, output_tokens, cache_read_tokens),
        )
        conn.commit()


def raise_alert(label: str, kind: str, detail: str) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO alert (festival_id, label, kind, detail, created_at) VALUES (?,?,?,?,?)",
            (festival_id(), label, kind, detail, now()),
        )
        conn.commit()
        return cur.lastrowid


def save_severity(rows: list[dict], window: str) -> None:
    ts = now()
    with connect() as conn:
        for r in rows:
            conn.execute(
                """INSERT INTO severity
                   (festival_id, label, "window", as_of, freq, avg_sentiment,
                    base_score, safety_w, spike_w, pending_w, score, grade, formula)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (festival_id(), r["label"], window, ts, r["freq"], r["avg_sentiment"],
                 r["base_score"], r["safety_w"], r["spike_w"], r["pending_w"],
                 r["score"], r["grade"], r["formula"]),
            )
        conn.commit()


def severity_recorded(rows: list[dict], window: str) -> bool:
    """이 창의 가장 최근 스냅샷이 rows 와 같은 판정이면 True.

    스냅샷의 주인은 워커 Fast Path 다(분류 직후 저장, 웹 관제가 구독).
    ②감시의 save_snapshot 은 이 값으로 이미 기록된 판정을 다시 쓰지 않는다.
    같은 주기에 둘이 같은 초에 저장해 as_of·label 행이 2개씩 생기던 문제.
    """
    def key(r):
        return (r["label"], r["freq"], round(r["score"], 1), r["grade"])

    with connect() as conn:
        last = conn.execute(
            """SELECT label, freq, score, grade FROM severity
               WHERE "window"=? AND as_of=(SELECT MAX(as_of) FROM severity WHERE "window"=?)""",
            (window, window),
        ).fetchall()
    return bool(last) and {key(r) for r in last} == {key(r) for r in rows}


# ── 읽기 ──────────────────────────────────────────────────────────

def review_count() -> int:
    """운영자 확인이 필요한 민원 수 (분류 신뢰도가 낮거나 내용이 없어 유형을 넣지 않은 것).

    review 는 심각도·알림·브리핑·조치요청서 인용에서 빠진다 (그 집계는 status='done' 만 본다).
    """
    with connect() as conn:
        return conn.execute(
            f"""SELECT COUNT(*) c FROM classification c JOIN feedback f ON f.id = c.feedback_id
                WHERE c.status='review' AND {LIVE_FEEDBACK_SQL}"""
        ).fetchone()["c"]


def review_safety_count() -> int:
    """확인 필요 중 안전 의심(is_safety) 건수. 신뢰도가 낮아 순위·알림에서 빠졌지만
    사람이 먼저 봐야 할 수 있는 건이다."""
    with connect() as conn:
        return conn.execute(
            f"""SELECT COUNT(*) c FROM classification c JOIN feedback f ON f.id = c.feedback_id
                WHERE c.status='review' AND c.is_safety=1 AND {LIVE_FEEDBACK_SQL}"""
        ).fetchone()["c"]


def pending_count() -> int:
    with connect() as conn:
        return conn.execute(
            f"""SELECT COUNT(*) c FROM classification c JOIN feedback f ON f.id = c.feedback_id
                WHERE c.status='pending' AND {LIVE_FEEDBACK_SQL}"""
        ).fetchone()["c"]


def data_now() -> datetime:
    """데이터 기준의 '현재'.

    실시간 접수에서는 실제 현재 시각과 같다. 리플레이 중에는 재생된 민원의
    가장 최근 발생 시각이 기준이 된다. 적재 시각(ingested_at)으로 창을 잡으면
    120건을 한 번에 넣었을 때 전부 '급증'으로 잡히는 문제가 생긴다.
    """
    with connect() as conn:
        row = conn.execute(
            """SELECT MAX(f.posted_at) t FROM feedback f
               JOIN classification c ON c.feedback_id = f.id
               WHERE c.status='done' AND f.deleted_at IS NULL"""
        ).fetchone()
    if row and row["t"]:
        try:
            return datetime.fromisoformat(row["t"])
        except ValueError:
            pass
    return datetime.now()


def window_rows(window_min: int) -> list:
    """지정 구간 내 분류 완료 민원. 심각도 계산의 입력. (review 는 제외)

    창은 posted_at(민원 발생 시각) 기준이다. 실시간에서는 적재 시각과 같고,
    리플레이에서는 시뮬레이션 시간선을 따른다.
    """
    since = (data_now() - timedelta(minutes=window_min)).isoformat(timespec="seconds")
    with connect() as conn:
        return conn.execute(
            """SELECT c.label, c.sentiment, c.is_safety,
                      f.id feedback_id, f.zone_id, f.raw_text,
                      f.posted_at, f.ingested_at
               FROM classification c JOIN feedback f ON f.id = c.feedback_id
               WHERE c.status='done' AND f.posted_at >= ? AND f.deleted_at IS NULL""",
            (since,),
        ).fetchall()


SYNTHETIC_SOURCES = ("replay", "demo", "dev")      # 사람이 접수하지 않은 합성·재생 민원의 source 값


def synthetic_in_window(window_min: int | None = None) -> dict:
    """집계 창 안에 합성·재생 민원이 있는지 — 관제 머리의 '합성 데이터' 표시용.

    창은 window_rows 와 같다 (data_now 기준 posted_at). 분류 상태와 무관하게 지운 것만 뺀다.
    """
    win = window_min or config.DEFAULT_WINDOW_MIN
    since = (data_now() - timedelta(minutes=win)).isoformat(timespec="seconds")
    marks = ",".join("?" for _ in SYNTHETIC_SOURCES)
    with connect() as conn:
        n = conn.execute(
            f"SELECT COUNT(*) AS n FROM feedback f WHERE f.deleted_at IS NULL AND f.posted_at >= ? "
            f"AND f.source IN ({marks})", (since, *SYNTHETIC_SOURCES),
        ).fetchone()["n"]
    return {"on": n > 0, "count": n}


def ranked(window_min: int | None = None) -> list[dict]:
    """심각도 순위. 창 조회 + 미조치 판정 + 기준시각을 한 번에 묶는다.

    같은 3줄이 화면·에이전트 여러 곳에 흩어져 있어 하나로 모았다.
    기준 시각은 data_now() — 민원 발생 시간선을 따른다.
    """
    from . import severity
    win = window_min or config.DEFAULT_WINDOW_MIN
    return severity.rank_labels(
        window_rows(win),
        unhandled_fn=lambda l: unhandled_over(l, config.PENDING_MINUTES),
        ref=data_now(),
    )


def label_counts(window_min: int | None = None) -> dict[str, int]:
    sql = """SELECT c.label, COUNT(*) c FROM classification c
             JOIN feedback f ON f.id = c.feedback_id
             WHERE c.status='done' AND f.deleted_at IS NULL"""
    params: tuple = ()
    if window_min:
        since = (data_now() - timedelta(minutes=window_min)).isoformat(timespec="seconds")
        sql += " AND f.posted_at >= ?"
        params = (since,)
    sql += " GROUP BY c.label ORDER BY c DESC"
    with connect() as conn:
        return {r["label"]: r["c"] for r in conn.execute(sql, params).fetchall()}


def recent_feedback(limit: int = 15) -> list:
    with connect() as conn:
        return conn.execute(
            f"""SELECT f.id, f.raw_text, f.ingested_at, COALESCE(z.name, '{config.ZONE_UNKNOWN}') zone,
                      c.label, c.sentiment, c.status
               FROM feedback f
               LEFT JOIN zone z ON z.id = f.zone_id
               LEFT JOIN classification c ON c.feedback_id = f.id
               WHERE f.deleted_at IS NULL
               ORDER BY f.id DESC LIMIT ?""",
            (limit,),
        ).fetchall()


def recent_logs(limit: int = 20) -> list:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM agent_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()


# 조치요청서 상태: requested → in_progress → done (사람이 고름)
# superseded = 같은 유형의 새 요청서로 대체됨. 시스템만 쓰고, 열린 요청으로 세지 않는다.
OPEN_STATUSES = ("requested", "in_progress")
OPEN_ACTION_SQL = "status IN ('requested','in_progress')"


def open_actions() -> list:
    """처리 현황용 목록. 대체된 요청서는 뺀다 (완료는 남긴다)."""
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM action_request WHERE status != 'superseded' ORDER BY id DESC"
        ).fetchall()


def latest_actions() -> dict[str, dict]:
    """유형별 가장 최근 조치요청서 (대체된 것 제외). 관제 카드의 조치 그룹에 쓴다."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, label, status, created_at, closed_at FROM action_request "
            "WHERE status != 'superseded' ORDER BY id"
        ).fetchall()
    return {r["label"]: dict(r) for r in rows}      # 뒤(최신)가 앞을 덮어쓴다


def latest_action_status() -> dict[str, str]:
    """유형별 가장 최근 요청서의 상태. 같은 유형 요청서가 여럿이면 최신이 이긴다."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT label, status FROM action_request "
            "WHERE status != 'superseded' ORDER BY id"
        ).fetchall()
    return {r["label"]: r["status"] for r in rows}      # 뒤(최신)가 앞을 덮어쓴다


def unhandled_over(label: str, minutes: int) -> bool:
    """해당 라벨에 조치요청이 없거나, 요청 후 N분이 지나도 미완료인가. (S-06)"""
    cutoff = (datetime.now() - timedelta(minutes=minutes)).isoformat(timespec="seconds")
    with connect() as conn:
        row = conn.execute(
            """SELECT COUNT(*) c FROM action_request
               WHERE label=? AND status='done' AND created_at >= ?""",
            (label, cutoff),
        ).fetchone()
        first = conn.execute(
            """SELECT MIN(f.posted_at) t FROM classification c
               JOIN feedback f ON f.id=c.feedback_id
               WHERE c.label=? AND c.status='done' AND f.deleted_at IS NULL""",
            (label,),
        ).fetchone()
    if row["c"] > 0 or first["t"] is None:
        return False
    return first["t"] <= cutoff


def cache_get(digest: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT result FROM classify_cache WHERE hash=?", (digest,)
        ).fetchone()
    return json.loads(row["result"]) if row else None


def cache_delete(digest: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM classify_cache WHERE hash=?", (digest,))
        conn.commit()


def cache_put(digest: str, result: dict) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO classify_cache (hash, result) VALUES (?,?)",
            (digest, json.dumps(result, ensure_ascii=False)),
        )
        conn.commit()


# ── 웹 연동 ───────────────────────────────────────────────────────

def pull_inbox(limit: int = 50) -> int:
    """웹 접수폼이 넣은 민원을 마스킹해 feedback 으로 옮긴다. 옮긴 건수.

    웹(anon)은 feedback 에 직접 쓰지 못한다. 원문이 마스킹 없이 남지 않게
    하려면 insert_feedback() 을 반드시 거쳐야 하기 때문이다.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, zone_id, text FROM feedback_inbox WHERE feedback_id IS NULL "
            "ORDER BY id LIMIT ?", (limit,)
        ).fetchall()
    moved = 0
    for r in rows:
        fid = insert_feedback(r["zone_id"], r["text"] or "", source="qr")
        with connect() as conn:
            # 원문은 지우고 접수번호만 남긴다. 중복이면 -1.
            conn.execute("UPDATE feedback_inbox SET feedback_id=?, text=NULL WHERE id=?",
                         (fid if fid is not None else -1, r["id"]))
            conn.commit()
        moved += fid is not None
    return moved


def request_doc_job(label: str) -> int:
    """조치요청서 생성 요청을 큐에 넣는다. 같은 유형이 이미 대기·작성 중이면 그 번호.

    작성은 워커의 doc_jobs 스레드가 한다 (웹의 request_doc RPC 와 같은 규칙).
    """
    with connect() as conn:
        busy = conn.execute(
            "SELECT id FROM doc_job WHERE label=? AND status IN ('queued','running') LIMIT 1",
            (label,),
        ).fetchone()
        if busy:
            return busy["id"]
        cur = conn.execute("INSERT INTO doc_job (label, created_at) VALUES (?,?)", (label, now()))
        conn.commit()
        return cur.lastrowid


def doc_job_states() -> dict[str, dict]:
    """유형별 가장 최근 요청서 생성 요청의 상태 (queued|running|done|failed)."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, label, status, error, created_at FROM doc_job ORDER BY id"
        ).fetchall()
    return {r["label"]: dict(r) for r in rows}      # 최신이 덮어쓴다


def claim_doc_jobs(limit: int = 2) -> list[dict]:
    """대기 중인 조치요청서 생성 요청을 집는다."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, label FROM doc_job WHERE status='queued' ORDER BY id LIMIT ?", (limit,)
        ).fetchall()
        for r in rows:
            conn.execute("UPDATE doc_job SET status='running' WHERE id=?", (r["id"],))
        conn.commit()
    return [dict(r) for r in rows]


def finish_doc_job(job_id: int, action_id: int | None, error: str = "") -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE doc_job SET status=?, action_request_id=?, error=?, finished_at=? WHERE id=?",
            ("failed" if error else "done", action_id, error[:300] or None, now(), job_id),
        )
        conn.commit()
