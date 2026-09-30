# 실시간 축제 민원 자동분류 AI Agent

제4회 경남 AI·SW 경진대회 · 대학부 · 신청분야 05 (지역혁신·공공서비스)

---

## 실행

```bash
pip install -r requirements.txt

# 1) API 키 설정
cp .env.example .env      # ANTHROPIC_API_KEY 채우기
#   또는  ant auth login   (프로필을 SDK가 자동으로 읽습니다)

# 2) 화면
streamlit run app.py

# 3) 에이전트 워커 — 별도 터미널에서
python worker.py                      # Fast 3초 / Agent 60초
python worker.py --agent-interval 20  # 시연용 (반응 빠르게)
python worker.py --no-agents          # ①분류만 (비용 절약)
```

### 터미널 버전

브라우저 없이 같은 DB를 다룹니다. Streamlit과 동시에 켜도 됩니다.

```bash
python cli.py watch --drive             # 실시간 모니터 (워커 없이 단독 구동)
python cli.py status                    # 현재 상태 스냅샷
python cli.py submit "진입로가 어두워요"  # 민원 접수
python cli.py cycle                     # ①②③④ 한 바퀴
python cli.py replay start --speed 300  # 리플레이
python cli.py db tables | log | feed    # DB 조회
python cli.py check                     # 백엔드·API 키 확인
python cli.py reset --all               # 초기화
```

### 실시간으로 보기

```bash
python cli.py reset --all
python cli.py replay start --speed 20000
python cli.py --window 5835 watch --drive --interval 2
```

화면이 2초마다 다시 그려지면서 민원이 쌓이고 순위가 바뀌는 과정이 보입니다.
`--drive`는 워커 없이 리플레이 투입과 분류까지 이 명령이 직접 수행한다는 뜻입니다.
`--once`를 붙이면 한 프레임만 출력합니다 (캡처·문서용).

개발용 합성 시드를 재생한 화면 예시 (규칙 기반 대역 분류 — AI 모델 분류가 아님):

```
  건수 순위                     심각도 순위
  ──────────────────────────────────────────────────────────────
  주차/교통      54 ██████████  !!안전         93.2 ██████████
  가격/바가지     30 ██████      !!혼잡         70.4 ████████
  화장실        29 █████         주차/교통      57.2 ██████
  긍정         18 ███           화장실        41.6 ████
  안전         11 ██            가격/바가지     39.8 ████
  안내/동선      10 ██            안내/동선      26.9 ███
  혼잡          3 █

  ★ 역전  건수 1위 주차/교통(54건) → 심각도 1위 안전(11건)
    (0.08×60 + 0.85×40) × 안전2.0 × 급증1.0 × 미조치1.2 = 93.2
```

(개발용 합성 시드 160건 · 규칙 기반 대역 분류 · 창 5835분. 분류 신뢰도가 낮은 5건은
"확인 필요"로 빠져 있어 창 건수가 155건입니다.)

`--window` 로 심각도 창을 조정합니다. 기본 60분이며, 창 밖 데이터가 많으면
상태 화면이 알려줍니다.

### 시연·개발 (API 키 없이도 됨)

```bash
python scripts/make_dev_seed.py       # 개발용 샘플 120건 생성
python cli.py demo --stub             # 투입 → 분류 → 판정까지 한 번에
```
그 다음 **조치 화면 → 리플레이 → ▶ 시작**을 누르면 민원이 배속으로 쏟아지고,
관제 화면에서 **건수 1위(주차)와 심각도 1위(안전)가 갈리는 장면**을 볼 수 있습니다.

> `scripts/stub_classify.py` 는 **개발 도구이지 제품이 아닙니다.**
> 제출물에서 분류는 ①분류 에이전트가 수행하며, 스텁 처리분은
> `agent_note='STUB(개발용)'` 으로 표시됩니다.

브라우저에서 사이드바의 **접수 → 관제 → 조치** 순으로 확인하세요.
접수 화면에서 민원을 넣으면 워커가 3초 안에 집어가고, 관제 화면이 5초마다 갱신됩니다.

