# agent 모드 한 바퀴 로그 (실제 모델 · Claude Code CLI 경유)

- 측정 2026-10-01 09:20 · 백엔드 `claude_code` (CLI 경유 참고값) · 임시 SQLite(운영 DB 미사용) · `node server/worker.ts --once` 한 바퀴 · 걸린 시간 약 170초
- 모드: `CLASSIFY_MODE=agent` · `DISPATCH_MODE=agent` · `MONITOR_MODE=agent`(기본) · 통합은 항상 agent. 에이전트가 필요한 도구를 **모델이 직접 골라** 부른다.
- 민원은 시연용으로 지어낸 가상 민원 6건(source=demo). 비밀값·파일 경로는 가렸다.

## 입력 민원과 분류 결과

| 구역 | 민원(가상) | 분류 | 안전 | 신뢰도 | 상태 |
|---|---|---|---|---|---|
| 촉석루 일원 | 촉석루 계단 조명이 꺼져 있어서 내려가다가 미끄러질 뻔했어요 | safety | 예 | 0.9 | done |
| 유등터널 | 유등터널 안에서 사람들이 한꺼번에 몰려서 앞으로 나갈 수가 없어요 | crowd | 예 | 0.85 | done |
| 유등터널 | 터널 입구에 사람이 계속 들어와서 안쪽이 너무 붐비고 떠밀려요 | crowd | 예 | 0.9 | done |
| 진주교 남단 주차장 | 주차장이 벌써 만차라서 한참을 돌다가 겨우 자리를 찾았어요 | parking | - | 0.95 | done |
| 임시 화장실 A | 임시 화장실 앞에 줄이 너무 길어서 삼십 분이나 기다렸어요 | restroom | - | 0.95 | done |
| 먹거리장터 | 좀 그랬어요 | (유형 없음) | - | 0.1 | review |

## 에이전트별 모델(CLI) 호출 수와 걸린 시간

| 에이전트 | 모델 호출 | 모델 지연 합 | 호출 1회 평균 | 입력 토큰 | 출력 토큰 | 모델이 고른 도구 호출 |
|---|---|---|---|---|---|---|
| ⓪ 계획 (planner) | 1 | 9.4초 | 9.4초 | 832 | 582 | 1 |
| ① 분류 (classifier) | 2 | 15.9초 | 7.9초 | 4039 | 756 | 7 |
| ② 감시 (monitor) | 6 | 47.5초 | 7.9초 | 7232 | 2385 | 11 |
| ③ 조치 (dispatcher) | 6 | 60.9초 | 10.2초 | 9138 | 2964 | 8 |
| ④ 통합 (supervisor) | 2 | 36.5초 | 18.3초 | 2339 | 2978 | 4 |
| **합계** | **17** | **170.3초** | 10.0초 | 23580 | 9665 | 31 |

모델 지연 합은 CLI 호출을 순서대로 이어 부른 시간이라, 한 바퀴 전체 시간(약 170초)에 가깝다. 분류(①)와 접수 수거는 별도 루프지만 `--once` 는 순서대로 한 번씩만 돈다.

## 모델이 고른 도구 호출 순서 (시간순)

각 줄은 모델이 부른 도구 1회다(계획이 정해진 뒤 코드가 남기는 `plan` 기록 줄은 모델의 도구 호출이 아니라서 뺐다). '이유'는 도구 인자로 모델이 직접 적은 판단 이유(없으면 -).

