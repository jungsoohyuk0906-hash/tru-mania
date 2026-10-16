# 트루무비 (TRUMOVIE) — 0단계 생성 검증

가상 인물의 하루를 AI가 매일 일기로 쓰는 서비스의 0단계다. 화면 없이, 인물 1명을 60일 연속 생성해서
인물이 무너지지 않는지와 하루 생성 비용이 감당할 만한지를 확인한다. 결과는 `reports/stage0-report.md` 하나로 정리한다.

이번 범위는 0단계뿐이다. 화면, DB, 배포, 도트 부품 제작은 하지 않는다.

## 준비

Node.js 22 이상.

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY, 모델 두 개를 채운다
```

API 키는 `.env`(커밋 안 됨)나 셸 환경변수로만 넣는다. 코드, 로그, 리포트에는 키 값이 남지 않는다.

## 실행

기획서 규칙대로 작게 먼저 돌리고, 결과를 본 뒤 늘린다. 같은 run을 이어서 실행하므로 이미 만든 날은 다시 만들지 않는다.

```bash
npm run stage0 -- --days 3     # 3일. 리포트 확인
npm run stage0 -- --days 10    # 4~10일째 이어서. 7일째에 첫 주간 감사
npm run stage0 -- --days 60    # 끝까지. reports/stage0-report.md 생성
```

실행 전에 예상 API 호출 수와 비용(예상치와 최악의 경우)을 보여주고 확인을 받는다. `--yes`로 확인을 건너뛰고,
`--estimate-only`로 비용만 볼 수 있다. 누적 비용이 상한(`TRUMOVIE_BUDGET_USD`, 기본 10달러)을 넘을 수 있으면
그 호출 전에 멈춘다. 중간에 멈춰도 같은 명령을 다시 실행하면 이어서 진행한다.

API 키 없이 파이프라인만 확인하려면 `--mock`을 붙인다. 모의 일기와 흉내 낸 토큰 수로 검증, 재생성, 상태 반영, 기억 압축,
감사, 리포트까지 전부 돈다. 모의 run은 `data/runs/seoyun-stage0-mock/`에 따로 쌓이고 `reports/`에는 쓰지 않는다.

```bash
npm run stage0 -- --days 60 --mock --yes
npm test             # 단위 테스트 + 모의 end-to-end
npm run typecheck
```

가정값(환율, 목표 비용, 구독료)을 바꾼 뒤 리포트만 다시 계산하려면 `npm run report -- --run seoyun-stage0`.

## 하루가 만들어지는 순서

| 단계 | 누가 | 파일 |
| --- | --- | --- |
| 1. 사건 강도 결정 (무사건 55 · 작은 일 30 · 중간 12 · 큰 사건 3%, 큰 사건 뒤 7일 금지, 중간 이상 연속 금지) | 코드 | `src/engine/intensity.ts` |
| 2. 맥락 조립 (불변·천천히·자주 변함 계층, 최근 7일 요약, 주 단위 요약, 미해결 일) | 코드 | `src/engine/context.ts` |
| 3. 일기 생성 (정해진 JSON 형식으로만 응답) | AI (매일 모델) | `src/engine/generate.ts` |
| 4. 자동 검증, 걸리면 재생성 (최대 2번) | 코드 | `src/engine/validate.ts` |
| 5. 일관성 감사 (7일마다) | AI (감사 모델) | `src/engine/audit.ts` |
| 6. 상태 반영, 8일 지난 날은 주 단위 요약으로 압축 | 코드 | `src/engine/memory.ts` |

자동 검증 항목: JSON 형식, scene 값이 부품 목록 안에 있는지, 장소·행동 조합 규칙(`src/scene/rules.ts`), 불변 계층 변경 시도,
중간 사건 미만인 날의 천천히 변하는 계층 변경, 사망·퇴장한 인물의 재등장, 날짜 연속성, 정해진 강도를 넘는 사건,
이미 아는 사람의 중복 등록, 인물이 독자를 의식하는 표현, 일기 길이.

사건 강도는 run 이름을 시드로 한 고정 난수라서, 같은 run은 언제 다시 돌려도 같은 날에 같은 강도가 나온다.

## 파일

```
src/
  engine/       intensity, context, generate, validate, audit, memory, calendar
  llm/          adapter.ts (공통 인터페이스), anthropic.ts, mock.ts
  scene/        vocabulary.ts (부품 목록), rules.ts (허용 조합 규칙표)
  schema/       character.ts (4계층 상태), day.ts (하루 기록, AI 응답 형식)
  cost.ts       모델 가격표, 비용 상한
  report.ts     리포트 (기획서 8장 형식)
  runner.ts     하루씩 생성, 이어서 실행, 감사, 리포트 저장
scripts/
  run-stage0.ts     실행
  report-stage0.ts  리포트 다시 만들기
data/
  characters/   인물 설정 입력 (seoyun.json = 기획서 예시 인물)
  runs/         실행 결과 (커밋 안 됨): 하루 기록, 감사, 호출별 비용, 리포트
reports/
  stage0-report.md  60일 실제 실행이 끝나면 생성
```

## 다른 모델과 비교하기

모델은 run을 처음 만들 때 고정된다. 다른 모델로 돌리려면 `.env`의 모델을 바꾸고 새 이름으로 시작한다.

```bash
npm run stage0 -- --days 10 --run seoyun-sonnet
```

새 제공자는 `src/llm/adapter.ts`의 `LlmAdapter`를 구현하고, 가격을 `src/cost.ts`에 넣으면 된다.