관광공사 API (선택):
```bash
# .env 에 TOURAPI_KEY 를 넣은 뒤
python scripts/seed_festival.py --list        # 경남 축제 목록
python scripts/seed_festival.py --pick 유등    # 대상 축제 설정
```
키가 없어도 시스템은 그대로 동작합니다 (`core/config.py`의 수기 시드 사용).

테스트:
```bash
python tests/test_severity.py        # 심각도 엔진 단위 9건
python tests/test_scenarios.py       # 대표 Test Case 5종 (제출 필수)
python tests/test_scenarios.py --live  # 실제 LLM 호출 포함
```
`tests/testcase_report.md`가 생성됩니다. **이게 제출용 테스트 증거입니다.**

---

## 할 일 자동 갱신

`../할일.md` 는 손으로 관리하지 않습니다. 시스템 상태를 직접 확인해 다시 그립니다.

```bash
python cli.py todo             # 지금 상태로 다시 그리기
python cli.py todo --show      # 파일에 쓰지 않고 출력만
python cli.py todo --watch     # 파일을 고칠 때마다 즉시 재판정
python worker.py               # 에이전트가 한 바퀴 돌 때마다 자동 갱신
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

Streamlit 과 같은 DB 를 보는 단일 페이지 화면입니다. 워커는 그대로 돌리고,
웹은 실시간 구독으로 바뀐 부분만 다시 그립니다.

### 키 없이 — local 대역 (지금 상태)

LLM 대역과 같은 방식입니다. `web/.env` 가 없으면 웹은 `webapi.py`(SQLite 위에서
Supabase RPC·Realtime·Storage 를 흉내 내는 서버)에 붙습니다. 헤더에 `local 대역` 이 표시됩니다.

```bash
python worker.py                 # 터미널 1 — 웹 접수 수거 · 분류 · 조치요청서 작성
python webapi.py                 # 터미널 2 — local 대역 API (127.0.0.1:8765)
cd web && npm install && npm run dev   # 터미널 3 — http://localhost:5173
```

| Supabase | local 대역 (`webapi.py`) |
|---|---|
| PostgREST 읽기 | `GET /api/zones` · `/api/control` · `/api/action` |
| RPC 6개 (`schema.sql`) | `POST /api/rpc/<이름>` — 관리자 동작 5개는 운영자 코드 필요(아래 '운영자 코드'), 검증 규칙 동일 (한글·영문·숫자 2개 이상 · 500자 이하 · 구역 존재 · `department_map` 기준 · 없는 민원 id 는 오류 · 서울 시각) |
| Realtime | `GET /api/events` (SSE, 1초 지문 비교) |
| Storage `docs` 버킷 | `GET /api/docs/<파일명>` — `output/` 의 DOCX (경로 탈출 차단) |

`webapi.py` 는 지우지 않습니다. 키가 들어가면 웹이 더 이상 부르지 않을 뿐입니다.

### Supabase 로 전환 — 키가 생기면 (코드 수정 없음)

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
pip install -r requirements.txt
python cli.py db tables          # Supabase 테이블이 보이면 워커 연결 OK
python worker.py
cd web && npm run dev            # 헤더가 "실시간 · Supabase" 로 바뀌면 웹 연결 OK
python cli.py todo               # D5-6 · D5-9 가 자동으로 체크됩니다
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
python worker.py                       # 터미널 1
python webapi.py                       # 터미널 2 (각 터미널마다 위 한 줄을 먼저)
cd web; npm run phone                  # 터미널 3 — 폰은 http://<PC IP>:4173/?v=qr
```

운영자 코드(`ADMIN_CODE`)는 그대로 `.env` 에서 읽습니다. 참여자가 넣은 민원은 `python cli.py db show <번호>` 로 추적합니다
(웹 접수 창의 `W-번호` 도 같은 번호로 찾힙니다). `SUPABASE_DB_URL` 이 켜져 있으면 DB 가 Supabase 이므로 비워 두고 돌립니다.
검증용 문장은 사람이 직접 쓴 것이라 합성이 아닙니다 — 시연용 합성 시나리오와 DB 파일을 섞지 마세요.

