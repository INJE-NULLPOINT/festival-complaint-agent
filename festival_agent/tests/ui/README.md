# 웹 화면 검증 도구 (헤드리스 크롬 · DevTools 프로토콜)

크롬의 `--screenshot` / `--dump-dom` 모드는 SSE(실시간 연결)가 열린 이 앱에서 도중에 멈춰
빈 화면을 찍는다. 그래서 DevTools 프로토콜(CDP)로 직접 몬다. Node 22+ (내장 WebSocket), 크롬 필요.

크롬 CDP 포트는 스크립트마다 무작위로 잡는다 (cdp 9300~9799, mobile_check 9500~9899,
report_flow 9900~9989). 따로 띄울 것 없음.

## 1. 테스트 서버 (운영 DB·5173 은 건드리지 않는다)

```bash
cd festival_agent
# 운영 festival.db 를 복사하고 500자 민원·긴 URL·긴 부서명·긴 브리핑을 넣는다 (운영 DB 는 읽기만)
python tests/ui/make_mobile_db.py <복사본경로>/mobile_test.db

# 복사본 DB 로 webapi (8799) — 같은 포트 중복 실행은 거부된다
DB_PATH=<복사본경로>/mobile_test.db python webapi.py --port 8799

# vite 를 5174 로, /api 를 8799 로 넘긴다 (vite.config.ts 의 WEBAPI_PORT)
cd web && WEBAPI_PORT=8799 npx vite --port 5174 --strictPort --host 127.0.0.1
```

## 2. 스크립트

