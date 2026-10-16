import { costUsd, worstCaseUsd } from "../cost.js";
import { LlmError, ZERO_TOKENS } from "../llm/adapter.js";
import type { CharacterState } from "../schema/character.js";
import {
  AuditOutputSchema,
  type AuditFinding,
  type AuditRecord,
  type DayRecord,
  type TokenUsage,
} from "../schema/day.js";
import { shortDate } from "./calendar.js";
import { roughTokens, type CallOptions } from "./generate.js";
import { INTENSITY_LABELS_KO } from "./intensity.js";

// 기획서 6장 5단계 "일관성 감사 (AI, 주 1회)".
// 더 좋은 모델로 최근 7일 일기와 상태를 대조해 성격 급변이나 서술 모순을 찾는다. 결과는 리포트에 기록만 한다.

export const AUDIT_MAX_TOKENS = 16000;
const FATAL_TYPES: AuditFinding["type"][] = ["immutable_contradiction", "deceased_reappearance"];

export interface AuditWindow {
  week: number;
  fromDay: number;
  toDay: number;
}

/** day를 끝낸 직후 감사할 주가 있으면 돌려준다. 7일마다, 그리고 계획된 마지막 날에. */
export function auditWindowEndingAt(day: number, plannedDays: number): AuditWindow | null {
  if (day % 7 !== 0 && day !== plannedDays) return null;
  const week = Math.ceil(day / 7);
  return { week, fromDay: (week - 1) * 7 + 1, toDay: day };
}

export function buildAuditSystem(): string {
  return `너는 매일 이어지는 일기 연재의 설정 감수자다. 한 사람의 일기 7일치를 그 사람의 설정과 지난 기록에 대조해 모순을 찾는다.

## 찾을 것 (type)
- immutable_contradiction: 불변 설정(이름, 나이·생년, 출신지, 가족 구성과 생사, 핵심 성격)과 정면으로 어긋나는 서술
- deceased_reappearance: 세상을 떠났거나 퇴장한 사람이 직접 등장하거나 연락해 옴 (떠올리거나 언급하는 것은 제외)
- personality_shift: 계기 없이 성격, 말투, 가치관이 급변함
- fact_mismatch: 앞서 나온 사실과 어긋나는 세부 (직장, 사는 곳, 사람과의 관계, 이전 사건의 내용)
- timeline: 날짜, 요일, 계절, 전날과의 흐름이 맞지 않음
- other: 그 밖의 분명한 모순

## 규칙
- 확실한 모순만 적는다. 해석에 따라 달라지는 것이나 문체 취향은 적지 않는다.
- severity는 immutable_contradiction과 deceased_reappearance만 fatal, 나머지는 minor다.
- day에는 모순이 드러난 날의 번호(N일째의 N)를 쓴다.
- description에는 무엇이 무엇과 어긋나는지, evidence에는 근거가 되는 일기 문장을 짧게 인용한다.
- 모순이 없으면 findings는 빈 배열이다.
- overall에는 이 기간이 한 사람의 삶으로 자연스럽게 이어 읽히는지 2~3문장으로 평가한다.`;
}

