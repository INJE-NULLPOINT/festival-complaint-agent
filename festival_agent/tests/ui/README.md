# 웹 화면 검증 도구 (헤드리스 크롬 · DevTools 프로토콜)

크롬의 `--screenshot` / `--dump-dom` 모드는 SSE(실시간 연결)가 열린 이 앱에서 도중에 멈춰
빈 화면을 찍는다. 그래서 DevTools 프로토콜(CDP)로 직접 몬다. Node 22+ (내장 WebSocket), 크롬 필요.

크롬 CDP 포트는 스크립트마다 무작위로 잡는다 (cdp 9300~9799, mobile_check 9500~9899,
report_flow 9900~9989). 따로 띄울 것 없음.

## 1. 테스트 서버 (운영 DB·5173 은 건드리지 않는다)

```bash
cd festival_agent
# 운영 festival.db 를 복사하고 500자 민원·긴 URL·긴 부서명·긴 브리핑을 넣는다 (운영 DB 는 읽기만)
node tests/ui/make_mobile_db.ts <복사본경로>/mobile_test.db

# 복사본 DB 로 webapi (8799) — 같은 포트 중복 실행은 거부된다
DB_PATH=<복사본경로>/mobile_test.db node server/webapi.ts --port 8799

# vite 를 5174 로, /api 를 8799 로 넘긴다 (vite.config.ts 의 WEBAPI_PORT)
cd web && WEBAPI_PORT=8799 npx vite --port 5174 --strictPort --host 127.0.0.1
```

## 2. 스크립트

