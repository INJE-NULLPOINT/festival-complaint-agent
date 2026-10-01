# 실시간 축제 민원 자동분류 AI Agent

제4회 경남 AI·SW 경진대회 · 대학부 · 신청분야 05 (지역혁신·공공서비스)

---

## 실행

서버는 TypeScript 이고 **Node 24 이상**에서 빌드 없이 바로 실행합니다 (Python 불필요). 명령은 `festival_agent/` 에서 칩니다.

```bash
npm install --prefix server

# 1) API 키 설정
cp .env.example .env      # ANTHROPIC_API_KEY 채우기
#   또는  ant auth login   (프로필을 SDK가 자동으로 읽습니다)

# 2) 서버·워커·웹 화면 한 번에 (감시·자동 재시작·30분 백업)
node server/scripts/run_all_servers.ts      # webapi(8765) + worker + 웹(5173) → http://localhost:5173

# 3) 따로 켤 때 — 워커만 (별도 터미널)
node server/worker.ts                      # 접수 즉시 수거·분류 (예비 폴링 1초) / Agent 60초
node server/worker.ts --agent-interval 20  # 시연용 (반응 빠르게)
node server/worker.ts --no-agents          # ①분류만 (비용 절약)
```

**멈춤 대비 — 서버 일괄 실행**: `node server/scripts/run_all_servers.ts` 한 줄이 webapi·worker·vite 를 분리 프로세스로 띄우고, 죽으면 2→60초 간격으로 다시 띄웁니다
(로그 `output/logs/`, 중복 실행 차단, DB 를 30분마다 `backup/auto_*.db` 로 복사해 최근 12개만 보관 — `backup/` 은 git 제외, `--phone`·`--only`·`--dry-run`·`--backup-now` 지원).
SQLite 는 `synchronous=FULL` + WAL 이라 전원이 나가도 커밋된 건은 남고, 워커도 같은 DB 로 두 개 뜨지 않습니다.

**접수→분류 벽시계 측정**: `node server/scripts/wall_clock.ts [--mode agent|prefetch] [--backend claude_code|anthropic|local] [--n 3] [--batch 5] [--report]` —
실제 워커를 임시 DB 로 띄워 접수부터 분류 완료까지(폴링 포함)를 표로 보여 줍니다 (운영 DB 미사용). 제출 기준은 `--backend anthropic` 측정입니다.

**카드 프롬프트 공격 점검**: `node server/tests/attack_check.ts --backend anthropic [--set orig|para|all] [--detect-only]` — 민원에 '카드 조치를 바꿔라' 같은 문장을 심어
임시 DB 로 ①분류 → ④카드 문구까지 돌리고, 공격이 카드에 새지 않았는지(인용·고위험 표현·숫자·근거 없는 시설)와 지시문 탐지·정상 민원 오탐 10개를 자동 판정합니다 (운영 DB 미사용, 결과 `server/tests/attack_check.md`).

### 터미널 버전

브라우저 없이 같은 DB를 다룹니다. 웹 화면과 동시에 켜도 됩니다.

```bash
node server/cli.ts watch --drive             # 실시간 모니터 (워커 없이 단독 구동)
node server/cli.ts status                    # 현재 상태 스냅샷
node server/cli.ts submit "진입로가 어두워요"  # 민원 접수
node server/cli.ts cycle                     # ①②③④ 한 바퀴
node server/cli.ts replay start --speed 300  # 리플레이
node server/cli.ts db tables | log | feed    # DB 조회
node server/cli.ts check                     # 백엔드·API 키 확인
node server/cli.ts reset --all               # 초기화
```

### 실시간으로 보기

```bash
node server/cli.ts reset --all
node server/cli.ts replay start --speed 20000
node server/cli.ts --window 5835 watch --drive --interval 2
```

화면이 2초마다 다시 그려지면서 민원이 쌓이고 순위가 바뀌는 과정이 보입니다.
`--drive`는 워커 없이 리플레이 투입과 분류까지 이 명령이 직접 수행한다는 뜻입니다.
`--once`를 붙이면 한 프레임만 출력합니다 (캡처·문서용).

개발용 합성 시드를 재생한 결과 (규칙 기반 대역 분류 — AI 모델 분류가 아님. 2026-10-01 D5-59 반영 뒤 재측정):

| 순위 | 건수 순위 | 심각도 순위 (등급) |
|---|---|---|
| 1 | 주차/교통 54건 | **안전 11건 — 즉시** |
| 2 | 가격/바가지 30건 | 혼잡 3건 — 높음 (위험 신호 1건) |
| 3 | 화장실 29건 | 주차/교통 54건 — 보통 |
| 4 | 긍정 18건 (심각도 제외) | 화장실 29건 — 보통 |
| 5 | 안전 11건 | 가격/바가지 30건 — 낮음 |
| 6 | 안내/동선 10건 | 안내/동선 10건 — 낮음 |

★ 역전: 건수 1위 주차/교통(54건)은 심각도 3위(보통), 안전은 11건뿐인데 1위(즉시).
관제 카드도 같은 순서입니다: 안전 3장(소망등 달기 구역 · 진주교 남단 주차장 · 남강 수상무대) 즉시 → 유등터널 혼잡 높음 → 주차 카드들 보통.
혼잡이 안전 가중을 받는 것은 3건 중 1건에 '밀려다녔어요' 같은 위험 신호가 있어서입니다(D5-59). 신호 없는 혼잡은 주차·화장실과 똑같이 계산합니다.

(개발용 합성 시드 160건 · 규칙 기반 대역 분류 · 창 5835분. 분류 신뢰도가 낮은 5건은
"확인 필요"로 빠져 있어 창 건수가 155건입니다.)

`--window` 로 심각도 창을 조정합니다. 기본 60분이며, 창 밖 데이터가 많으면
상태 화면이 알려줍니다.

### 시연·개발 (API 키 없이도 됨)

```bash
# seed/dev_sample.csv(개발용 합성 160건)는 저장소에 이미 있습니다. 문서의 수치는 이 파일 기준입니다.
# node server/scripts/make_dev_seed.ts    # 다시 만들 때만 — 기본 120건으로 덮어써 수치가 달라집니다
LLM_BACKEND=local node server/cli.ts demo  # 투입 → 분류 → 판정까지 한 번에 (LLM 없이)
```
그 다음 **조치 화면 → 리플레이 → ▶ 시작**을 누르면 민원이 배속으로 쏟아지고,
관제 화면에서 **건수 1위(주차)와 심각도 1위(안전)가 갈리는 장면**을 볼 수 있습니다.