**시연 영상용 합성 시나리오**: `python scripts/demo_scenario.py --dry-run` 으로 계획만 보고,
`python scripts/demo_scenario.py --reset --lead 120` 으로 `output/demo_festival.db` 에 배경 가상 민원 24건(`source='demo'`)을 넣은 뒤
T+40·T+50초에 유등터널 혼잡 2건을 예약 투입합니다 (운영 DB 는 거부). 전부 지어낸 문장이라 영상에 합성임을 밝혀야 합니다.

### 운영자 코드 (관리자 동작 보호, D5-31)

로그인이 없어서, 코드가 없으면 주소를 아는 누구나 민원을 지우거나 조치 상태를 바꿀 수 있습니다.
그래서 아래 네 가지는 **운영자 코드**가 맞을 때만 실행됩니다. 방문객이 쓰는 것은 접수(`submit_feedback`) 하나뿐이고 코드가 필요 없습니다.

| 관리자 동작 | local 대역(`webapi.py`) · Streamlit | Supabase RPC |
|---|---|---|
| 민원 지우기·되돌리기 | `delete_feedback` · `restore_feedback` | 같은 이름 + `p_code` |
| 조치 상태 변경 | `set_action_status` | 같은 이름 + `p_code` |
| 조치요청서 생성 | `request_doc` | 같은 이름 + `p_code` |
| 코드 확인(입력 창용) | `check_admin` | 같은 이름 + `p_code` |

**코드 정하는 법 — 값은 직접 정해 아래 두 곳에만 넣습니다. 채팅·문서·커밋에 적지 마세요.** 길고 추측하기 어려운 값이 좋습니다.

1. **local 대역·Streamlit**: `festival_agent/.env` 의 `ADMIN_CODE=` 뒤에 값을 넣고 `webapi.py` 와 Streamlit 을 다시 켭니다.
   - 비워 두면 관리자 동작이 **전부 거부**됩니다 (열린 채로 시작하지 않음). `webapi.py` 시작 때 경고가 나옵니다.
   - 웹은 요청 헤더 `X-Admin-Code` (또는 본문 `p_code`)로 보냅니다. 없으면 401, 틀리면 401, 코드 미설정이면 403, 잠기면 429 입니다.
   - Streamlit 조치 화면은 사이드바에 코드를 넣어야 요청서 생성·상태 변경·리플레이 조작이 열립니다 (조회·DOCX 내려받기는 코드 없이).
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
(원문은 접수 때 마스킹됨). 휴대폰으로 시연하려고 `webapi.py` 를 `--host 0.0.0.0` 으로 열면 같은 와이파이의 누구나 닿으므로 그때 이 코드가 실제로 필요해집니다.
키가 생기면 Supabase Auth(가입 차단) + RPC 안의 `auth.uid()` 검사로 바꿀 수 있습니다.

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
구독 사용량을 쓰므로 worker 상시 구동보다 `cli.py cycle` 1회·`measure_accuracy --limit` 소량으로 확인하세요. 지금 어떤 백엔드로 도는지는
`python cli.py check`, `python cli.py status`, 관제 화면 사이드바에 표시됩니다.

### local 대역이 하는 일

에이전트 4종 모두 `local` 대역을 가집니다. 대역은 **같은 도구를 같은 순서로**
호출하므로 DB에 남는 결과와 `agent_log` 기록이 실제 경로와 같은 모양입니다.
다만 판단이 없습니다.

| 에이전트 | 실제 모델 | local 대역 |
|---|---|---|
| ①분류 | 문장을 읽고 유형·강도·안전여부 판정 | `core/rules.py` 키워드 규칙 |
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
├─ app.py                 홈 (상태 확인)
├─ pages/
│  ├─ 1_접수.py           방문객 QR 접수 폼 (모바일)
│  ├─ 2_관제.py           실시간 대시보드 ★
│  └─ 3_조치.py           부서별 조치요청서
├─ core/
│  ├─ config.py           라벨·구역·부서·가중치
│  ├─ db.py               SQLite(WAL) 접근 계층
│  ├─ llm.py              에이전트 루프 (직접 구현) ★
│  ├─ severity.py         심각도 계산 (결정적 함수) ★
│  ├─ privacy.py          개인정보 마스킹·인젝션 탐지
│  └─ tourapi.py          한국관광공사 TourAPI 연동 (외부 API)
│  └─ replay.py           리플레이 엔진 (배속 재생)
├─ agents/
│  ├─ classifier.py       ①분류      도구 3개
│  ├─ monitor.py          ②심각도·감시 도구 4개
│  ├─ dispatcher.py       ③조치      도구 4개 (DOCX 생성)
│  ├─ supervisor.py       ④통합      도구 3개 ★ 마지막에 합치는 자리
│  └─ common.py           공용 도구 (축제정보 조회)
├─ scripts/
│  ├─ seed_festival.py    D0 축제 시드 (관광공사 API)
│  ├─ make_dev_seed.py    개발용 샘플 민원 생성
│  └─ stub_classify.py    개발용 스텁 분류 (제품 아님)
├─ worker.py              에이전트 오케스트레이터
├─ output/                생성된 조치요청서 DOCX
└─ tests/
   ├─ test_severity.py    단위 9건
   ├─ test_scenarios.py   대표 Test Case 5종 (제출 필수)
   └─ testcase_report.md  ← 테스트 증거 (자동 생성)