| 스크립트 | 하는 일 | 사용 |
|---|---|---|
| `cdp.mjs` | 한 화면 스크린샷 + 상태 출력 (`[dom]` 에 연결 배지·내용 길이·**실제 렌더 최소 글자 크기**) | `node tests/ui/cdp.mjs <URL> [대기ms=6000] [가로=1440] [세로=900] [저장.png] [light\|dark] [클릭할 CSS 선택자]` |
| `mobile_check.mjs` | 5폭(320·360·390·430·844×390) × 6상태(접수·접수펼침·관제·관제펼침·조치·조치펼침) **가로 스크롤**·넘친 요소·44px 미만 터치·16px 미만 입력 글꼴 측정 + 전체 높이 스크린샷 | `node tests/ui/mobile_check.mjs http://127.0.0.1:5174 <출력폴더> [파일접두어]` → 마지막 줄 `실패 n/30` |
| `report_flow.mjs` | 방문객 접수 흐름 13항목 (?zone= 미리 선택 · 축제 이름 머리글 · 119/112 · FAQ 4문항·사진 없음 · 입력칸 없음 · 빈 내용 막기 · 글자 수 · 보내는 중→완료 · 완료 문구 · 접수번호 · 한 건 더 후 구역 유지 · 없는 zone 무시 · id zone) | `node tests/ui/report_flow.mjs http://127.0.0.1:5174` → `전부 통과` |
| `boot_check.mjs` | JS 실패 안내(`index.html` #boot-msg) — 정상이면 숨김, 번들 JS 요청을 막으면 (스크립트 오류 직후 · 8초 뒤) 안내가 뜨는지 | `node tests/ui/boot_check.mjs <빌드본 주소, 예: http://127.0.0.1:4173>` (빌드본에서만 의미 있음) |
| `make_mobile_db.py` | 위 1번의 테스트 DB 만들기 | `python tests/ui/make_mobile_db.py <출력.db>` |

주의
- 가로 스크롤은 `innerWidth` 가 아니라 **설정한 화면 폭**과 비교한다. 모바일 에뮬레이션은 내용이 넓으면
  `innerWidth` 도 같이 늘어나서 넘침이 안 잡힌다 (D5-18 에서 실제로 속았던 부분).
- `report_flow.mjs` 는 테스트 DB 의 `feedback_inbox` 에 1건을 넣는다. 운영 5173/8765 에 돌리지 말 것.
- 한 페이지에 iframe 여러 개로 여러 화면을 띄우면 같은 호스트 연결 수 제한(6개)에 걸려 빈 화면이 나온다.
  화면은 하나씩 찍는다.
- 관제·조치 화면이 안 바뀌었는지는 전/후 스크린샷을 PIL `ImageChops.difference(a, b).getbbox() is None` 으로 비교.
- `mobile_check.mjs` 결과에 `(내용 없음!)` 이 한두 장 뜨면 한 브라우저로 연속 이동하다 실시간 연결(SSE) 수 제한에 걸린
  것이다. 그 화면만 `cdp.mjs` 로 새 브라우저에 다시 열어 `[dom]` 의 `app` 길이가 0 이 아닌지 확인한다 (D5-27 에서 확인).
- 폰 확인용 빌드본은 `npm run phone` (4173). 개발 서버(5173)와 화면이 같은지는 같은 DB 를 붙인 5180(개발)·4180(preview)
  두 서버를 `cdp.mjs` 로 찍어 PIL `ImageChops.difference(...).getbbox() is None` 으로 비교했다 (12장 IDENTICAL).

## 3. 한 줄로 전부 — `node tests/ui/run_all.mjs`

운영 DB 는 **읽기만** 하고(복사본 사용), 복사본에 webapi(기본 8799)·vite(기본 5174)를 띄워 4묶음을 돌린 뒤
서버·크롬·임시 파일을 정리하고 `tests/ui/report.md` 에 결과를 쓴다 (실행할 때마다 덮어씀). 종료 코드 0 통과 · 1 실패 · 2 준비 실패.

| 묶음 | 스크립트 | 보는 것 |
|---|---|---|
| visitor | `report_flow.mjs` | 방문객 접수 흐름 |
| admin | `admin_flow.mjs` | 관제(카드·펼침·알림·유입) · 실시간(SSE)과 펼침 유지 · 조치(요청서 생성 요청·미리보기·DOCX·상태 변경) · 지우기·되돌리기(서버·화면) |
| mobile | `mobile_check.mjs` | 5폭 × 6상태 가로 스크롤·터치·글꼴 |
| build | (run_all 안) + `boot_check.mjs` | 빌드본에 구형 문법 0개 · JS 실패 안내 |

옵션: `--only=visitor,admin` · `--skip=mobile`(가장 오래 걸림, 약 3분) · `--keep`(임시 폴더 남김) · `--webapi-port=N` · `--vite-port=N` · `--report=경로`

- 기본 포트를 다른 세션이 이미 쓰고 있으면 **그 서버는 건드리지 않고** 빈 포트로 옮겨 간다 (report.md 에 적힘).
- 워커·LLM 이 없다. 그래서 '요청서 생성'은 요청이 쌓여 '대기 중'으로 보이는 데까지만 보고, 미리보기·DOCX 는 복사본에 있는 요청서로 본다.
- 카드·지우기처럼 아직 없는 기능은 ○ 건너뜀, 생기면 자동으로 켜진다. 건너뜀은 report.md 에 사유와 함께 남는다.
- 복사본의 `issue` 표는 복사 시점에 굳는다(워커 없음). main 카드가 하나도 없으면 1위 카드를 main 으로 돌려 놓는다(복사본만).
- 점검 스크립트를 새로 만들면 `✓`(통과) · `✗`(실패) · `○`(건너뜀)로 시작하는 줄을 찍으면 run_all 이 집계한다.

## 4. 운영자 코드(D5-31)와 기계 부하

- **운영자 코드:** 서버가 관리자 동작(지우기·되돌리기·상태 변경·요청서 생성)에 코드를 요구한다. `run_all` 은 **이 실행에서만 쓰는 무작위 코드**를
  만들어 테스트 webapi 의 환경변수 `ADMIN_CODE` 와 점검 스크립트의 `UI_ADMIN_CODE` 로 넣는다. 운영 `.env` 는 쓰지 않고, 값은 보고서·로그에 찍지 않는다.
  `admin_flow.mjs` 를 따로 돌릴 때는 서버에 같은 코드를 넣고 `UI_ADMIN_CODE=<코드>` 로 넘긴다.
- **비ASCII 코드:** HTTP 헤더에는 영문·숫자·기호만 실린다. 화면(`data-local.ts`)은 영문·숫자 코드는 `X-Admin-Code` 헤더로, 한글 등이 섞이면 본문 `p_code` 로 보낸다
  (서버는 둘 다 받는다). 한글 코드를 화면에서 시험하려면 `UI_TEST_CODE="한글코드-점검1" node tests/ui/run_all.mjs --only=admin` (테스트용 임의 문자열).
- **코드 보호 점검(`admin_flow.mjs`):** 서버(코드 없음·틀림 → 401 · 실행 안 됨 · 방문객 접수는 코드 없이 통과) → 화면(처음 누르면 입력 창 · 취소 · 틀림 · 맞음 ·
  sessionStorage 에만 보관 · 새로고침해도 기억 · 저장 코드가 틀리면 다시 묻기) → 방문객 화면에 관리자 요소 없음 → 맨 끝에서 잠김·서버 미설정.
  틀린 코드를 5번 넘게 넣으면 그 서버의 관리자 동작이 10분간 전부 거부되므로 **본 테스트 서버는 절대 잠그지 않는다.**
  ① 서버가 실제로 잠기는지(틀린 5번 뒤 429, 잠긴 동안 맞는 코드도 거부, 방문객 접수는 통과)는 `run_all` 이 따로 띄운 **잠금 시험용 webapi**(별도 포트 · 별도 DB 복사본)에서만 본다.
  그 주소가 `UI_LOCK_BASE` 로 넘어가며, 없으면(`admin_flow.mjs` 단독 실행 등) 이 점검은 '건너뜀' 이다.
  ② 화면이 잠김(429)·서버 미설정(403)을 어떻게 보여 주는지는 브라우저에서 `check_admin` 응답만 바꿔치기(CDP `Fetch`)해서 본다 — 서버에는 영향이 없다.
- **기계 부하:** 다른 프로그램(게임·빌드·다른 세션의 테스트)이 CPU 를 많이 쓰면 화면이 늦게 반응해 고정 대기 시간이 모자란다. `run_all` 은 시작할 때 CPU 사용률을 재서
  `UI_SLOW`(×1 · ×2 · ×3)를 정하고, `admin_flow.mjs` 가 기다리는 시간만 그 배율로 늘린다 (검사 기준은 그대로). 배율은 보고서 '환경'에 적힌다.
  점검이 부하 때문에 깨지는지 제품 때문에 깨지는지 헷갈리면 보고서의 CPU 사용률부터 본다.
- **크롬 정리:** 스크립트는 `chrome_util.mjs` 의 `quitChrome` 으로 크롬을 끈다 (먼저 정상 종료, 안 되면 하위까지 `taskkill /T`). `chrome.kill()` 만 하면 renderer 등이 고아로 남아
  프로필 파일을 붙잡고 임시 폴더가 안 지워진다 (renderer 는 명령줄에 `--user-data-dir` 이 없어 경로로도 못 찾는다). 그래도 남은 `ui-suite-*` 폴더는 다음 `run_all` 시작 때 (10분 지난 것부터) 지운다.

## 5. 연결 끊김 · 대량 데이터 (D5-36 · D5-37)

- `reconnect_flow.mjs` — 서버를 실제로 껐다 켠다. 스스로 webapi(복사본 DB)·vite·크롬을 빈 포트에 띄우고 끝나면 모두 끈다(본 서버 영향 없음).
  관제: '재연결 중' → 8초 뒤 배너(서버에 연결할 수 없습니다 · 마지막 갱신 HH:MM) → 켜면 새로고침 없이 '실시간' 복귀 · 화면이 지워지지 않음.
  방문객: 꺼진 채 접수하면 입력·구역이 남고 버튼이 '다시 시도', 켠 뒤 재시도하면 접수함에 정확히 1건.
- `perf_check.mjs` + `make_big_db.py` — 민원 1,000건·카드 30장(인자로 바꿀 수 있음) 복사본 DB 에서 `/api/control` 응답 시간(순차 30회 중앙값·최대),
  SSE 30개를 붙인 채 응답 시간, 관제 첫 그리기, 변경 → 화면 반영 시간과 그동안의 브라우저 작업 시간을 잰다. 예산은 파일 위쪽 `BUDGET`(ms, `UI_SLOW` 배율 적용).
  1,000건 기준 측정값(2026-09-30, 이 PC): control 중앙값 약 22ms · 첫 그리기 약 0.4초 · 다시 그리기 브라우저 작업 약 20ms. 10,000건에서도 control 약 55ms · 첫 그리기 약 0.6초.
- 둘 다 `run_all` 묶음(`reconnect` · `perf`)으로 돌고, 따로 돌려도 된다: `node tests/ui/perf_check.mjs 10000 30`.