> `LLM_BACKEND=local` 은 키워드 규칙(`server/core/rules.ts`)으로 도는 **개발용 대역이지 제품이 아닙니다.**
> 제출물에서 분류는 ①분류 에이전트(Claude)가 수행합니다.

브라우저에서 사이드바의 **접수 → 관제 → 조치** 순으로 확인하세요.
접수 화면에서 민원을 넣으면 워커가 바로 집어갑니다. 운영 Postgres 에서는 접수 알림(LISTEN/NOTIFY)으로 즉시 깨어나고(시작 로그 '접수 알림(LISTEN/NOTIFY) 연결됨'), 알림을 못 받는 연결에서는 1초 폴링으로 받습니다. 분류 루프는 새 민원이 들어오면 즉시 깨어나고 예비로 3초마다 확인합니다. 관제 카드는 5초마다 갱신됩니다.

관광공사 API (선택):
```bash
# .env 에 TOURAPI_KEY 를 넣은 뒤
node server/scripts/seed_festival.ts --list        # 경남 축제 목록
node server/scripts/seed_festival.ts --pick 유등    # 대상 축제 설정
```
키가 없어도 시스템은 그대로 동작합니다 (`server/core/config.ts`의 수기 시드 사용).

테스트:
```bash
node server/scripts/final_check.ts        # 전부 한 번에 (약 7분, LLM 호출 없음) → tests/final_check.md 에 표 1장
```
순서: 단위(`server/tests/*.test.ts`) → 시나리오 5종(`server/scripts/testcase_report.ts`) →
웹 타입 검사(tsc) → 화면·서버 전체(`tests/ui/run_all.ts`: 방문객·관리자·연결 끊김·속도·보안·모바일·빌드본) → 제출물 제외 확인(.env·*.db·키 등이 git 에 없는지).
운영 DB 는 쓰지 않고(시험마다 복사본·별도 포트), 제출용 기록(`testcase_report.md`)은 끝나면 원래 내용으로 돌려놓습니다.
일부만: `--only=unit,tsc` · `--skip=ui`. 개별 시험·실제 LLM 호출(`node server/scripts/testcase_report.ts --live`)은 필요할 때 따로 돌립니다 —
`tests/testcase_report.md` 가 **제출용 테스트 증거**입니다. 화면 시험 상세는 `tests/ui/README.md`.

---

## 할 일 자동 갱신

`../할일.md` 는 손으로 관리하지 않습니다. 시스템 상태를 직접 확인해 다시 그립니다.

```bash
node server/cli.ts todo             # 지금 상태로 다시 그리기
node server/cli.ts todo --show      # 파일에 쓰지 않고 출력만
node server/cli.ts todo --watch     # 파일을 고칠 때마다 즉시 재판정
node server/worker.ts               # 에이전트가 한 바퀴 돌 때마다 자동 갱신
```

| 종류 | 동작 |
|---|---|
| `auto` 20개 | 파일·DB·환경변수를 보고 판정. 손으로 체크해도 증거대로 되돌아감 |
| 그 외 7개 | 직접 체크. 갱신해도 상태와 메모가 보존됨 |

판정 근거는 증거와 함께 표시됩니다.

```
- [x] `E2E` 접수→분류→심각도→조치→브리핑 관통  `auto` 분류 134 · 심각도 6 · 조치 1 · 브리핑 1
- [ ] `D5-2` 실제 모델로 에이전트 한 바퀴        `auto` local 대역 기록만 있음
```

항목 아래 `      > 메모` 형식으로 쓴 줄은 다시 그려도 남습니다.
한 번 달성한 항목은 DB를 초기화해도 `(이전 달성 MM-DD)` 로 이력이 남습니다.

## 웹 앱 (Supabase + TypeScript)

관리자·방문객 화면은 이 웹 앱 하나입니다(Streamlit 화면은 2026-10-01 에 뺐습니다). 워커는 그대로 돌리고,
웹은 실시간 구독으로 바뀐 부분만 다시 그립니다.

### 지금 구성 — Supabase (2026-09-30 연결)

워커(`.env` 의 `SUPABASE_DB_URL`)와 웹(`web/.env` 의 `VITE_SUPABASE_URL`·`VITE_SUPABASE_ANON_KEY`)이 모두 Supabase 에 붙어 있습니다.
스키마·RLS·RPC·Storage `docs` 버킷을 적용했고 운영자 코드 해시를 등록했습니다. 웹 헤더에 `실시간 · Supabase` 가 뜹니다.
연결을 다시 만들거나 새 프로젝트로 옮길 때는 아래 'Supabase 연결 방법'을 따릅니다.

### 개발·테스트용 — local 대역 (`webapi.ts`)

LLM 대역과 같은 방식입니다. `web/.env` 가 없으면 웹은 `webapi.ts`(SQLite 위에서
Supabase RPC·Realtime·Storage 를 흉내 내는 서버)에 붙습니다. 헤더에 `실시간 · 로컬 DB` 가 표시됩니다.
화면 점검(`tests/ui/run_all.ts`)·시나리오·정확도·시연 스크립트는 운영 데이터를 건드리지 않으려고 이 대역(임시 SQLite)으로 돕니다.

```bash
node server/worker.ts                 # 터미널 1 — 웹 접수 수거 · 분류 · 조치요청서 작성
node server/webapi.ts                 # 터미널 2 — local 대역 API (127.0.0.1:8765)
cd web && npm install && npm run dev   # 터미널 3 — http://localhost:5173
```

| Supabase | local 대역 (`webapi.ts`) |
|---|---|
| PostgREST 읽기 | `GET /api/zones` · `/api/control` · `/api/action` |
| RPC 6개 (`schema.sql`) | `POST /api/rpc/<이름>` — 관리자 동작 5개는 운영자 코드 필요(아래 '운영자 코드'), 검증 규칙 동일 (한글·영문·숫자 2개 이상 · 500자 이하 · 구역 존재 · `department_map` 기준 · 없는 민원 id 는 오류 · 서울 시각) |
| Realtime | `GET /api/events` (SSE, 1초 지문 비교) |
| Storage `docs` 버킷 | `GET /api/docs/<파일명>` — `output/` 의 DOCX (경로 탈출 차단) |

`webapi.ts` 는 지우지 않습니다. Supabase 로 연결된 지금은 웹이 부르지 않고, 개발·테스트용으로만 씁니다.

### Supabase 연결 방법 (다시 설정할 때 · 코드 수정 없음)