```

### 심사 배점 대응

| 영역 | 배점 | 이 저장소에서 |
|---|---|---|
| AI Agent 구현성 | 20 | `core/llm.py` 에이전트 루프 · `agent_log` 실행 기록 |
| 기술 구현·완성도 | 20 | E2E 8 / 연동 6 / **안정성·Test Case 6 → `tests/`** |
| 데이터·안전·윤리 | 10 | `core/privacy.py` 마스킹 · 인젝션 가드 · 결정적 판정 |
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
에이전트 4개를 직렬로 태우면 LLM 호출이 누적되어 10초를 넘깁니다. 그래서
경로를 둘로 가릅니다.

```
Fast Path (실시간, 목표 3초)
  QR 제출 → 접수 파이프라인 → ①분류 에이전트 → 대시보드 반영

Agent Path (배후, 주기 실행)
  ②심각도·감시 → ③조치 → ④통합(Supervisor) → 브리핑
```

**목표와 현재 측정의 차이.** Fast Path 3초는 설계 목표입니다. 현재 측정값은 Claude Code CLI 경유로 접수 → 분류 24초, 에이전트가 도는 중 접수 → 분류 20.5초(유입 표시는 0.5초)입니다. 목표 3초와 신청서 10초에 못 미칩니다. API 직접 호출 기준은 아직 측정하지 못했습니다. 규칙 기반 대역(`local`)의 3.1초는 모델 호출이 없는 값이라 이 목표의 근거로 쓰지 않습니다.

### 판단은 에이전트, 계산은 함수

`core/severity.py`에는 LLM이 없습니다. 에이전트는 이 함수를 **도구로 호출**만 합니다.

- 같은 입력 → 항상 같은 점수 (**시연 중 사고가 안 남**)
- `formula` 문자열을 함께 반환 → 화면에 계산식이 그대로 노출됨
- 단위 테스트로 검증 가능 (`tests/test_severity.py`)

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
값은 `core/config.py` 에 있습니다.

| ID | 규칙 | config |
|---|---|---|
| B-01 | 빈도비 = 건수 ÷ max(창 전체 건수, 10). 창이 10건 미만이어도 비율 항목을 부풀리지 않음 | `MIN_WINDOW_TOTAL = 10` |
| B-02 | 급증은 최근 15분에 3건 이상일 때만 (60분 안에 1건이 늘 4.0배로 잡히던 문제) | `SPIKE_MIN_RECENT = 3` |
| B-03 | 비안전 유형이 5건 미만이면 점수를 79.9 로 자름 (최고 high). formula 끝에 표시 | `NONSAFETY_IMMEDIATE_MIN = 5` · `NONSAFETY_CAP = 79.9` |
| B-04 | 안전 유형은 1건이라도 점수 하한 60 (최소 high). S-04 는 그대로 | `SAFETY_FLOOR = 60` |

**확인 필요(review)**: 분류 신뢰도가 0.3 미만이거나 내용이 없으면 유형을 넣지 않고
`classification.status='review'` 로 저장합니다 (`REVIEW_CONFIDENCE = 0.3`). 모델이 제안한
유형은 `agent_note` 에만 남습니다. review 는 건수·심각도·알림·브리핑·조치요청서 인용에서
빠지고, API(`/api/control`)·CLI 에 개수만 나옵니다.

### 관제 '지금 조치할 일' 카드 (D5-29) · 민원 지우기 (D5-30)

관제는 유형 순위 대신 **카드**(유형×구역)로 "무엇을, 어디서, 무엇부터, 어떻게"를 보여 줍니다.
`core/issues.py` 가 만들고 `issue` 테이블 한 행이 카드 한 장입니다 (`/api/control` 의 `issues[]`).

| 구분 | 누가 | 내용 |
|---|---|---|
| 등급 | 코드 | 유형 등급을 그대로 물려받음. 안전 3건이 세 구역에 흩어져도 세 카드 모두 즉시 |
| 카드 점수 | 코드 | 유형 심각도 × 집중(0.5~1.0, 구역 미상은 0.5 고정) × 최근(0.5~1.0). 식이 카드에 그대로 노출됨 |
| 정렬 | 코드 | 조치 그룹(본 목록 → 조치 중 → 완료; 완료 뒤 새 민원이면 복귀, 요청서 이후 새 구역 카드는 `new_since_request` 로 본 목록에 남김) → 등급 → 안전 계열(안전·혼잡) 먼저 → 카드 점수 → 마지막 시각 |
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
`python cli.py db show <번호>` 가 접수부터 분류까지 시각을 보여 줍니다 (`W-38` = 접수번호, `#202`·`202` = 민원 번호).