export function buildAuditUser(state: CharacterState, window: AuditWindow, days: DayRecord[]): string {
  const im = state.immutable;
  const lines: string[] = [];
  lines.push("# 불변 설정");
  lines.push(`- 이름: ${im.name} / 출생 연도: ${im.birth_year} / 출신지: ${im.hometown}`);
  lines.push(`- 가족: ${im.family.map((f) => `${f.relation} ${f.name}(${f.alive ? "생존" : "작고"})`).join(", ") || "없음"}`);
  lines.push(`- MBTI: ${im.core_traits.mbti} / 기질: ${im.core_traits.temperament}`);

  lines.push("", "# 천천히 변하는 설정 (현재)");
  lines.push(`- 직업: ${state.slow.job} / 사는 곳: ${state.slow.residence} / 장기 목표: ${state.slow.long_term_goal}`);
  if (state.slow.values) lines.push(`- 가치관: ${state.slow.values}`);
  lines.push(`- 관계: ${state.slow.relationships.map((r) => `${r.name}(${r.relation}, 친밀도 ${r.closeness})`).join(", ") || "없음"}`);
  if (state.slow.change_log.length > 0) {
    lines.push("- 변경 기록:");
    for (const c of state.slow.change_log) {
      lines.push(`  - ${c.day}일째 ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)} (${c.reason})`);
    }
  }

  lines.push("", "# 등장 인물");
  for (const c of state.memory.cast) {
    lines.push(`- ${c.name} · ${c.relation ?? "관계 미상"} · ${c.first_seen_day}일째 첫 등장 · ${c.status}`);
  }

  const earlier = state.memory.weekly_summaries.filter((w) => w.to_day < window.fromDay);
  if (earlier.length > 0) {
    lines.push("", "# 이전 주 요약");
    for (const w of earlier) lines.push(`- ${w.week}주차: ${w.text}`);
  }

  lines.push("", `# 감사 대상: ${window.fromDay}~${window.toDay}일째`);
  for (const d of days) {
    lines.push("", `## ${d.day}일째 ${shortDate(d.date_in_story)} · 사건 강도: ${INTENSITY_LABELS_KO[d.intensity]}`);
    if (d.status !== "ok" || !d.diary) {
      lines.push("(생성 실패로 이 날의 일기는 없다)");
      continue;
    }
    if (d.state_changes.length > 0) {
      lines.push(`상태 변화: ${d.state_changes.map((c) => `${c.field} ${JSON.stringify(c.from)}→${JSON.stringify(c.to)}`).join(", ")}`);
    }
    lines.push(d.diary);
  }
  lines.push("", "위 기간의 모순을 JSON으로 보고한다.");
  return lines.join("\n");
}

export type AuditResult = { kind: "done"; record: AuditRecord } | { kind: "budget" };

export async function runAudit(
  opts: CallOptions,
  state: CharacterState,
  window: AuditWindow,
  days: DayRecord[],
): Promise<AuditResult> {
  const system = buildAuditSystem();
  const user = buildAuditUser(state, window, days);
  if (!opts.budget.canSpend(worstCaseUsd(opts.model, roughTokens(system + user), AUDIT_MAX_TOKENS))) {
    return { kind: "budget" };
  }

  let tokens: TokenUsage = ZERO_TOKENS;
  let stopReason: string | null = null;
  let error: string | undefined;
  let findings: AuditFinding[] = [];
  let overall: string | null = null;
  try {
    const res = await opts.adapter.complete({
      purpose: "audit",
      model: opts.model,
      system,
      user,
      schema: AuditOutputSchema,
      maxTokens: AUDIT_MAX_TOKENS,
      effort: opts.effort,
      mockHint: { kind: "audit", window, days: days.map((d) => ({ day: d.day, ok: d.status === "ok" })) },
    });
    tokens = res.tokens;
    stopReason = res.stopReason;
    if (res.stopReason === "refusal") throw new Error("모델이 감사를 거절했다");
    if (res.stopReason === "max_tokens") throw new Error("감사 출력이 max_tokens에서 잘렸다");
    const parsed = AuditOutputSchema.safeParse(JSON.parse(res.text));
    if (!parsed.success) throw new Error(`감사 응답 형식 오류: ${parsed.error.issues[0]?.message ?? ""}`);
    findings = parsed.data.findings.map((f) => ({
      ...f,
      severity: FATAL_TYPES.includes(f.type) ? "fatal" : "minor",
    }));
    overall = parsed.data.overall;
  } catch (err) {
    if (err instanceof LlmError && err.abortRun) throw err;
    error = err instanceof Error ? err.message : String(err);
  }

  const cost = costUsd(opts.model, tokens);
  opts.budget.add(cost);
  opts.onCall({
    at: new Date().toISOString(),
    purpose: "audit",
    week: window.week,
    model: opts.model,
    ok: !error,
    stop_reason: stopReason,
    ...(error ? { error } : {}),
    tokens,
    cost_usd: cost,
  });

  return {
    kind: "done",
    record: {
      week: window.week,
      from_day: window.fromDay,
      to_day: window.toDay,
      model: opts.model,
      status: error ? "error" : "ok",
      ...(error ? { error } : {}),
      findings,
      overall,
      tokens,
      cost_usd: cost,
      generated_at: new Date().toISOString(),
    },
  };
}