1. **스키마** — Supabase 대시보드 > SQL Editor 에 `supabase/schema.sql` 전체를 붙여 넣고 Run.
   테이블(`issue`·`operator_secret` 포함) · RLS · RPC 6개 · Realtime · Storage `docs` 버킷이 만들어집니다. 여러 번 실행해도 안전합니다.
2. **워커 `.env`** (`.env.example` 참고)
   - `SUPABASE_DB_URL` — Connect > Session pooler 연결 문자열 (있으면 SQLite 대신 Postgres)
   - `SUPABASE_URL` · `SUPABASE_SERVICE_KEY` — 조치요청서 DOCX 를 Storage 에 올릴 때 사용.
     비워 두면 DOCX 링크가 local 대역 주소(`/api/docs/...`)로 남습니다.
   - `SUPABASE_BUCKET` — 기본 `docs`
3. **웹 `web/.env`** — `VITE_SUPABASE_URL` · `VITE_SUPABASE_ANON_KEY` (anon 키만. service_role 금지)
4. **재시작** — 워커를 다시 켜고, `npm run dev` 도 재시작합니다 (Vite 는 `.env` 를 시작할 때만 읽습니다).
   배포본은 `npm run build` 로 다시 빌드합니다.
5. **확인**

```bash
npm install --prefix server
node server/cli.ts db tables          # Supabase 테이블이 보이면 워커 연결 OK
node server/worker.ts
cd web && npm run dev            # 헤더가 "실시간 · Supabase" 로 바뀌면 웹 연결 OK
node server/cli.ts todo               # D5-6 · D5-9 가 자동으로 체크됩니다
```

되돌리려면 두 `.env` 의 Supabase 값을 비우고 재시작하면 local 대역으로 돌아갑니다.

### 휴대폰으로 확인 (같은 Wi-Fi)

```bash
cd web && npm run phone          # 빌드 후 preview — 폰은 이걸로 확인한다 (포트 4173)
# 폰에서:  http://<PC IP>:4173/?v=qr      (PC IP 는 터미널의 Network 주소)
```

**폰은 `npm run phone`(빌드본)으로 확인하세요.** 개발 서버(`npm run dev`, 5173)는 문법을 낮추지 않고
최신 그대로 보내서, 구형 폰 브라우저(오래된 삼성 인터넷·Chrome)가 `??=` · `?.` 같은 문법 하나만
못 읽어도 스크립트 전체가 멈추고 CSS 없는 뼈대 HTML 만 보입니다 (D5-27).
빌드본은 `vite.config.ts` 의 `build.target`(es2017 · chrome64 · safari12)으로 의존성까지 낮춰 만듭니다.
소스를 고친 뒤에는 `npm run phone` 을 다시 실행하거나 `npx vite build` 만 다시 하면 폰에도 반영됩니다.

JS 가 끝내 못 돌면 흰 화면 대신 "브라우저를 최신으로 업데이트하거나 Chrome 으로 열어 주세요" 안내가 뜹니다 (`index.html`).
`/api` 는 vite(개발·preview 둘 다)가 PC 의 webapi(127.0.0.1:8765)로 넘기므로 webapi 는 그대로 둡니다.
Windows 방화벽이 포트를 막으면 처음 한 번 허용해야 합니다. 개발 서버를 폰에 열어야 하면 `npm run dev:phone`(5173).

| 주소 | 화면 |
|---|---|
| `/#control` | 관제 — 브리핑 · 심각도 순위(누르면 계산식) · 실시간 유입 · 알림 |
| `/#action` | 조치 — 유형별 **조치요청서 생성** 버튼 → 워커가 작성 → 미리보기 · DOCX · 처리 상태 |
| `/?v=qr` | 방문객 접수폼 (QR 코드용, 상단 탭 숨김) |

- 웹(anon 키)은 읽기만 하고, 쓰기는 RPC 6개(`submit_feedback` · `request_doc` · `set_action_status` · `delete_feedback` · `restore_feedback` · `check_admin`)로만 합니다.
  방문객이 코드 없이 쓰는 것은 `submit_feedback` 뿐이고, 나머지는 운영자 코드가 맞아야 동작합니다.
- `/api/control` 은 관제 카드 `issues[]`(issue 표의 열 그대로, JSON 열은 문자열)와 `review`(확인 필요) · `review_safety`(그중 안전 의심) · `deleted`(지운 개수) 를 함께 줍니다.
- 접수 원문은 `feedback_inbox` 에 잠깐 들어갔다가 워커가 **마스킹한 뒤** `feedback` 으로 옮기고 지웁니다.
- `SUPABASE_DB_URL` 을 비워 두면 예전처럼 `festival.db`(SQLite) 로 동작합니다. 테스트도 SQLite 로 돕니다.

### 별도 DB 로 돌리기 — 실사용자 검증·시연 녹화 (D6-4)

운영 `festival.db` 와 섞이지 않게 **새 파일**을 DB 로 지정하고, 워커와 webapi 를 **같은 `DB_PATH` 로** 띄웁니다 (PowerShell).

```powershell
$env:DB_PATH = "output/verify.db"      # 처음 쓰는 파일이면 자동으로 만들어집니다
node server/worker.ts                       # 터미널 1
node server/webapi.ts                       # 터미널 2 (각 터미널마다 위 한 줄을 먼저)
cd web; npm run phone                  # 터미널 3 — 폰은 http://<PC IP>:4173/?v=qr
```

운영자 코드(`ADMIN_CODE`)는 그대로 `.env` 에서 읽습니다. 참여자가 넣은 민원은 `node server/cli.ts db show <번호>` 로 추적합니다
(웹 접수 창의 `W-번호` 도 같은 번호로 찾힙니다). `SUPABASE_DB_URL` 이 켜져 있으면 DB 가 Supabase 이므로 비워 두고 돌립니다.
검증용 문장은 사람이 직접 쓴 것이라 합성이 아닙니다 — 시연용 합성 시나리오와 DB 파일을 섞지 마세요.

**시연 영상용 합성 시나리오**: `node server/scripts/demo_scenario.ts --dry-run` 으로 계획만 보고,
`node server/scripts/demo_scenario.ts --reset --lead 120` 으로 `output/demo_festival.db` 에 배경 가상 민원 24건(`source='demo'`)을 넣은 뒤
T+40·T+50초에 유등터널 혼잡 2건을 예약 투입합니다 (운영 DB 는 거부). 전부 지어낸 문장이라 영상에 합성임을 밝혀야 합니다.