| # | 시각 | 에이전트 | 도구 | 입력 | 결과 | 이유 |
|---|---|---|---|---|---|---|
| 1 | 09:20:07 | classifier | `get_pending` | {"limit":20} | [{"id":1,"raw_text":"촉석루 계단 조명이 꺼져 있어서 내려가다가 미끄러질 뻔했어요","zone":"촉석루 일원","ingested_at":"2026-10-01T09:20:00"},{"id":2,"r… | 대기 민원 조회 |
| 2 | 09:20:17 | classifier | `save_classification` | {"feedback_id":1,"label":"safety","sentiment":-0.7,"is_safety":true,"confidence":0.9,"note":"계단 조명이… | {"ok":true,"feedback_id":1,"label":"safety"} | 6건 모두 분류 저장 요청 |
| 3 | 09:20:17 | classifier | `save_classification` | {"feedback_id":2,"label":"crowd","sentiment":-0.6,"is_safety":true,"confidence":0.85,"note":"터널 안 인… | {"ok":true,"feedback_id":2,"label":"crowd"} | 6건 모두 분류 저장 요청 |
| 4 | 09:20:17 | classifier | `save_classification` | {"feedback_id":3,"label":"crowd","sentiment":-0.7,"is_safety":true,"confidence":0.9,"note":"입구로 계속 … | {"ok":true,"feedback_id":3,"label":"crowd"} | 6건 모두 분류 저장 요청 |
| 5 | 09:20:17 | classifier | `save_classification` | {"feedback_id":4,"label":"parking","sentiment":-0.5,"is_safety":false,"confidence":0.95,"note":"주차장… | {"ok":true,"feedback_id":4,"label":"parking"} | 6건 모두 분류 저장 요청 |
| 6 | 09:20:17 | classifier | `save_classification` | {"feedback_id":5,"label":"restroom","sentiment":-0.6,"is_safety":false,"confidence":0.95,"note":"임시… | {"ok":true,"feedback_id":5,"label":"restroom"} | 6건 모두 분류 저장 요청 |
| 7 | 09:20:17 | classifier | `save_classification` | {"feedback_id":6,"label":"guide","sentiment":-0.2,"is_safety":false,"confidence":0.1,"note":"'좀 그랬어… | {"ok":true,"feedback_id":6,"status":"review","reason":"신뢰도 0.10 < 0.3","note":"유형은 저장하지 않고 운영자 확인으로 넘겼다"} | 6건 모두 분류 저장 요청 |
| 8 | 09:20:26 | planner | `plan_cycle` | {"window_min":15,"focus_labels":["crowd","safety"],"run_dispatcher":true,"run_supervisor":true,"rea… | {"ok":true,"plan":{"window_min":15,"must_run":["classify","monitor"],"focus_labels":["crowd","safety"],"run_dispatcher"… | 60분 창의 5건이 모두 최근 15분에 들어왔다. 급증 표시는 없지만 짧은 창으로 한 번 더 확인한다. crowd와 safety가 높음 등급이고 요청서 대기 중이며, 브리핑 뒤에 새로 분류된 민원이 5건 있다. |
| 9 | 09:20:33 | monitor | `get_window_stats` | {"window_min":60} | {"window_min":60,"total":5,"counts":{"혼잡":2,"안전":1,"주차/교통":1,"화장실":1},"labels":["crowd","safety","parking","restroom"],… | 1단계: 최근 60분 구간 유형별 통계를 먼저 확인한 뒤 유형별 점수 판정과 스냅샷 기록을 동시에 진행한다. |
| 10 | 09:20:40 | monitor | `score_label` | {"label":"crowd","window_min":60} | {"label":"crowd","korean":"혼잡","freq":2,"safety_freq":2,"score":76,"grade":"high","formula":"(0.20×60 + 0.65×40) × 안전2.… | 2단계: 60분 구간에 등장한 4개 유형(혼잡·안전·주차/교통·화장실)의 등급 판정과 스냅샷 기록은 서로 결과가 필요 없으므로 동시에 호출한다. 총 5건으로 적어 급증 재확인은 점수 결과를 본 뒤 판단한다. |
| 11 | 09:20:40 | monitor | `score_label` | {"label":"safety","window_min":60} | {"label":"safety","korean":"안전","freq":1,"safety_freq":1,"score":68,"grade":"high","formula":"(0.10×60 + 0.70×40) × 안전2… | 2단계: 60분 구간에 등장한 4개 유형(혼잡·안전·주차/교통·화장실)의 등급 판정과 스냅샷 기록은 서로 결과가 필요 없으므로 동시에 호출한다. 총 5건으로 적어 급증 재확인은 점수 결과를 본 뒤 판단한다. |
| 12 | 09:20:40 | monitor | `score_label` | {"label":"parking","window_min":60} | {"label":"parking","korean":"주차/교통","freq":1,"safety_freq":0,"score":26,"grade":"low","formula":"(0.10×60 + 0.50×40) × … | 2단계: 60분 구간에 등장한 4개 유형(혼잡·안전·주차/교통·화장실)의 등급 판정과 스냅샷 기록은 서로 결과가 필요 없으므로 동시에 호출한다. 총 5건으로 적어 급증 재확인은 점수 결과를 본 뒤 판단한다. |
| 13 | 09:20:40 | monitor | `score_label` | {"label":"restroom","window_min":60} | {"label":"restroom","korean":"화장실","freq":1,"safety_freq":0,"score":30,"grade":"low","formula":"(0.10×60 + 0.60×40) × 안… | 2단계: 60분 구간에 등장한 4개 유형(혼잡·안전·주차/교통·화장실)의 등급 판정과 스냅샷 기록은 서로 결과가 필요 없으므로 동시에 호출한다. 총 5건으로 적어 급증 재확인은 점수 결과를 본 뒤 판단한다. |
| 14 | 09:20:40 | monitor | `save_snapshot` | {"window_min":60} | {"saved":0,"already_recorded":true,"top":"crowd","top_score":76} | 2단계: 60분 구간에 등장한 4개 유형(혼잡·안전·주차/교통·화장실)의 등급 판정과 스냅샷 기록은 서로 결과가 필요 없으므로 동시에 호출한다. 총 5건으로 적어 급증 재확인은 점수 결과를 본 뒤 판단한다. |
| 15 | 09:20:57 | monitor | `get_window_stats` | {"window_min":15} | {"window_min":15,"total":5,"counts":{"혼잡":2,"안전":1,"주차/교통":1,"화장실":1},"labels":["crowd","safety","parking","restroom"],… | 이번엔 재확인이라 save_snapshot은 부르지 않습니다. 먼저 15분 구간 통계를 보고, 유형별 점수 매기기는 그 결과를 받은 뒤 한 번에 동시에 요청합니다. |
| 16 | 09:21:04 | monitor | `score_label` | {"label":"crowd","window_min":15} | {"label":"crowd","korean":"혼잡","freq":2,"safety_freq":2,"score":76,"grade":"high","formula":"(0.20×60 + 0.65×40) × 안전2.… | 15분 구간 통계에 잡힌 4개 유형(혼잡, 안전, 주차/교통, 화장실)의 등급을 한 번에 동시에 요청합니다. 재확인 요청이라 save_snapshot은 부르지 않습니다. |
| 17 | 09:21:04 | monitor | `score_label` | {"label":"safety","window_min":15} | {"label":"safety","korean":"안전","freq":1,"safety_freq":1,"score":68,"grade":"high","formula":"(0.10×60 + 0.70×40) × 안전2… | 15분 구간 통계에 잡힌 4개 유형(혼잡, 안전, 주차/교통, 화장실)의 등급을 한 번에 동시에 요청합니다. 재확인 요청이라 save_snapshot은 부르지 않습니다. |
| 18 | 09:21:04 | monitor | `score_label` | {"label":"parking","window_min":15} | {"label":"parking","korean":"주차/교통","freq":1,"safety_freq":0,"score":26,"grade":"low","formula":"(0.10×60 + 0.50×40) × … | 15분 구간 통계에 잡힌 4개 유형(혼잡, 안전, 주차/교통, 화장실)의 등급을 한 번에 동시에 요청합니다. 재확인 요청이라 save_snapshot은 부르지 않습니다. |
| 19 | 09:21:04 | monitor | `score_label` | {"label":"restroom","window_min":15} | {"label":"restroom","korean":"화장실","freq":1,"safety_freq":0,"score":30,"grade":"low","formula":"(0.10×60 + 0.60×40) × 안… | 15분 구간 통계에 잡힌 4개 유형(혼잡, 안전, 주차/교통, 화장실)의 등급을 한 번에 동시에 요청합니다. 재확인 요청이라 save_snapshot은 부르지 않습니다. |
| 20 | 09:21:20 | dispatcher | `get_department` | {"label":"crowd"} | {"label":"crowd","korean":"혼잡","department":"안전총괄과","contact":"055-000-0005"} | 담당 부서 확인, 민원 원문 수집, 축제 공식 정보 조회는 서로 의존하지 않아 동시에 호출함. 관제 카드의 조치가 없으므로 원문을 본 뒤 조치를 2~3개 직접 작성할 예정. |
| 21 | 09:21:20 | dispatcher | `collect_quotes` | {"label":"crowd","limit":15} | [{"raw_text":"터널 입구에 사람이 계속 들어와서 안쪽이 너무 붐비고 떠밀려요","zone":"유등터널","ingested_at":"2026-10-01T09:20:00","sentiment":-0.7,"c… | 담당 부서 확인, 민원 원문 수집, 축제 공식 정보 조회는 서로 의존하지 않아 동시에 호출함. 관제 카드의 조치가 없으므로 원문을 본 뒤 조치를 2~3개 직접 작성할 예정. |
| 22 | 09:21:20 | dispatcher | `lookup_festival_info` | {"keyword":"유등"} | null | 담당 부서 확인, 민원 원문 수집, 축제 공식 정보 조회는 서로 의존하지 않아 동시에 호출함. 관제 카드의 조치가 없으므로 원문을 본 뒤 조치를 2~3개 직접 작성할 예정. |
| 23 | 09:21:32 | dispatcher | `generate_doc` | {"label":"crowd","department":"안전총괄과","count":2,"grade":"높음","formula":"심각도 등급 높음, 접수 2건 — 안전 관련 민원… | {"action_id":1,"path":"[경로]" | 민원이 2건뿐이고 둘 다 유등터널에서 떠밀리거나 앞으로 못 나가는 위험 상황이 구체적이라 둘 다 원문 그대로 인용함. 다른 구역 사례는 없음. 축제 정보 조회가 null이라 축제명만 넣음. 관제 카드의 조치가 없어서 오늘 현장에서 할 수 있는 조치 3개를 직접 씀. |
| 24 | 09:21:55 | dispatcher | `get_department` | {"label":"safety"} | {"label":"safety","korean":"안전","department":"안전총괄과","contact":"055-000-0005"} | 첫 단계: 부서·민원 원문·축제 정보는 서로 의존하지 않으므로 함께 조회한다. |
| 25 | 09:21:55 | dispatcher | `collect_quotes` | {"label":"safety","limit":15} | [{"raw_text":"촉석루 계단 조명이 꺼져 있어서 내려가다가 미끄러질 뻔했어요","zone":"촉석루 일원","ingested_at":"2026-10-01T09:20:00","sentiment":-0.7,"… | 첫 단계: 부서·민원 원문·축제 정보는 서로 의존하지 않으므로 함께 조회한다. |
| 26 | 09:21:55 | dispatcher | `lookup_festival_info` | {"keyword":"유등"} | null | 첫 단계: 부서·민원 원문·축제 정보는 서로 의존하지 않으므로 함께 조회한다. |
| 27 | 09:22:07 | dispatcher | `generate_doc` | {"label":"safety","department":"안전총괄과","count":1,"grade":"높음","formula":"심각도 등급 높음, 접수 1건 — 안전 관련 민… | {"action_id":2,"path":"[경로]" | 인용할 원문은 1건뿐이고 위험 상황(조명 꺼짐·미끄러질 뻔함)이 분명해서 그대로 씁니다. 축제 공식 정보는 조회 결과가 null이라 축제명만 넣습니다. 관제 카드의 조치가 주어지지 않아 오늘 현장에서 할 수 있는 조치 3개를 직접 썼습니다. |
| 28 | 09:22:21 | supervisor | `read_agent_results` | {"since_min":60,"window_min":60} | {"severity_ranking":[{"label":"crowd","korean":"혼잡","grade":"높음","freq":2,"spiked":false,"safety_weighted":true},{"labe… | 세 도구는 서로 의존하지 않으므로 심각도 창 60분으로 동시에 호출한다. |
| 29 | 09:22:21 | supervisor | `rank_actions` | {"window_min":60} | [{"label":"crowd","korean":"혼잡","grade":"높음","freq":2,"action_status":"requested","reason":"조치 요청 상태라 우선순위 조정"},{"label… | 세 도구는 서로 의존하지 않으므로 심각도 창 60분으로 동시에 호출한다. |
| 30 | 09:22:21 | supervisor | `rank_issues` | {"window_min":60} | {"window_min":60,"cards":[{"issue_key":"crowd:4","rank":1,"label":"crowd","label_ko":"혼잡","zone":"유등터널","grade":"high",… | 세 도구는 서로 의존하지 않으므로 심각도 창 60분으로 동시에 호출한다. |
| 31 | 09:22:51 | supervisor | `write_briefing` | {"top_label":"crowd","text":"지금 최우선은 유등터널 안 인파 밀림입니다. 최근 60분간 혼잡 민원이 2건으로 가장 많고 안전 관련 가중치가 붙어 높음 등급… | {"briefing_id":1,"cards":{"saved":2,"template":0,"ignored":[],"errors":{}}} | rank_issues의 1번 카드인 유등터널 혼잡을 최우선으로 정했다. 건수 순위와 심각도 순위는 같다. 혼잡·안전 두 건은 조치가 요청만 된 상태라 최우선에서 빼지 않고, 요청한 조치가 실제로 이뤄지는지 현장 확인을 맡겼다. |

## 워커 콘솔

```
[worker] 시작 · Fast 1s · Agent 60s
[worker] 처리 6건
[worker] Agent Path 실행
계획 창 15분 · 집중 [crowd,safety] · ③O ④O — 60분 창의 민원 5건이 모두 최근 15분에 몰려 짧은 창으로 급증을 다시 확인하고, 높음 등급인 crowd와 safety가 요청서를 기다리고
②감시 최근 60분 민원 5건을 판정한 결과, 즉시 등급이나 급증, 직전보다 등급이 오른 유형이 없어서 알림은 올리지 않았습니다. 가장 심각한 유형은 혼잡(높음, 2건)이며, 2건 모두 안전 관련이어서 등급이 올라갔습니다.
②재확인 15분 · 15분 구간에서 가장 심각한 유형은 혼잡으로, 등급은 '높음'입니다. 혼잡 민원 2건이 모두 안전과 관련되어 있어 등급이 올라갔고, 같은 1건이라도 안전 민원은 '높음', 주차/교
③조치 진주남강유등축제의 '혼잡'(심각도 높음, 접수 2건) 유형에 대해 안전총괄과(055-000-0005)에 보낼 조치요청서를 만들었습니다. 접수된 민원은 2건이고 모두 유등터널에서 들어온 것이라, 다른 구역 사례 없이
③조치 안전총괄과(055-000-0005)에 보낼 진주남강유등축제 '안전' 유형 조치요청서를 만들었습니다(등급 높음, 접수 1건, 촉석루 일원 계단 조명 꺼짐 민원 원문 1건, 오늘 할 수 있는 조치 3개, 파일: 조치요청
④통합 지금 최우선은 유등터널 안 인파 밀림입니다. 최근 60분간 혼잡 민원이 2건으로 가장 많고 안전 관련 가중치가 붙어 높음 등급이며, 촉석루 계단 조명이 꺼졌다는 안전 민원 1건도 높음 등급으로 바로 다음입니다. 두 건 모두 안전총괄과에 조치를 요청만 한 상태이고 아직 진행이나 완료가 확
```
