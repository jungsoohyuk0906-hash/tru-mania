import { EFFORTS, type Effort } from "./llm/adapter.js";
import { priceOf } from "./cost.js";

// 설정은 환경변수(.env)로만 받는다. 키 값은 코드, 로그, 리포트 어디에도 남기지 않는다.

export interface RunConfig {
  dailyModel: string;
  auditModel: string;
  dailyEffort: Effort | null;
  auditEffort: Effort | null;
  budgetUsd: number;
  usdKrw: number;
  /** 하루 비용 목표 (원) */
  targetKrwPerDay: number;
  /** 월 구독료 가정 (원) */
  subscriptionKrw: number;
}

/** 모의 실행에서 가격 계산에만 쓰는 모델. 실제 실행은 사람이 .env에서 정한다. */
const MOCK_DEFAULT_MODELS = { daily: "claude-haiku-5-5", audit: "claude-opus-5-5" };

export function loadDotEnv(file = ".env"): void {
  try {
    process.loadEnvFile(file);
  } catch {
    // .env가 없으면 셸 환경변수만 쓴다
  }
}

export function readConfig(opts: { mock: boolean; budgetOverride?: number }): RunConfig {
  const env = process.env;
  const dailyModel = env.TRUMOVIE_DAILY_MODEL?.trim() || (opts.mock ? MOCK_DEFAULT_MODELS.daily : "");
  const auditModel = env.TRUMOVIE_AUDIT_MODEL?.trim() || (opts.mock ? MOCK_DEFAULT_MODELS.audit : "");
  if (!dailyModel || !auditModel) {
    throw new Error(
      "TRUMOVIE_DAILY_MODEL, TRUMOVIE_AUDIT_MODEL을 .env에 정한다. 모델 선택은 사람이 결정할 사항이라 기본값을 두지 않는다 (.env.example 참고).",
    );
  }
  priceOf(dailyModel);
  priceOf(auditModel);

  return {
    dailyModel,
    auditModel,
    dailyEffort: readEffort("TRUMOVIE_DAILY_EFFORT"),
    auditEffort: readEffort("TRUMOVIE_AUDIT_EFFORT"),
    budgetUsd: opts.budgetOverride ?? readNumber("TRUMOVIE_BUDGET_USD", 10),
    usdKrw: readNumber("TRUMOVIE_USD_KRW", 1400),
    targetKrwPerDay: readNumber("TRUMOVIE_TARGET_KRW_PER_DAY", 50),
    subscriptionKrw: readNumber("TRUMOVIE_SUBSCRIPTION_KRW", 4900),
  };
}

function readEffort(name: string): Effort | null {
  const v = process.env[name]?.trim();
  if (!v) return null;
  if (!(EFFORTS as string[]).includes(v)) throw new Error(`${name}는 ${EFFORTS.join(", ")} 중 하나여야 한다 (지금: ${v})`);
  return v as Effort;
}

function readNumber(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}는 양수여야 한다 (지금: ${v})`);
  return n;
}