### 운영자 코드 (관리자 동작 보호, D5-31)

로그인이 없어서, 코드가 없으면 주소를 아는 누구나 민원을 지우거나 조치 상태를 바꿀 수 있습니다.
그래서 아래 네 가지는 **운영자 코드**가 맞을 때만 실행됩니다. 방문객이 쓰는 것은 접수(`submit_feedback`) 하나뿐이고 코드가 필요 없습니다.

| 관리자 동작 | local 대역(`webapi.ts`) | Supabase RPC |
|---|---|---|
| 민원 지우기·되돌리기 | `delete_feedback` · `restore_feedback` | 같은 이름 + `p_code` |
| 조치 상태 변경 | `set_action_status` | 같은 이름 + `p_code` |
| 조치요청서 생성 | `request_doc` | 같은 이름 + `p_code` |
| 코드 확인(입력 창용) | `check_admin` | 같은 이름 + `p_code` |

**코드 정하는 법 — 값은 직접 정해 아래 두 곳에만 넣습니다. 채팅·문서·커밋에 적지 마세요.** 길고 추측하기 어려운 값이 좋습니다.

1. **local 대역**: `festival_agent/.env` 의 `ADMIN_CODE=` 뒤에 값을 넣고 `webapi.ts`(또는 `run_all_servers.ts`)를 다시 켭니다.
   - 비워 두면 관리자 동작이 **전부 거부**됩니다 (열린 채로 시작하지 않음). `webapi.ts` 시작 때 경고가 나옵니다.
   - 웹은 요청 헤더 `X-Admin-Code` (또는 본문 `p_code`)로 보냅니다. 없으면 401, 틀리면 401, 코드 미설정이면 403, 잠기면 429 입니다.
2. **Supabase**: `supabase/schema.sql` 을 다시 실행한 뒤, SQL Editor 에서 **한 번만** 다음 문장을 실행합니다 (`<운영자 코드>` 자리에 값을 넣습니다. 이 문장을 파일에 저장하지 마세요).

   ```sql
   insert into operator_secret (id, code_hash)
   values (1, extensions.crypt('<운영자 코드>', extensions.gen_salt('bf')))
   on conflict (id) do update set code_hash = excluded.code_hash;
   ```

   코드는 해시로만 저장되고 `operator_secret` 은 anon 이 읽지 못합니다. 이 표가 비어 있으면 관리자 RPC 는 전부 거부됩니다.
   코드를 바꾸려면 같은 문장을 새 값으로 다시 실행합니다.

**규칙** (두 대역 공통): 틀린 코드는 실패로 세고, 최근 10분에 5번 틀리면 그 10분 동안은 맞는 코드도 거부합니다. 맞으면 실패 기록이 비워집니다.
코드를 안 보낸 요청은 실패로 세지 않습니다. 비교는 시간차 공격을 막는 방식(`hmac.compare_digest`)으로 합니다.

**Supabase RPC 응답**: 코드가 틀렸을 때 예외를 던지면 '틀린 시도' 기록까지 롤백되어 잠금이 작동하지 않으므로, 관리자 RPC 는
`{"ok": true, ...}` 또는 `{"ok": false, "error": "운영자 코드가 필요합니다"}` 를 **반환값으로** 돌려줍니다 (`request_doc` 은 `id` 포함).
없는 민원·잘못된 상태 같은 검증 오류는 코드를 통과한 뒤의 일이라 예외 그대로입니다. 예전 시그니처(코드 인자 없음)는 `schema.sql` 이 지웁니다.

**한계**: 공유 코드라 누가 했는지는 구분하지 못하고(조치 기록에는 '운영자'로만 남음), 코드가 새면 바꿔야 합니다. 읽기는 여전히 열려 있습니다
(원문은 접수 때 마스킹됨). 휴대폰으로 시연하려고 `webapi.ts` 를 `--host 0.0.0.0` 으로 열면 같은 와이파이의 누구나 닿으므로 그때 이 코드가 실제로 필요해집니다.
나중에 Supabase Auth(가입 차단) + RPC 안의 `auth.uid()` 검사로 바꿀 수 있습니다.

## 백엔드 전환

에이전트의 두뇌를 갈아끼울 수 있습니다. 개발 중에는 API 비용 없이 오케스트레이션
전체를 돌리고, 제출 시점에 `.env` 한 줄로 실제 모델로 바꿉니다.

| 값 | 동작 | 용도 |
|---|---|---|
| `LLM_BACKEND=anthropic` | 실제 모델이 도구를 골라 호출 (API 키) | **제출본** |
| `LLM_BACKEND=claude_code` | 실제 모델이 도구를 골라 호출 (이 PC 의 Claude Code CLI `claude -p` 경유) | 키 없이 실제 판단 확인 — 개발용 |
| `LLM_BACKEND=local` | 규칙 기반 대역이 같은 도구를 호출 | 개발·리허설 전용 |

미지정이면 `ANTHROPIC_API_KEY` 유무로 자동 판단합니다 (`claude_code` 는 명시해야 합니다).

`claude_code` 는 도구 명세를 시스템 프롬프트에 넣고, 모델이 JSON(`tool_calls` / `final`)으로
고른 도구를 우리 코드가 실행해 결과를 다음 입력에 붙입니다. 루프·도구·로그는 API 경로와 같고,
`agent_log` 에는 `cli_call` 로 남아 제출 검증(D5-2, `api_call`)과 섞이지 않습니다.
구독 사용량을 쓰므로 worker 상시 구동보다 `cli.ts cycle` 1회·`measure_accuracy --limit` 소량으로 확인하세요. 지금 어떤 백엔드로 도는지는
`node server/cli.ts check`, `node server/cli.ts status`, 관제 화면 사이드바에 표시됩니다.

### local 대역이 하는 일

에이전트 5종(⓪계획 포함) 모두 `local` 대역을 가집니다. 대역은 **같은 도구를 같은 순서로**
호출하므로 DB에 남는 결과와 `agent_log` 기록이 실제 경로와 같은 모양입니다.
다만 판단이 없습니다.

| 에이전트 | 실제 모델 | local 대역 |
|---|---|---|
| ⓪계획 | 상황(건수·등급)을 보고 이번 주기에 돌릴 단계·창을 정함 | 규칙으로 계획 (같은 관측값 사용) |
| ①분류 | 문장을 읽고 유형·강도·안전여부 판정 | `server/core/rules.ts` 키워드 규칙 |
| ②감시 | 어떤 창을 볼지, 무엇을 알릴지 판단 | 전 유형 점수화 후 규칙대로 알림 |
| ③조치 | 대표성 있는 원문 선별, 조치 제안 작성 | 구역 분산 + 신뢰도 기준 선별, 템플릿 제안 |
| ④통합 | 결론이 엇갈릴 때 조정하고 문장 작성 | 우선순위 1위를 따르고 템플릿 조립 |

