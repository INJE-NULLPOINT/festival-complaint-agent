# 분류 정확도 리포트

`python scripts/measure_accuracy.py --backend <local|anthropic>` 로 생성.
정답은 시드의 `_label_hint`. 같은 문장은 1번만 센다.

## local

측정 2026-09-30 00:22 · 시드 `dev_sample.csv` · 고유 문장 32건 · 모델 `규칙 기반 대역`

- **정확도 87.5%** (28/32) · 미처리 0건 · 소요 1초
- 안전 재현율 4/4 (라벨 safety 이거나 is_safety=true)

| 라벨 | 건수 | 정밀도 | 재현율 |
|---|---|---|---|
| parking | 7 | 100.0% | 85.7% |
| restroom | 5 | 100.0% | 100.0% |
| price | 5 | 80.0% | 80.0% |
| guide | 4 | 60.0% | 75.0% |
| crowd | 3 | 100.0% | 66.7% |
| safety | 4 | 80.0% | 100.0% |
| positive | 4 | 100.0% | 100.0% |

혼동 행렬

| 정답＼예측 | parking | restroom | price | guide | crowd | safety | positive | - |
|---|---|---|---|---|---|---|---|---|
| **parking** | 6 |  |  | 1 |  |  |  |  |
| **restroom** |  | 5 |  |  |  |  |  |  |
| **price** |  |  | 4 | 1 |  |  |  |  |
| **guide** |  |  | 1 | 3 |  |  |  |  |
| **crowd** |  |  |  |  | 2 | 1 |  |  |
| **safety** |  |  |  |  |  | 4 |  |  |
| **positive** |  |  |  |  |  |  | 4 |  |

오분류 4건

- `crowd`→`safety` 다리 위에 사람이 너무 몰려서 위험했어요
- `guide`→`price` 안내요원에게 물어봤는데 모른다고 하네요
- `parking`→`guide` 나가는 길이 한 차선이라 계속 막혀요
- `price`→`guide` 어묵 한 그릇에 만 원은 너무합니다

## claude_code

측정 2026-09-30 00:23 · 시드 `dev_sample.csv` · 고유 문장 32건 · 모델 `claude-opus-5-5` (Claude Code CLI 경유 — 참고값, 최종값은 anthropic)

- **정확도 100.0%** (32/32) · 미처리 0건 · 소요 73초
- 안전 재현율 4/4 (라벨 safety 이거나 is_safety=true)
- 모델 호출 6회 · 입력 14,159 · 출력 3,733 · 캐시읽기 13,287 토큰 · 약 $0.1340 (민원 1건당 $0.00419, claude-opus-5-5 단가 기준)

| 라벨 | 건수 | 정밀도 | 재현율 |
|---|---|---|---|
| parking | 7 | 100.0% | 100.0% |
| restroom | 5 | 100.0% | 100.0% |
| price | 5 | 100.0% | 100.0% |
| guide | 4 | 100.0% | 100.0% |
| crowd | 3 | 100.0% | 100.0% |
| safety | 4 | 100.0% | 100.0% |
| positive | 4 | 100.0% | 100.0% |

혼동 행렬

| 정답＼예측 | parking | restroom | price | guide | crowd | safety | positive | - |
|---|---|---|---|---|---|---|---|---|
| **parking** | 7 |  |  |  |  |  |  |  |
| **restroom** |  | 5 |  |  |  |  |  |  |
| **price** |  |  | 5 |  |  |  |  |  |
| **guide** |  |  |  | 4 |  |  |  |  |
| **crowd** |  |  |  |  | 3 |  |  |  |
| **safety** |  |  |  |  |  | 4 |  |  |
| **positive** |  |  |  |  |  |  | 4 |  |

오분류 0건


