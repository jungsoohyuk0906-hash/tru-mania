import type { TokenUsage } from "./schema/day.js";

// 모델별 가격 (USD / 100만 토큰). Anthropic 공개 가격, 2026-10 기준.
// 캐시 쓰기는 5분 TTL 기준 입력가의 1.25배. Haiku 5.5는 프롬프트 10만 토큰 이하 요율이다
// (이 프로젝트의 프롬프트는 수천 토큰이라 그 이상 요율은 쓰지 않는다).
// 가격이 바뀌거나 다른 모델을 비교하려면 여기에 한 줄 추가한다.
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
};

export function priceOf(model: string): ModelPrice {
  const p = PRICES[model];
  if (!p) {
    throw new Error(
      `가격표에 없는 모델: ${model}. 비용 상한을 지키려면 가격을 알아야 한다. src/cost.ts의 PRICES에 추가한다.`,
    );
  }
  return p;
}

export function costUsd(model: string, t: TokenUsage): number {
  const p = priceOf(model);
  return (
    (t.input * p.input + t.cache_write * p.cacheWrite + t.cache_read * p.cacheRead + t.output * p.output) /
    1_000_000
  );
}

/** 호출 한 번의 최악 비용: 입력 전부 캐시 없이, 출력은 max_tokens까지 */
export function worstCaseUsd(model: string, inputTokens: number, maxTokens: number): number {
  const p = priceOf(model);
  return (inputTokens * p.cacheWrite + maxTokens * p.output) / 1_000_000;
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_write: a.cache_write + b.cache_write,
    cache_read: a.cache_read + b.cache_read,
  };
}

/** 실행 중 누적 비용이 상한을 넘지 않게 막는다. 호출 전에 최악 비용으로 검사한다. */
export class BudgetGuard {
  readonly limitUsd: number;
  private spent: number;

  constructor(limitUsd: number, alreadySpentUsd: number) {
    this.limitUsd = limitUsd;
    this.spent = alreadySpentUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  canSpend(worstCaseUsd: number): boolean {
    return this.spent + worstCaseUsd <= this.limitUsd;
  }

  add(usd: number): void {
    this.spent += usd;
  }
}

export function formatUsd(usd: number): string {
  return `$${usd < 0.01 ? usd.toFixed(5) : usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function formatKrw(usd: number, usdKrw: number): string {
  const krw = usd * usdKrw;
  return `${krw < 10 ? krw.toFixed(2) : Math.round(krw).toLocaleString("ko-KR")}원`;
}