**접수 검증**: 한글·영문·숫자가 2개 이상이어야 접수됩니다 (`'...'` `'ㅋㅋ'` `'!!!!'` 거부).
`webapi.py` · `supabase/schema.sql` RPC · `db.insert_feedback` 이 같은 규칙입니다
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
개발용 시드 120건 기준으로 **건수 1위(주차 48건)와 심각도 1위(안전 6건)가 갈리는
역전**이 실제로 재현됩니다.

```
건수 순위                심각도 순위
1 주차/교통  48건        1 안전       100.0  immediate   ← 6건인데 1위
2 화장실    20건        2 혼잡        92.3  immediate
3 가격     19건        3 주차/교통    76.0  high        ← 48건인데 3위
```
근거: `(0.06×60 + 0.85×40) × 안전2.0 × 급증1.5 × 미조치1.0 = 100.0`

### 2인 역할

| | 담당 |
|---|---|
| **A** | 화면 3종, ③조치 에이전트·DOCX, 시연영상·발표자료 |
| **B** | DB·접수 파이프라인, 에이전트 루프, ①분류·②감시·④통합, **심각도 함수**, 리플레이 |

---

## 비용 주의

`core/config.py`의 `MODEL`은 `claude-opus-5-5`입니다 (100만 토큰당 입력 $4 · 출력 $20).
리플레이를 배속으로 돌리면 호출이 폭증하므로 **분류 캐시가 필수**입니다
(`classify_cache` 테이블, 이미 구현). 같은 문장은 두 번 호출하지 않습니다.

D0에 시드 200건을 미리 한 번 분류해 캐시에 적재해 두면, 시연 중에는 API를
거의 부르지 않고 재생됩니다. **시연 도중 API 지연으로 영상이 망가지는 것을 막는 장치**입니다.

API 호출마다 `agent_log` 에 `api_call` 행(토큰 수·응답 모델)이 남습니다.
`python scripts/measure_cost.py` 로 민원 1건 처리 원가를 계산합니다.

비용을 더 줄이려면 분류 에이전트부터 `claude-sonnet-5-5` 등으로 낮춰 보되,
`scripts/measure_accuracy.py --backend anthropic` 로 정확도를 먼저 비교하세요.
모델을 바꾸면 `config.PRICE_PER_MTOK` 에 단가도 넣어야 원가가 계산됩니다.

---

## 데이터·개인정보

- 접수 폼은 **이름·연락처를 받지 않습니다.** 구역 정보와 민원 내용만 저장합니다.
- 리플레이 시드는 공개된 축제 리뷰를 수기 수집·정제한 것이며, **크롤링하지 않습니다.**
- 사용한 AI 도구·오픈소스·외부 API 출처는 **별지2 출처·AI 활용 신고서**에 기재합니다.
