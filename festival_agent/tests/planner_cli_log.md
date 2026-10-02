# 계획 에이전트 실행 기록 (실제 모델 · Claude Code CLI 경유)

- 측정 2026-10-01 09:07 · 백엔드 `claude_code` (CLI 경유 참고값) · 임시 SQLite(운영 DB 미사용) · `node server/worker.ts --once` 한 바퀴(에이전트 포함)
- 민원은 시연용으로 지어낸 가상 민원 29건(source=demo). 비밀값·파일 경로는 가렸다.
- 이번 주기에 계획 에이전트가 실제 모델을 **1회** 불렀고, 모델이 `plan_cycle` 도구를 호출해 계획을 남겼다 (아래 `plan_cycle` 줄).

## 계획 에이전트(planner) 기록

| 시각 | 동작 | 지연 | 토큰(입력→출력) | 입력 요약 | 결과 요약 | 이유 |
|---|---|---|---|---|---|---|
| 09:04:49 | `cli_call` | 6885 ms | 2549→369 | 이번 주기 계획을 세워줘. 상황(건수·등급만, 민원 내용 없음): {"window_min":60,"counts_window":{"parking":4,"guide":3,"restroom":2,"pr… | success · $0.0278 | claude-opus-5-5 |
| 09:04:49 | `plan` | - | - | {"window_min":15,"focus_labels":["parking","guide"],"run_dispatcher":true,"run_supervisor":true} | {"window_min":15,"must_run":["classify","monitor"],"focus_labels":["parking","guide"],"run_dispatcher":true,"run_supervisor":true,"override… | 주차·안내 유형이 높음 등급으로 최근 15분 사이 급증해 짧은 창으로 다시 확인하고, 요청서 대기 건과 브리핑 뒤 새로 분류된 민원이 있어 조치·통합 에이전트를 모두 부른다. |
| 09:04:49 | `plan_cycle` | - | - | {"window_min":15,"focus_labels":["parking","guide"],"run_dispatcher":true,"run_supervisor":true,"reason":"주차·… | {"ok":true,"plan":{"window_min":15,"must_run":["classify","monitor"],"focus_labels":["parking","guide"],"run_dispatcher":true,"run_supervis… | 주차·안내 유형이 급증했고 높음 등급이라 요청서 대기 중이다. 마지막 브리핑 뒤 새로 분류된 민원도 10건 있다. |

## 이 주기의 모델(CLI) 호출 합계

| 에이전트 | 호출 | 지연 합 | 입력 토큰 | 출력 토큰 |
|---|---|---|---|---|
| classifier | 1 | 9854 ms | 1149 | 686 |
| dispatcher | 2 | 22491 ms | 3037 | 1346 |
| monitor | 9 | 85698 ms | 13204 | 3684 |
| planner | 1 | 6885 ms | 2549 | 369 |
| supervisor | 2 | 40662 ms | 6957 | 3280 |

## 조치 에이전트(dispatcher) — 요청서 만드는 데 걸린 시간

- 이번 주기: 요청서 **2건**을 만드는 데 모델(CLI) 호출 **2회 · 22.5초** (요청서 1건당 1.0회 · 11.2초, 입력 3037 · 출력 1346 토큰)
- 이전 측정(요청서 2건): 6회 · 67.0초 → 이번 2회 · 22.5초

## 워커 콘솔 (이 주기의 흐름)

```
[worker] 시작 · Fast 1s · Agent 60s
[worker] 처리 29건
[worker] Agent Path 실행
계획 창 15분 · 집중 [parking,guide] · ③O ④O — 주차·안내 유형이 높음 등급으로 최근 15분 사이 급증해 짧은 창으로 다시 확인하고, 요청서 대기 건과 브리핑 뒤 새로 분류된 민원이 있어 조치
②감시 가장 심각한 유형은 주차/교통이에요. 최근 60분 동안 4건으로 급증해 등급이 높음이고, 안전 관련 민원은 없지만 건수와 급증 정도 모두 가장 커서 안내/동선(3건, 급증, 높음)과 함께 급증 알림을 올렸어요.
②재확인 15분 · 가장 심각한 유형은 주차/교통이며, 최근 15분 동안 3건으로 급증해 등급이 '높음'입니다. 안내/동선도 3건 급증·'높음'으로 비슷하지만 판정에서는 주차/교통이 더 위에 놓였고,
③조치 교통과 조치요청서 생성 (인용 4건) — [경로]
③조치 관광진흥과 조치요청서 생성 (인용 3건) — [경로]
④통합 지금 최우선은 진주교 남단 주차장 만차·진입로 정체입니다. 주차/교통 민원이 최근 60분 동안 4건으로 급증해 등급이 높음이고, 건수와 심각도 모두 1위입니다. 교통과에 조치 요청은 이미 들어갔지만 아직 요청 단계일 뿐이니, 현장에서 진입로 수신호 요원 배치와 임시주차장 위치 안내부터
```
