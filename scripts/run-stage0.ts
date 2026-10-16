import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadCharacter } from "../src/character.js";
import { loadDotEnv, readConfig } from "../src/config.js";
import { formatKrw, formatUsd } from "../src/cost.js";
import { LlmError, type LlmAdapter } from "../src/llm/adapter.js";
import { AnthropicAdapter } from "../src/llm/anthropic.js";
import { MockAdapter } from "../src/llm/mock.js";
import { estimateRun, openRun, runDays, saveReports } from "../src/runner.js";
import { RunStore } from "../src/store.js";

// 0단계: 인물 1명을 N일 연속 생성한다.
// 기획서 규칙대로 3일 → 10일 → 60일 순서로 늘려 가며, 같은 run을 이어서 실행한다.

const HELP = `사용법: npm run stage0 -- --days <N> [옵션]

  --days <N>         N일째까지 생성한다 (이미 생성한 날은 건너뛰고 이어서)
  --character <파일>  인물 설정 (기본: data/characters/seoyun.json)
  --run <이름>        실행 이름 (기본: <인물 id>-stage0, 모의 실행은 -mock 이 붙음)
  --budget <달러>     누적 비용 상한 (기본: TRUMOVIE_BUDGET_USD 또는 10)
  --mock             API를 부르지 않는 모의 실행
  --estimate-only    예상 호출 수와 비용만 보여주고 끝낸다
  --yes, -y          확인 질문 없이 바로 실행한다

권장 순서: --days 3 → 결과 확인 → --days 10 → 결과 확인 → --days 60`;

async function main(): Promise<number> {
  loadDotEnv();
  const { values } = parseArgs({
    options: {
      days: { type: "string" },
      character: { type: "string", default: "data/characters/seoyun.json" },
      run: { type: "string" },
      budget: { type: "string" },
      mock: { type: "boolean", default: false },
      "estimate-only": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || !values.days) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  const targetDay = Number(values.days);
  if (!Number.isInteger(targetDay) || targetDay < 1) throw new Error(`--days는 1 이상의 정수여야 한다 (지금: ${values.days})`);
  const budgetOverride = values.budget !== undefined ? Number(values.budget) : undefined;
  if (budgetOverride !== undefined && !(budgetOverride > 0)) throw new Error(`--budget은 양수여야 한다 (지금: ${values.budget})`);

  const mock = values.mock;
  const config = readConfig({ mock, budgetOverride });
  const characterFile = values.character;
  const character = loadCharacter(characterFile);
  const runId = values.run ?? `${character.id}-stage0${mock ? "-mock" : ""}`;
  const store = new RunStore(runId);

  // 어댑터를 먼저 만들어 키가 없으면 run 폴더를 만들기 전에 멈춘다
  const adapter: LlmAdapter = mock ? new MockAdapter({ seed: runId }) : new AnthropicAdapter();
  const { meta, created } = openRun(store, { runId, characterFile, character, mock, config, targetDay });
  const deps = { store, adapter, config, log: (line: string) => console.log(line) };
  const lastDay = store.readState().last_day;
  const usd = (x: number) => `${formatUsd(x)} (${formatKrw(x, config.usdKrw)})`;

  console.log(`\n트루무비 0단계 — ${character.state.immutable.name}${mock ? " [모의 실행]" : ""}`);
  console.log(`  run: ${runId} (${created ? "새로 시작" : `이어서: ${lastDay}일째까지 완료`}) → ${store.dir}`);
  console.log(`  모델: 일기 ${meta.models.daily} (effort ${meta.effort.daily ?? "기본값"}) · 감사 ${meta.models.audit} (effort ${meta.effort.audit ?? "기본값"})`);

  if (targetDay <= lastDay) {
    console.log(`\n이미 ${lastDay}일째까지 생성했다. 리포트만 다시 만든다.`);
    for (const p of saveReports(store, config, { publish: false })) console.log(`  리포트: ${p}`);
    return 0;
  }

  const est = await estimateRun(deps, meta, targetDay);
  console.log(`\n실행 전 확인`);
  console.log(`  생성할 날: ${est.fromDay}~${est.toDay}일째 (${est.days}일)`);
  console.log(`  예상 API 호출: 일기 ${est.days}번 (재생성 포함 최대 ${est.days * 3}번) + 주간 감사 ${est.audits}번`);
  console.log(
    `  예상 비용: 약 ${usd(est.expectedUsd)} — ${
      est.basis === "observed"
        ? "지금까지 실측한 하루 평균 기준"
        : `추정치 (입력 약 ${est.inputTokensAssumed?.toLocaleString("ko-KR")} 토큰, 출력 3,000 토큰, 평균 1.2번 시도 가정)`
    }`,
  );
  console.log(`  최악의 경우: ${usd(est.worstUsd)} (모든 날 3번 시도, 출력 상한까지)`);
  console.log(`  지금까지 쓴 비용: ${usd(est.spentUsd)} / 상한 ${formatUsd(config.budgetUsd)}`);
  if (est.spentUsd + est.worstUsd > config.budgetUsd) {
    console.log(`  최악의 경우 상한을 넘을 수 있다. 상한에 닿기 전에 그 자리에서 멈춘다.`);
  }

  if (values["estimate-only"]) return 0;
  if (!values.yes) {
    if (!process.stdin.isTTY) {
      console.log("\n확인 없이 실행하려면 --yes 를 붙인다.");
      return 1;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("\n진행할까? (y/N) ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("취소했다.");
      return 1;
    }
  }

  console.log("");
  const result = await runDays(deps, meta, targetDay);
  const complete = result.lastDay >= meta.planned_days;
  const reports = saveReports(store, config, { publish: complete && !mock });

  const errors = result.newDays.filter((d) => d.status === "error").length;
  console.log(`\n${result.stoppedBy === "budget" ? "비용 상한으로 멈춤" : "완료"}: ${result.lastDay}일째까지`);
  console.log(`  이번 실행: ${result.newDays.length}일 생성 (실패 ${errors}일) · ${usd(result.spentThisRunUsd)}`);
  console.log(`  누적 비용: ${usd(store.totalCostUsd())}`);
  for (const p of reports) console.log(`  리포트: ${p}`);
  if (!complete && result.stoppedBy === "done") {
    const next = result.lastDay < 3 ? 3 : result.lastDay < 10 ? 10 : meta.planned_days;
    console.log(`\n결과를 확인한 뒤 다음 단계: npm run stage0 -- --days ${next}${mock ? " --mock" : ""}${values.run ? ` --run ${runId}` : ""}`);
  }
  return result.stoppedBy === "budget" ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof LlmError) console.error(`\n실행 중단: ${err.message}`);
    else console.error(`\n오류: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