### local 대역의 한계 (제출 전 반드시 확인)

규칙 기반이라 자연어 이해가 없습니다. 실제로 드러난 사례:

- **"생수 한 병에 삼천 원 받더라고요"** → 키워드 `천원`이 `삼천 원`(띄어쓰기)에
  걸리지 않아 미분류로 떨어졌습니다. 실제 ①분류 에이전트는 `price`로 맞춥니다.
- 미분류는 `confidence 0.25`로 표시되어 조치요청서 인용에서 후순위로 밀립니다.
  대역이 만든 저신뢰 분류가 부서 문서를 오염시키지 않게 하는 장치입니다.

**제출 전에 `LLM_BACKEND=anthropic` 으로 전체를 다시 돌려 실제 에이전트 동작을
확인해야 합니다.** 비꼬는 표현, 처음 보는 표현, 여러 유형이 섞인 문장에서
차이가 납니다.

## 구조

```
festival_agent/
├─ web/                   웹 앱 (Vite + TypeScript) — 방문객 접수(?v=qr) · 관제 ★ · 조치
├─ supabase/schema.sql    Supabase 스키마·RPC·RLS·Storage (2026-09-30 적용)
├─ server/                서버 전체 — TypeScript (Node 24, 타입 제거 실행·빌드 없음)
│  ├─ package.json        의존성 (@anthropic-ai/sdk · docx · pg · dotenv)
│  ├─ worker.ts           에이전트 오케스트레이터
│  ├─ webapi.ts           개발·테스트용 local 대역 API (SQLite, Supabase 흉내)
│  ├─ cli.ts              터미널 명령 (status · cycle · db · todo …)
│  ├─ core/
│  │  ├─ config.ts        라벨·구역·부서·가중치
│  │  ├─ db.ts            SQLite(WAL) / Supabase Postgres 접근 계층
│  │  ├─ llm.ts           에이전트 루프 (직접 구현) ★
│  │  ├─ severity.ts      심각도 계산 (결정적 함수) ★
│  │  ├─ issues.ts        관제 카드 생성·문구 검사
│  │  ├─ privacy.ts       개인정보 마스킹·인젝션 탐지
│  │  ├─ intake.ts · review.ts · admin.ts   접수 · 확인 필요 처리 · 운영자 코드
│  │  ├─ memory.ts        분류 기억 (비슷한 과거 사례, 운영자 지정 우선)
│  │  ├─ rules.ts         local 대역 키워드 규칙 (개발용)
│  │  ├─ tourapi.ts       한국관광공사 TourAPI 연동 (외부 API)
│  │  └─ replay.ts        리플레이 엔진 (배속 재생)
│  ├─ agents/
│  │  ├─ planner.ts       ⓪계획      도구 1개 (이번 주기에 돌릴 단계·창)
│  │  ├─ classifier.ts    ①분류      도구 1개 + 시스템 1개 기억 (기본 prefetch · agent 모드 3개)
│  │  ├─ monitor.ts       ②심각도·감시 도구 4개
│  │  ├─ dispatcher.ts    ③조치      도구 1개 write_request + 시스템 4개 (기본 prefetch · agent 모드 4개, DOCX 생성)
│  │  ├─ supervisor.ts    ④통합      도구 4개 ★ 마지막에 합치는 자리
│  │  └─ common.ts        공용 도구 (축제정보 조회)
│  ├─ scripts/            seed_festival · make_dev_seed · run_all_servers · final_check · testcase_report · measure_* …
│  └─ tests/              단위 테스트 (*.test.ts, `npm --prefix server test`) · attack_check.ts · latency_check.ts
├─ output/                생성된 조치요청서 DOCX
└─ tests/
   └─ testcase_report.md  ← 대표 Test Case 5종 결과 (server/scripts/testcase_report.ts 가 자동 생성)
```

### 심사 배점 대응

| 영역 | 배점 | 이 저장소에서 |
|---|---|---|
| AI Agent 구현성 | 20 | `server/core/llm.ts` 에이전트 루프 · `agent_log` 실행 기록 |
| 기술 구현·완성도 | 20 | E2E 8 / 연동 6 / **안정성·Test Case 6 → `tests/`** |
| 데이터·안전·윤리 | 10 | `server/core/privacy.ts` 마스킹 · 인젝션 가드 · 결정적 판정 |
| 비즈니스 모델 | 10 | `../제출_준비/비즈니스모델.md` |
| (가점) 실사용자 3명 | +1 | `../제출_준비/실사용자_검증_확인서.md` |

### 외부 API — 한국관광공사 TourAPI

- 엔드포인트 `apis.data.go.kr/B551011/KorService2` · 오퍼레이션 `searchFestival2` / `detailCommon2`
- 경남 areaCode = **36**
- 에이전트 도구 `lookup_festival_info` 로 등록 → **심사 'Tool 4점' 근거**
- **실패해도 시스템은 계속 동작**합니다. 캐시 → API → 수기 시드 순으로 떨어집니다
- 출처는 별지2 출처·AI 활용 신고서에 기재

### 2경로 설계

신청서에 **"접수 후 10초 이내 분류·반영"**을 목표로 적었습니다. 접수 경로에
에이전트를 직렬로 태우면 LLM 호출이 누적되어 10초를 넘깁니다. 그래서
경로를 둘로 가릅니다.

```
Fast Path (실시간, 신청서 목표: 접수 후 10초 이내)
  QR 제출 → 접수 파이프라인 → ①분류 에이전트 → 대시보드 반영

Agent Path (배후, 주기 실행)
  ⓪계획 → ②심각도·감시 → ③조치 → ④통합(Supervisor) → 브리핑
```

