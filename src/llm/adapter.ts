import type { z } from "zod";
import type { TokenUsage } from "../schema/day.js";

// LLM 호출 공통 인터페이스. 제공자를 바꿔도 엔진 코드는 그대로 둔다.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface LlmRequest {
  purpose: "diary" | "audit";
  model: string;
  /** 매일 같은 앞부분 (작성 규칙, 불변 설정). 프롬프트 캐싱 대상이다. */
  system: string;
  /** 매일 달라지는 부분 */
  user: string;
  /** 응답 JSON 형식 */
  schema: z.ZodType;
  maxTokens: number;
  /** 지정하지 않으면 모델 기본값 */
  effort?: Effort;
  /** mock 어댑터만 쓰는 힌트. 실제 호출에는 보내지 않는다. */
  mockHint?: unknown;
}

export interface LlmResponse {
  /** 모델이 돌려준 텍스트 (JSON 문자열이어야 한다) */
  text: string;
  /** end_turn, max_tokens, refusal 등 */
  stopReason: string | null;
  tokens: TokenUsage;
}

export class LlmError extends Error {
  /** true면 재시도해도 소용없는 오류 (키 없음, 권한, 잘못된 요청). 실행 전체를 멈춘다. */
  readonly abortRun: boolean;
  constructor(message: string, abortRun: boolean) {
    super(message);
    this.name = "LlmError";
    this.abortRun = abortRun;
  }
}

export interface LlmAdapter {
  readonly provider: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** 실행 전 비용 추정용 입력 토큰 수 (호출 비용 없음) */
  countInputTokens(req: LlmRequest): Promise<number>;
}

export const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
