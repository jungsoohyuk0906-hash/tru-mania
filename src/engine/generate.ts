import { addTokens, costUsd, worstCaseUsd, type BudgetGuard } from "../cost.js";
import { LlmError, ZERO_TOKENS, type Effort, type LlmAdapter } from "../llm/adapter.js";
import type { Hemisphere } from "../scene/rules.js";
import type { CharacterState, Intensity } from "../schema/character.js";
import { DiaryOutputSchema, type AttemptRecord, type DiaryOutput, type TokenUsage } from "../schema/day.js";
import type { DayInfo } from "./calendar.js";
import { buildDiarySystem, buildDiaryUser } from "./context.js";
import { knownNames, parseAndValidate } from "./validate.js";

// 기획서 6장 3단계 "일기 생성 (AI)" + 7단계 "실패 처리".

/** 재생성은 최대 2번 (총 3번 시도) */
export const MAX_REGENERATIONS = 2;
/** thinking 토큰까지 포함한 출력 상한 */
export const DIARY_MAX_TOKENS = 8000;

export interface CallLogEntry {
  at: string;
  purpose: "diary" | "audit";
  day?: number;
  week?: number;
  attempt?: number;
  model: string;
  ok: boolean;
  stop_reason: string | null;
  error?: string;
  tokens: TokenUsage;
  cost_usd: number;
}

export interface CallOptions {
  adapter: LlmAdapter;
  budget: BudgetGuard;
  model: string;
  effort?: Effort;
  /** 호출마다 불린다. 비용 기록을 파일에 남기는 데 쓴다. */
  onCall: (entry: CallLogEntry) => void;
}

export interface DayInput {
  state: CharacterState;
  info: DayInfo;
  intensity: Intensity;
  hemisphere: Hemisphere;
}

export type GenerateResult =
  | { kind: "done"; output: DiaryOutput | null; attempts: AttemptRecord[] }
  /** 비용 상한에 걸려 그날을 끝내지 못했다. 그날은 기록하지 않고 다음 실행에서 다시 만든다. */
  | { kind: "budget"; attempts: AttemptRecord[] };

/** 대략적인 입력 토큰 수. 한국어는 글자 수가 토큰 수보다 크거나 비슷해서, 상한 검사용으로 넉넉하다. */
export function roughTokens(text: string): number {
  return text.length;
}

export async function generateDay(opts: CallOptions, input: DayInput): Promise<GenerateResult> {
  const { state, info, intensity, hemisphere } = input;
  const system = buildDiarySystem(state, hemisphere);
  const attempts: AttemptRecord[] = [];
  let feedback: string[] = [];

  for (let attempt = 1; attempt <= MAX_REGENERATIONS + 1; attempt++) {
    const user = buildDiaryUser({ state, info, intensity, feedback });
    const worst = worstCaseUsd(opts.model, roughTokens(system + user), DIARY_MAX_TOKENS);
    if (!opts.budget.canSpend(worst)) return { kind: "budget", attempts };

    let text = "";
    let stopReason: string | null = null;
    let tokens: TokenUsage = ZERO_TOKENS;
    let error: string | undefined;
    try {
      const res = await opts.adapter.complete({
        purpose: "diary",
        model: opts.model,
        system,
        user,
        schema: DiaryOutputSchema,
        maxTokens: DIARY_MAX_TOKENS,
        effort: opts.effort,
        mockHint: {
          kind: "diary",
          attempt,
          info,
          intensity,
          name: state.immutable.name,
          known: knownNames(state),
          openConcerns: state.volatile.open_concerns,
          openThreads: state.memory.open_threads,
          hemisphere,
        },
      });
      text = res.text;
      stopReason = res.stopReason;
      tokens = res.tokens;
    } catch (err) {
      if (err instanceof LlmError && err.abortRun) throw err;
      error = err instanceof Error ? err.message : String(err);
    }

    const cost = costUsd(opts.model, tokens);
    opts.budget.add(cost);

    let issues: AttemptRecord["issues"];
    let output: DiaryOutput | null = null;
    if (error) {
      issues = [{ code: "API_ERROR", severity: "minor", message: error, blocking: true }];
    } else if (stopReason === "refusal") {
      issues = [{ code: "REFUSAL", severity: "minor", message: "모델이 응답을 거절했다", blocking: true }];
    } else if (stopReason === "max_tokens") {
      issues = [{ code: "TRUNCATED", severity: "minor", message: "출력이 max_tokens에서 잘렸다", blocking: true }];
    } else {
      const result = parseAndValidate(text, {
        state,
        day: info.day,
        date: info.date,
        month: info.month,
        hemisphere,
        intensity,
      });
      issues = result.issues;
      output = result.output;
    }

    const ok = output !== null;
    attempts.push({ attempt, ok, stop_reason: stopReason, ...(error ? { error } : {}), issues, tokens, cost_usd: cost });
    opts.onCall({
      at: new Date().toISOString(),
      purpose: "diary",
      day: info.day,
      attempt,
      model: opts.model,
      ok,
      stop_reason: stopReason,
      ...(error ? { error } : {}),
      tokens,
      cost_usd: cost,
    });

    if (ok) return { kind: "done", output, attempts };
    feedback = issues.filter((i) => i.blocking).map((i) => i.message);
  }

  return { kind: "done", output: null, attempts };
}

export function sumAttempts(attempts: AttemptRecord[]): { tokens: TokenUsage; cost_usd: number } {
  return attempts.reduce(
    (acc, a) => ({ tokens: addTokens(acc.tokens, a.tokens), cost_usd: acc.cost_usd + a.cost_usd }),
    { tokens: ZERO_TOKENS, cost_usd: 0 },
  );
}
