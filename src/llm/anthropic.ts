import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TokenUsage } from "../schema/day.js";
import { LlmError, type LlmAdapter, type LlmRequest, type LlmResponse } from "./adapter.js";

// Claude API 어댑터. 키는 ANTHROPIC_API_KEY 환경변수에서만 읽는다.
export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic";
  private readonly client: Anthropic;

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new LlmError(
        "ANTHROPIC_API_KEY 환경변수가 없다. .env.example을 .env로 복사하고 키를 넣거나, 셸에서 export 한다.",
        true,
      );
    }
    this.client = new Anthropic({ maxRetries: 4 });
  }

  private system(req: LlmRequest): Anthropic.TextBlockParam[] {
    // 작성 규칙과 불변 설정은 매일 같으므로 캐시한다. 연속 실행 중에는 매번 캐시를 읽는다.
    return [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: this.system(req),
        messages: [{ role: "user", content: req.user }],
        output_config: {
          format: zodOutputFormat(req.schema),
          ...(req.effort ? { effort: req.effort } : {}),
        },
      });
      // 응답은 thinking 블록으로 시작할 수 있으므로 text 블록만 모은다.
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, stopReason: res.stop_reason, tokens: toTokenUsage(res.usage) };
    } catch (err) {
      throw toLlmError(err);
    }
  }

  async countInputTokens(req: LlmRequest): Promise<number> {
    try {
      const res = await this.client.messages.countTokens({
        model: req.model,
        system: this.system(req),
        messages: [{ role: "user", content: req.user }],
      });
      return res.input_tokens;
    } catch (err) {
      throw toLlmError(err);
    }
  }
}

function toTokenUsage(u: Anthropic.Usage): TokenUsage {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cache_write: u.cache_creation_input_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
  };
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  // 키·권한·모델 이름·요청 형식 문제는 매일 똑같이 실패하므로 실행을 멈춘다.
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.BadRequestError
  ) {
    return new LlmError(`API 오류 ${err.status}: ${err.message}`, true);
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmError(`API 오류 ${err.status ?? "(연결)"}: ${err.message}`, false);
  }
  return new LlmError(err instanceof Error ? err.message : String(err), false);
}