| 스크립트 | 하는 일 | 사용 |
|---|---|---|
| `cdp.ts` | 한 화면 스크린샷 + 상태 출력 (`[dom]` 에 연결 배지·내용 길이·**실제 렌더 최소 글자 크기**) | `node tests/ui/cdp.ts <URL> [대기ms=6000] [가로=1440] [세로=900] [저장.png] [light\|dark] [클릭할 CSS 선택자]` |
| `mobile_check.ts` | 5폭(320·360·390·430·844×390) × 6상태(접수·접수펼침·관제·관제펼침·조치·조치펼침) **가로 스크롤**·넘친 요소·44px 미만 터치·16px 미만 입력 글꼴 측정 + 전체 높이 스크린샷 | `node tests/ui/mobile_check.ts http://127.0.0.1:5174 <출력폴더> [파일접두어]` → 마지막 줄 `실패 n/30` |
| `report_flow.ts` | 방문객 접수 흐름 13항목 (?zone= 미리 선택 · 축제 이름 머리글 · 119/112 · FAQ 4문항·사진 없음 · 입력칸 없음 · 빈 내용 막기 · 글자 수 · 보내는 중→완료 · 완료 문구 · 접수번호 · 한 건 더 후 구역 유지 · 없는 zone 무시 · id zone) | `node tests/ui/report_flow.ts http://127.0.0.1:5174` → `전부 통과` |
| `boot_check.ts` | JS 실패 안내(`index.html` #boot-msg) — 정상이면 숨김, 번들 JS 요청을 막으면 (스크립트 오류 직후 · 8초 뒤) 안내가 뜨는지 | `node tests/ui/boot_check.ts <빌드본 주소, 예: http://127.0.0.1:4173>` (빌드본에서만 의미 있음) |
| `make_mobile_db.ts` | 위 1번의 테스트 DB 만들기 | `node tests/ui/make_mobile_db.ts <출력.db>` |

주의
- 가로 스크롤은 `innerWidth` 가 아니라 **설정한 화면 폭**과 비교한다. 모바일 에뮬레이션은 내용이 넓으면
  `innerWidth` 도 같이 늘어나서 넘침이 안 잡힌다 (D5-18 에서 실제로 속았던 부분).
- `report_flow.ts` 는 테스트 DB 의 `feedback_inbox` 에 1건을 넣는다. 운영 5173/8765 에 돌리지 말 것.
- 한 페이지에 iframe 여러 개로 여러 화면을 띄우면 같은 호스트 연결 수 제한(6개)에 걸려 빈 화면이 나온다.
  화면은 하나씩 찍는다.
- 관제·조치 화면이 안 바뀌었는지는 전/후 스크린샷을 PIL `ImageChops.difference(a, b).getbbox() is None` 으로 비교.
- `mobile_check.ts` 결과에 `(내용 없음!)` 이 한두 장 뜨면 한 브라우저로 연속 이동하다 실시간 연결(SSE) 수 제한에 걸린
  것이다. 그 화면만 `cdp.ts` 로 새 브라우저에 다시 열어 `[dom]` 의 `app` 길이가 0 이 아닌지 확인한다 (D5-27 에서 확인).
- 폰 확인용 빌드본은 `npm run phone` (4173). 개발 서버(5173)와 화면이 같은지는 같은 DB 를 붙인 5180(개발)·4180(preview)
  두 서버를 `cdp.ts` 로 찍어 PIL `ImageChops.difference(...).getbbox() is None` 으로 비교했다 (12장 IDENTICAL).

## 3. 한 줄로 전부 — `node tests/ui/run_all.ts`

운영 DB 는 **읽기만** 하고(복사본 사용), 복사본에 webapi(기본 8799)·vite(기본 5174)를 띄워 4묶음을 돌린 뒤
서버·크롬·임시 파일을 정리하고 `tests/ui/report.md` 에 결과를 쓴다 (실행할 때마다 덮어씀). 종료 코드 0 통과 · 1 실패 · 2 준비 실패.

| 묶음 | 스크립트 | 보는 것 |
|---|---|---|
| visitor | `report_flow.ts` | 방문객 접수 흐름 |
| admin | `admin_flow.ts` | 관제(카드·펼침·알림·유입) · 실시간(SSE)과 펼침 유지 · 조치(요청서 생성 요청·미리보기·DOCX·상태 변경) · 지우기·되돌리기(서버·화면) |
| mobile | `mobile_check.ts` | 5폭 × 6상태 가로 스크롤·터치·글꼴 |
| build | (run_all 안) + `boot_check.ts` | 빌드본에 구형 문법 0개 · JS 실패 안내 |

옵션: `--only=visitor,admin` · `--skip=mobile`(가장 오래 걸림, 약 3분) · `--keep`(임시 폴더 남김) · `--webapi-port=N` · `--vite-port=N` · `--report=경로`

- 기본 포트를 다른 세션이 이미 쓰고 있으면 **그 서버는 건드리지 않고** 빈 포트로 옮겨 간다 (report.md 에 적힘).
- 워커·LLM 이 없다. 그래서 '요청서 생성'은 요청이 쌓여 '대기 중'으로 보이는 데까지만 보고, 미리보기·DOCX 는 복사본에 있는 요청서로 본다.
- 카드·지우기처럼 아직 없는 기능은 ○ 건너뜀, 생기면 자동으로 켜진다. 건너뜀은 report.md 에 사유와 함께 남는다.
- 복사본의 `issue` 표는 복사 시점에 굳는다(워커 없음). main 카드가 하나도 없으면 1위 카드를 main 으로 돌려 놓는다(복사본만).
- 점검 스크립트를 새로 만들면 `✓`(통과) · `✗`(실패) · `○`(건너뜀)로 시작하는 줄을 찍으면 run_all 이 집계한다.

## 4. 기계 부하

- **기계 부하:** 다른 프로그램(게임·빌드·다른 세션의 테스트)이 CPU 를 많이 쓰면 화면이 늦게 반응해 고정 대기 시간이 모자란다. `run_all` 은 시작할 때 CPU 사용률을 재서
  `UI_SLOW`(×1 · ×2 · ×3)를 정하고, `admin_flow.ts` 가 기다리는 시간만 그 배율로 늘린다 (검사 기준은 그대로). 배율은 보고서 '환경'에 적힌다.
  점검이 부하 때문에 깨지는지 제품 때문에 깨지는지 헷갈리면 보고서의 CPU 사용률부터 본다.
- **크롬 정리:** 스크립트는 `lib.ts` 의 `quitChrome` 으로 크롬을 끈다 (먼저 정상 종료, 안 되면 하위까지 `taskkill /T`). `chrome.kill()` 만 하면 renderer 등이 고아로 남아
  프로필 파일을 붙잡고 임시 폴더가 안 지워진다 (renderer 는 명령줄에 `--user-data-dir` 이 없어 경로로도 못 찾는다). 그래도 남은 `ui-suite-*` 폴더는 다음 `run_all` 시작 때 (10분 지난 것부터) 지운다.

## 5. 서버 동작 점검 (D5-36 · D5-37 · D5-40) — `server_flow.ts`

스크립트 하나에 세 묶음이 있다: `node tests/ui/server_flow.ts reconnect | perf [민원수] [카드수] | security`. 모두 스스로 webapi(복사본 DB)·vite·(필요하면) 크롬을
빈 포트에 띄우고 끝나면 모두 끈다 (본 서버·다른 세션 영향 없음). `run_all` 이 세 묶음(`reconnect` · `perf` · `security`)으로 부른다.

- `reconnect` — 서버를 실제로 껐다 켠다. 관제: '재연결 중' → 8초 뒤 배너(서버에 연결할 수 없습니다 · 마지막 갱신 HH:MM) → 켜면 새로고침 없이 '실시간' 복귀 ·
  끊긴 채 다시 그려도 화면이 지워지지 않음. 방문객: 꺼진 채 접수하면 입력·구역이 남고 버튼이 '다시 시도', 켠 뒤 재시도하면 접수함에 정확히 1건.
- `perf` — 민원 1,000건·카드 30장(`make_mobile_db.ts <dst> --big 민원수 카드수`) 복사본에서 `/api/control` 응답 시간(순차 30회 중앙값·최대, SSE 30개 연결 중 포함),
  관제 첫 그리기, 변경 → 화면 반영 시간과 그동안의 브라우저 작업 시간. 예산은 파일의 `BUDGET`(ms, `UI_SLOW` 배율 적용).
  1,000건 기준(2026-09-30, 이 PC): control 중앙값 약 22ms · 첫 그리기 약 0.4초 · 다시 그리기 작업 약 20ms. 10,000건에서도 control 약 55ms · 첫 그리기 약 0.6초.
- `security` — 17KB 본문 413 · Content-Length 음수 400 · 배열/깨진 JSON/모르는 인자 400(고정 문구) · text/plain 415 · 같은 글 동시 8번 → 1건 ·
  SSE 51번째 503 · 멈춘 요청 끊김 · 500 응답에 경로·SQL 없음.
- 공용 도구는 `lib.ts` (크롬 열기 `openChrome` · 정리 `quitChrome` · `freePort` · `killTree` · 결과 출력 `reporter`). 점검용 DB 는 `make_mobile_db.ts` 하나(기본 모바일 극단 입력 · `--big` 대량).
