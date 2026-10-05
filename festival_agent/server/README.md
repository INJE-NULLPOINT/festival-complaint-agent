# 서버 개발 규칙

서버(워커·에이전트·local 대역 API·CLI·스크립트)는 TypeScript 다. 웹과 한 언어로 맞춘다.

## 실행 환경
- Node 24 의 **내장 타입 제거**로 `.ts` 를 바로 실행한다 (`node server/worker.ts`). 빌드 단계 없음.
  → enum·namespace·parameter property 금지 (타입 제거로 못 지운다). `import type` 을 쓴다. import 경로는 `.ts` 확장자까지.
- 테스트: `node --test "server/tests/*.test.ts"` (node:test + node:assert). 추가 테스트 프레임워크 없음.
- DB: `SUPABASE_DB_URL` 이 있으면 `pg`(Supabase Postgres), 없으면 **`node:sqlite`**(내장)로 `festival.db`. 둘 다 같은 SQL 을 쓴다
  (SQLite 문법 한 벌, Postgres 는 `core/db.ts` 가 바꿔 준다. 스키마는 `supabase/schema.sql`).
- 의존성은 `server/package.json` 에만: `pg`, `@anthropic-ai/sdk`, `docx`, `dotenv`. 그 밖은 [총괄]에 먼저 말한다.

## 운영 DB 를 지키는 규칙
- `.env` 는 `festival_agent/.env` 를 읽는다. **값은 출력하지 않는다** (설정됐는지 true/false 만 찍는다).
- **테스트·측정 스크립트는 기본이 임시 SQLite** 다. 운영 Supabase 에 붙는 것은 `--live-db` 를 줄 때만 (합성 민원이 운영 DB 에 섞이는 사고 방지).
- 손으로 서버·vite 를 띄워 확인할 때도 `SUPABASE_DB_URL=` · `VITE_SUPABASE_URL=` 를 빈 값으로 준다 (`.env`·`web/.env` 에 운영 값이 들어 있다).
  config 는 `SUPABASE_DB_URL` 을 `process.env` 가 **빈 문자열로라도 정해져 있으면 `.env` 로 덮지 않는다**.
- 워커를 SQLite 로 돌리려면 `node server/worker.ts --sqlite [경로]` — `SUPABASE_DB_URL` 을 무시하고 SQLite(기본 `festival.db`,
  경로를 주면 그 파일)로 돈다. 시작할 때 `DB: SQLite <파일명>` 한 줄이 찍힌다 (URL 은 찍지 않는다).

## 백업·복원 (운영 Supabase)
- `run_all_servers` 가 30분마다 (`SUPABASE_DB_URL` 이 있으면) 운영 테이블을 **읽기 전용** 트랜잭션으로 읽어 `backup/supabase_*.json` 한 파일로 저장하고 최근 12개만 남긴다.
  `source_key`·`submit_rate` 는 넣지 않는다. 지금 바로: `node server/scripts/run_all_servers.ts --backup-now`.
- 복원: `node server/cli.ts db restore <파일> [--live-db]` — 미리보기(테이블별 지금→복원 후 행 수) 뒤 확인 문구를 입력해야 바뀐다.
  운영 Supabase 는 `--live-db` 필수 + `운영복원` 입력, 복원 직전 상태를 `backup/before_restore_*.json` 으로 먼저 저장한다. 한 트랜잭션이라 실패하면 원래대로.
  연습은 임시 SQLite 로: `SUPABASE_DB_URL= DB_PATH=<임시.db> node server/cli.ts db restore <파일> --yes`.
- 조치요청서 DOCX 는 **운영 DB(Postgres)에 붙어 있을 때만** Storage 에 올린다 (`agents/dispatcher.ts _upload`). SQLite 면 `SUPABASE_URL`·`SUPABASE_SERVICE_KEY` 가 남아 있어도 올리지 않는다.