**목표와 현재 측정의 차이.** 목표는 신청서의 '접수 후 10초 이내'입니다. 현재 측정값은 **CLI 경유 참고값**으로 접수 → 분류 중앙 <!--n:llm_latency_median-->7.5초<!--/n--> · 최대 <!--n:llm_latency_max-->11.3초<!--/n-->(기본 B′, 1건 × 5회, 워커 폴링 포함, `tests/wall_clock_report.md`)입니다. 분류 호출은 3회 → 2회(A안) → 1회(B′)로 줄였습니다. 이전 방식의 값은 결과 파일이 없어 적지 않습니다. **판정 기준은 20회 이상 측정에서 중앙값·p90 모두 10초 이하**(최댓값은 기록만 하고 15초를 넘으면 원인을 적음)이며, 지금 결과는 5회라 아직 판정하지 않습니다. 첫 호출 지연은 준비 호출을 넣어도 CLI 경로(호출마다 새 프로세스)에서는 줄지 않아, 준비 호출은 이제 `anthropic` 일 때만 합니다. API 경로의 효과는 키가 온 뒤 확인합니다. API 직접 호출 기준은 아직 측정하지 못했습니다. 규칙 기반 대역(`local`) 값은 모델 호출이 없어 이 목표의 근거로 쓰지 않습니다.

### 판단은 에이전트, 계산은 함수

`server/core/severity.ts`에는 LLM이 없습니다. 에이전트는 이 함수를 **도구로 호출**만 합니다.

- 같은 입력 → 항상 같은 점수 (**시연 중 사고가 안 남**)
- `formula` 문자열을 함께 반환 → 화면에 계산식이 그대로 노출됨
- 단위 테스트로 검증 가능 (`server/tests/*.test.ts`)

> 발표 한 문장: **"각 에이전트는 스스로 계산하지 않고, 검증 가능한 도구를 호출합니다."**

### 심각도 규칙 (S-01 ~ S-06)

| ID | 규칙 |
|---|---|
| S-01 | 기본점수 = 윈도우 내 빈도 60% + 부정강도 40% |
| S-02 | **안전 관련 ×2.0** ← 조명 9건이 주차 52건을 이기는 근거 |
| S-03 | 급증 ×1.5 (최근 15분 유입률 ≥ 직전 60분 평균 × 2) |
| S-04 | **안전 3건 이상이면 점수와 무관하게 `immediate`** |
| S-05 | `positive`는 심각도 계산에서 제외 |
| S-06 | 미조치 30분 경과 ×1.2 ← 조치 상태가 다음 판정에 되먹임 |

### 경계 규칙 (B-01 ~ B-04) · 확인 필요

한가한 창에서 1건이 100점·즉시·급증이 되던 문제를 막습니다 (할일 D5-25).
값은 `server/core/config.ts` 에 있습니다.

| ID | 규칙 | config |
|---|---|---|
| B-01 | 빈도비 = 건수 ÷ max(창 전체 건수, 10). 창이 10건 미만이어도 비율 항목을 부풀리지 않음 | `MIN_WINDOW_TOTAL = 10` |
| B-02 | 급증은 최근 15분에 3건 이상일 때만 (60분 안에 1건이 늘 4.0배로 잡히던 문제) | `SPIKE_MIN_RECENT = 3` |
| B-03 | 비안전 유형이 5건 미만이면 점수를 79.9 로 자름 (최고 high). formula 끝에 표시 | `NONSAFETY_IMMEDIATE_MIN = 5` · `NONSAFETY_CAP = 79.9` |
| B-04 | 안전 민원(`is_safety`)이 1건이라도 있는 유형은 점수 하한 60 (최소 high). S-04 는 그대로. 혼잡은 밀림·압사·위험 신호가 있을 때만 안전 (D5-59, `SAFETY_LABELS` = {safety}) | `SAFETY_FLOOR = 60` |

**확인 필요(review)**: 분류 신뢰도가 0.3 미만이거나 내용이 없으면 유형을 넣지 않고
`classification.status='review'` 로 저장합니다 (`REVIEW_CONFIDENCE = 0.3`). 모델이 제안한
유형은 `agent_note` 에만 남습니다. review 는 건수·심각도·알림·브리핑·조치요청서 인용에서
빠지고, API(`/api/control`)·CLI 에 개수만 나옵니다.

### 관제 '지금 조치할 일' 카드 (D5-29) · 민원 지우기 (D5-30)

관제는 유형 순위 대신 **카드**(유형×구역)로 "무엇을, 어디서, 무엇부터, 어떻게"를 보여 줍니다.
`server/core/issues.ts` 가 만들고 `issue` 테이블 한 행이 카드 한 장입니다 (`/api/control` 의 `issues[]`).

| 구분 | 누가 | 내용 |
|---|---|---|
| 등급 | 코드 | 유형 등급을 그대로 물려받음. 안전 3건이 세 구역에 흩어져도 세 카드 모두 즉시 |
| 카드 점수 | 코드 | 유형 심각도 × 집중(0.5~1.0, 구역 미상은 0.5 고정) × 최근(0.5~1.0). 식이 카드에 그대로 노출됨 |
| 정렬 | 코드 | 조치 그룹(본 목록 → 조치 중 → 완료; 완료 뒤 새 민원이면 복귀, 요청서 이후 새 구역 카드는 `new_since_request` 로 본 목록에 남김) → 등급 → 안전 민원이 있는 카드 먼저 → 카드 점수 → 마지막 시각 |
| 건수·마지막 시각·최신 민원 | 코드 | 5초마다 LLM 없이 갱신 (`latest_quotes`) |
| 문제 한 줄·해야 할 일 | ④통합 에이전트 | 근거 민원을 읽고 판단·정리(2~4개, 조치마다 근거 민원 id). 결정적 검사를 통과한 것만 저장 |

- 문구는 카드마다 최소 `CARD_TEXT_MIN_INTERVAL`(60초) 간격으로만 다시 쓰고, 등급이나 조치 그룹이 바뀌면 바로 다시 씁니다.
  서명(유형·구역·등급·조치 그룹)이 그대로고 새로 쓸 카드가 없으면 ④ 호출 자체를 건너뜁니다.
- 문구의 근거(`evidence_quotes`)는 문구를 다시 쓸 때만 바뀌고, `latest_quotes` 는 매번 바뀝니다. `text_updated_at` 이 바뀐 카드만 문구가 바뀐 것입니다.
- 저장 전 검사: 조치마다 근거 민원 id(이 카드의 후보 안) · 숫자 금지 · 장소·시설 단어는 이 카드의 민원이나 구역 이름에 있어야 함(`PLACE_WORDS`)
  · 조치가 민원 원문과 연속 12자 이상 같으면 거부(민원이 조치를 조종하지 못하게) · 한글 수사+단위("세 명")도 숫자로 봐서 거부
  · 중단·폐쇄·대피·진입 통제 같은 고위험 표현(`ESCALATION_WORDS`, "통제선"은 제외)은
  안전 유형 + 즉시 등급 카드에서만 허용하고 `needs_judgment`(운영자 판단 필요)를 표시. 실패한 카드는 템플릿('{구역} — {유형} 민원' + 참고 예시 조치)으로 채우고 다음 주기에 다시 시도합니다(같은 서명에서 2번까지).
- `ACTION_CATALOG` 는 프롬프트의 **참고 예시**일 뿐 고르도록 강제하지 않습니다. 조치요청서(③)를 만들 때는 그 유형 카드의 조치를 그대로 넘겨 요청서와 관제의 조치가 같게 합니다.
- 구역을 알 수 없는 민원은 `zone_id=NULL` 로 저장하고 '구역 미상' 카드 한 장으로 모읍니다.
- 운영자가 민원을 지우면(`delete_feedback` RPC) `feedback.deleted_at` 만 채워 숨깁니다. 건수·심각도·알림·브리핑·인용·카드·대기열·유입이 모두 `db.LIVE_FEEDBACK_SQL` 로 제외하고,
  `restore_feedback` 으로 되돌리면 그대로 돌아옵니다 (`/api/control` 의 `deleted` = 지운 개수).

**확인 필요 처리 (D5-32)**: 운영자가 세 가지로 처리합니다 — 유형 지정(`resolve_review`) · 유형 없음으로 닫기(`dismiss_review`, `status='dismissed'`) · 지우기(`delete_feedback`).
되돌리기는 `reopen_review`. 세 RPC 모두 운영자 코드가 필요하고 `status='review'`(되돌리기는 닫은 것·운영자가 지정한 것)일 때만 실행됩니다 — 이미 처리된 민원은 "이미 처리된 민원입니다".
모델 제안은 `classification.suggested_label` 열에 저장되고, 운영자가 처리한 건은 `decided_by='operator'` 로 표시되어 `measure_accuracy` 가 정확도에서 뺍니다.
`/api/control` 의 `review_items[]` 는 안전 의심 먼저·오래된 것 먼저 최대 20건이고, 안전 의심이 15분 넘게 방치되면 알림(`review_safety_stale`)이 한 번 올라갑니다.
`/api/control` 의 feed 항목에는 웹 접수에 한해 `receipt_no`(접수 완료 창의 `W-번호`)가 붙어 민원 번호와 맞춰 볼 수 있고,
`node server/cli.ts db show <번호>` 가 접수부터 분류까지 시각을 보여 줍니다 (`W-38` = 접수번호, `#202`·`202` = 민원 번호).

**접수 검증**: 한글·영문·숫자가 2개 이상이어야 접수됩니다 (`'...'` `'ㅋㅋ'` `'!!!!'` 거부).
`webapi.ts` · `supabase/schema.sql` RPC · `db.insert_feedback` 이 같은 규칙입니다
(`core/privacy.has_content`).

---

## 진행 상황

- [x] **D1** 화면 3종 · SQLite(WAL) · 에이전트 루프 · 심각도 엔진 + 단위 테스트 9건
- [x] **D2** 접수 파이프라인 · ①분류 에이전트 · 개인정보 마스킹 · Test Case 5종
- [x] **D3** ②감시 에이전트 · 알림 · 관광공사 API 연동
- [x] **D4** ③조치(DOCX) · ④통합(브리핑) · **리플레이 엔진** · E2E 관통 ★
- [ ] **D5** (10/3) 오류수정·안정화 — 예외처리, 실행 안정성, 프롬프트 튜닝
- [ ] **D6** (10/4) Test Case 5종 `--live` 수행 · 분류 정확도 측정 · **실사용자 3명(+1점)**
- [ ] **D7** (10/5) 시연영상 3분 · 보고서 5p · 기술설명서 1p · 발표자료 10장
- [ ] **D8** (10/6 오전) 최종 검증 · **12시 전 제출**

### 현재 상태 — Level 2~3

접수 → 분류 → 심각도 → 알림 → 조치요청서(DOCX) → 브리핑까지 **한 줄로 관통**합니다.
개발용 합성 시드 160건 기준으로 **건수 1위(주차/교통 54건, 심각도 3위·보통)와 심각도 1위(안전 11건, 즉시)가 갈리는
역전**이 실제로 재현됩니다 (위 '실시간으로 보기' 표, 2026-10-01 재측정).

### 2인 역할

| | 담당(설계·검토·시연) |
|---|---|
| **A** | 화면 3종, ③조치 에이전트·DOCX, 시연영상·발표자료 |
| **B** | DB·접수 파이프라인, 에이전트 루프, ①분류·②감시·④통합, **심각도 함수**, 리플레이 |

---

## 신규개발분

대회 기간(2026-09-29~10-06)에 새로 만든 산출물. 팀이 설계·지시·검토하고 Claude Code 로 작성했다.

1. 에이전트 5종과 실행 루프·작업 큐(프레임워크 없이 직접 구현), 실시간/배후 2경로 구조
2. 결정적 심각도 함수(규칙 6종·경계 규칙 4종, 계산식 노출)
3. 계획(주기마다 돌릴 단계·창 결정)과 기억(비슷한 과거 사례)
4. 관제 조치 카드와 AI 문구 검사, 확인 필요 처리, 운영자 코드
5. 개인정보 마스킹·프롬프트 인젝션 탐지
6. 부서 매핑과 조치요청서 DOCX 생성
7. 리플레이 엔진, 개발용 합성 시드, 시연용 합성 시나리오
8. 평가·측정 도구(정확도·지연·원가 측정, 문서 숫자 동기화)
9. 웹 앱(접수·관제·조치·QR 만들기·AI 동작 보기), Supabase 연동과 local 대역 API

---

## 비용 주의

`server/core/config.ts`의 `MODEL`은 `claude-opus-5-5`입니다 (100만 토큰당 입력 $4 · 출력 $20).
리플레이를 배속으로 돌리면 호출이 폭증하므로 **분류 캐시가 필수**입니다
(`classify_cache` 테이블, 이미 구현). 같은 문장은 두 번 호출하지 않습니다.

D0에 시드 160건을 미리 한 번 분류해 캐시에 적재해 두면, 시연 중에는 API를
거의 부르지 않고 재생됩니다. **시연 도중 API 지연으로 영상이 망가지는 것을 막는 장치**입니다.

API 호출마다 `agent_log` 에 `api_call` 행(토큰 수·응답 모델)이 남습니다.
`node server/scripts/measure_cost.ts` 로 민원 1건 처리 원가를 계산합니다.

비용을 더 줄이려면 분류 에이전트부터 `claude-sonnet-5-5` 등으로 낮춰 보되,
`server/scripts/measure_accuracy.ts --backend anthropic` 로 정확도를 먼저 비교하세요.
모델을 바꾸면 `config.PRICE_PER_MTOK` 에 단가도 넣어야 원가가 계산됩니다.

---

## 데이터·개인정보

- 접수 폼은 **이름·연락처를 받지 않습니다.** 구역 정보와 민원 내용만 저장합니다.
- 리플레이 시드는 **개발용 합성 데이터**(`seed/dev_sample.csv`)입니다. 실제 리뷰는 수집하지 않습니다(팀 결정). 크롤링도 하지 않습니다.
- 사용한 AI 도구·오픈소스·외부 API 출처는 **별지2 출처·AI 활용 신고서**에 기재합니다.

## 개발 상세 (개발완료보고서에서 옮김, 2026-10-01)

보고서를 5쪽에 맞추며 뺀 내용입니다. 수치의 기준은 보고서 4장 표와 같습니다.

**개발계획서와 달라진 점 — 자세히**
- 화면: Streamlit → 웹(Vite + TypeScript) + Supabase (2026-10-01). ①실시간 반영 — 바뀐 부분만 다시 그림(Supabase Realtime, 키가 없으면 `webapi.ts` SSE). ②모바일 접수 — 휴대폰 폭 접수 화면과 구형 브라우저용 빌드. ③운영자 코드 보호 — 관리자 동작을 서버 RPC 에서 코드로 막음. ④배포 — 정적 웹 빌드 + Supabase 라 앱 서버 불필요.
- 서버 언어: Python → TypeScript(Node 24) (2026-10-01). 모듈 구조·함수 이름·동작을 1:1 로 옮기고, 단위 테스트와 Test Case 5종을 같은 입력·기대값으로 옮김. Python 판과 TS 판을 개발용 시드 160건으로 한 바퀴 돌려 차이 0건을 확인한 뒤 Python 코드를 지움.

**심각도 규칙의 근거 (방향만 — 숫자는 설계값, 근거 목록은 `제출_준비/심각도_기준_양식.md` 9절)**
- 위험 신호가 있는 혼잡 = 안전(S-02): 「재난 및 안전관리 기본법」 제3조 제1호 나목은 다중운집인파사고를 사회재난에 넣었다(행안부 「다중운집인파사고 안전관리 가이드라인」 2024.9, p.1). 신호 없는 대기·붐빔은 불편 민원이다. 유등축제는 순간 최대 관람객 1천 명 이상·수면 개최·불꽃놀이로 「재난안전법 시행령」 제73조의9 안전관리계획 대상에도 해당한다.
- 인파 단계와 급증(S-03·S-04): 가이드라인은 인파 위험을 여유·주의·위험 3단계로 나누고 '주의'(흐름 정체)에서 안내방송·요원 투입·일방통행을 한다(p.11). 민원으로는 밀집도를 잴 수 없어 숫자는 옮기지 않았다. 인파관리지원시스템은 평소 대비 비율로 단계를 나눈다(「지역축제장 안전관리 매뉴얼(2024)」 p.82, 200% 이상 '혼잡'). 급증 '직전 평균의 2배'를 이 200% 에 맞춘 것은 우리 해석이다.
- 미조치 30분(S-06): 「민원 처리에 관한 법률 시행령」 제19조는 '즉시' 처리 민원을 3근무시간 이내로 정한다. 현장 안전은 더 빨라야 해서 30분을 설계값으로 둔다(법이 30분을 정한 것은 아니다).
- 고위험 조치는 사람이 판단: 진입통제·대피 유도·도로 통제는 가이드라인 '위험' 단계 조치다. 재난문자는 「재난문자방송 기준 및 운영규정」(행안부 예규 제361호) 제9조에 따라 정해진 기관이 보낸다. 교통통제·대피 유도는 경찰·소방 몫이라 요청서에는 협조 요청으로만 적는다(재난안전법 제66조의11 제5항).
- 인파관리지원시스템도 지자체가 현장에 맞게 임계치를 정한다(행안부 2023.12.27). 실제 운영 데이터가 쌓이면 가중치를 다시 맞춘다.

**개발 중 잡은 버그와 사고**
- 전화번호 마스킹 누락(정규식 `\b` 가 한글 앞에서 경계가 안 됨) · 건수는 누적, 심각도는 60분 창으로 서로 다른 모집단 비교 · 조치요청서 저장 실패(라벨 `/` 가 경로로 해석) · 대역에서 TC4 거짓 통과 · 배후 에이전트 때문에 웹 요청·새 민원이 분 단위로 지연(접수·분류·요청서·에이전트 분리로 해결) · 같은 유형 요청서가 여럿일 때 가장 오래된 상태를 읽은 오판(실제 모델이 브리핑에서 먼저 짚음) · 웹 API 포트 중복 실행 · 지시문 탐지가 "다들 무시하고 새치기" 같은 정상 민원을 잡던 오탐(지시 대상+명령 조합으로 좁히고 정상 문장 묶음을 테스트로 고정) · 카드 문구 검사가 정당한 표현("어둡다"→"임시 조명")을 막던 문제(동의어 인정).
- 복원 사고: PC 재시작으로 소스 파일 2개가 NUL 바이트로 바뀌어 웹 API·워커가 뜨지 않았다(Python 시절). 컴파일 캐시의 상수와 작업 기록으로 복원해 테스트로 검증했고, 이후 git 저장소(비공개 원격)를 도입했다.

**분류 호출 최적화 — 자세히**
- 분류는 원래 모델 호출이 3번(대기 조회 → 저장 → "저장했습니다" 보고문)이었다. 대기 민원이 모두 저장되면 코드가 종료를 판단(`done_when`)해 보고 호출을 없앴다(A안). 대기 민원을 코드가 프롬프트에 넣어 1번으로 줄이는 B′(`CLASSIFY_MODE=prefetch`)를 만들었고, 2026-10-01(D5-69)부터 **B′ 가 기본**이다(호출 1회). `CLASSIFY_MODE=agent` 한 줄로 A 로 되돌린다. 두 모드를 같은 조건으로 비교한 결과 파일은 없다. 현재 정확도는 <!--n:accuracy-->96.9%<!--/n-->(<!--n:accuracy_n-->31/32<!--/n-->, `tests/accuracy_report.md`, CLI 경유 참고값)이다.
