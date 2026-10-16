import path from "node:path";
import type { RunConfig } from "./config.js";
import { BudgetGuard, costUsd, worstCaseUsd } from "./cost.js";
import { AUDIT_MAX_TOKENS, auditWindowEndingAt, buildAuditSystem, runAudit, type AuditWindow } from "./engine/audit.js";
import { describeDay, shortDate } from "./engine/calendar.js";
import { buildDiarySystem, buildDiaryUser } from "./engine/context.js";
import { DIARY_MAX_TOKENS, generateDay, MAX_REGENERATIONS, sumAttempts, type CallOptions } from "./engine/generate.js";
import { drawIntensity, INTENSITY_LABELS_KO } from "./engine/intensity.js";
import { applyDiary } from "./engine/memory.js";
import type { LlmAdapter } from "./llm/adapter.js";
import { buildReport } from "./report.js";
import type { CharacterInput, Intensity } from "./schema/character.js";
import { DiaryOutputSchema, type DayRecord } from "./schema/day.js";
import { writeText, type RunMeta, type RunStore } from "./store.js";

export const DEFAULT_PLANNED_DAYS = 60;
/** 최종 리포트 위치 (기획서 8장) */
export const PUBLISHED_REPORT = path.join("reports", "stage0-report.md");

export interface RunnerDeps {
  store: RunStore;
  adapter: LlmAdapter;
  config: RunConfig;
  log: (line: string) => void;
}

/** 새 run을 만들거나, 있는 run을 이어서 쓸 수 있는지 확인한다. */
export function openRun(
  store: RunStore,
  args: { runId: string; characterFile: string; character: CharacterInput; mock: boolean; config: RunConfig; targetDay: number },
): { meta: RunMeta; created: boolean } {
  const { runId, characterFile, character, mock, config, targetDay } = args;
  if (!store.exists()) {
    const meta: RunMeta = {
      run_id: runId,
      created_at: new Date().toISOString(),
      adapter: mock ? "mock" : "anthropic",
      character_file: characterFile,
      character_id: character.id,
      seed: runId,
      story_start_date: character.story_start_date,
      hemisphere: character.hemisphere,
      planned_days: Math.max(DEFAULT_PLANNED_DAYS, targetDay),
      models: { daily: config.dailyModel, audit: config.auditModel },
      effort: { daily: config.dailyEffort, audit: config.auditEffort },
    };
    store.create(meta, character);
    return { meta, created: true };
  }

  const meta = store.readMeta();
  const problems: string[] = [];
  if (meta.adapter !== (mock ? "mock" : "anthropic")) {
    problems.push(`이 run은 ${meta.adapter === "mock" ? "모의" : "실제"} 실행으로 만들었다`);
  }
  if (meta.character_id !== character.id) problems.push(`이 run의 인물은 ${meta.character_id}다`);
  if (meta.models.daily !== config.dailyModel || meta.models.audit !== config.auditModel) {
    problems.push(`이 run은 모델 ${meta.models.daily} / ${meta.models.audit}로 시작했다 (지금 설정: ${config.dailyModel} / ${config.auditModel})`);
  }
  if (meta.effort.daily !== config.dailyEffort || meta.effort.audit !== config.auditEffort) {
    problems.push(
      `이 run은 effort ${meta.effort.daily ?? "기본값"} / ${meta.effort.audit ?? "기본값"}로 시작했다 (지금 설정: ${config.dailyEffort ?? "기본값"} / ${config.auditEffort ?? "기본값"})`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `run '${runId}'을 이어서 실행할 수 없다:\n${problems.map((p) => `  - ${p}`).join("\n")}\n설정을 원래대로 돌리거나, --run 으로 새 이름을 줘서 처음부터 시작한다.`,
    );
  }
  if (targetDay > meta.planned_days) {
    meta.planned_days = targetDay;
    store.writeMeta(meta);
  }
  return { meta, created: false };
}

export interface Estimate {
  fromDay: number;
  toDay: number;
  days: number;
  audits: number;
  basis: "observed" | "assumed";
  expectedUsd: number;
  worstUsd: number;
  spentUsd: number;
  inputTokensAssumed?: number;
}

/** 실행 전 예상 호출 수와 비용. 지난 실측값이 있으면 그것을, 없으면 토큰 수를 세서 추정한다. */
export async function estimateRun(deps: RunnerDeps, meta: RunMeta, targetDay: number): Promise<Estimate> {
  const { store, adapter, config } = deps;
  const saved = store.readState();
  const fromDay = saved.last_day + 1;
  const days = Math.max(0, targetDay - saved.last_day);
  const audits = pendingAuditWindows(store, meta, saved.last_day).length + countAuditWindows(fromDay, targetDay, meta.planned_days);
  const spentUsd = store.totalCostUsd();

  const pastDays = store.readDays(saved.last_day);
  const pastAudits = store.readAudits();

  // 다음 날 프롬프트의 실제 토큰 수
  const info = describeDay(meta.story_start_date, fromDay, meta.hemisphere);
  const system = buildDiarySystem(saved.state, meta.hemisphere);
  const user = buildDiaryUser({ state: saved.state, info, intensity: "small" });
  const inputTokens = days > 0 ? await adapter.countInputTokens({
    purpose: "diary",
    model: config.dailyModel,
    system,
    user,
    schema: DiaryOutputSchema,
    maxTokens: DIARY_MAX_TOKENS,
  }) : 0;
  // 기억이 쌓이면서 늘어날 몫 (최근 7일 요약 + 주 단위 요약)
  const grownInput = inputTokens + 1500;

  let perDay: number;
  let perAudit: number;
  let basis: Estimate["basis"];
  if (pastDays.length >= 3) {
    basis = "observed";
    perDay = pastDays.reduce((s, d) => s + d.cost_usd, 0) / pastDays.length;
    perAudit =
      pastAudits.length > 0
        ? pastAudits.reduce((s, a) => s + a.cost_usd, 0) / pastAudits.length
        : costUsd(config.auditModel, { input: 15_000, output: 4_000, cache_write: 0, cache_read: 0 });
  } else {
    basis = "assumed";
    // 가정: 하루 출력 3,000 토큰 (일기 + JSON + thinking), 평균 1.2번 시도, 캐시 효과는 넣지 않는다
    perDay = 1.2 * costUsd(config.dailyModel, { input: grownInput, output: 3_000, cache_write: 0, cache_read: 0 });
    perAudit = costUsd(config.auditModel, { input: 15_000, output: 4_000, cache_write: 0, cache_read: 0 });
  }

  const auditSystemTokens = buildAuditSystem().length;
  const worstUsd =
    days * (MAX_REGENERATIONS + 1) * worstCaseUsd(config.dailyModel, grownInput + 2_000, DIARY_MAX_TOKENS) +
    audits * worstCaseUsd(config.auditModel, 20_000 + auditSystemTokens, AUDIT_MAX_TOKENS);

  return {
    fromDay,
    toDay: targetDay,
    days,
    audits,
    basis,
    expectedUsd: days * perDay + audits * perAudit,
    worstUsd,
    spentUsd,
    ...(basis === "assumed" ? { inputTokensAssumed: grownInput } : {}),
  };
}

export interface RunResult {
  lastDay: number;
  stoppedBy: "done" | "budget";
  spentThisRunUsd: number;
  newDays: DayRecord[];
}

/** targetDay까지 하루씩 생성한다. 하루가 끝날 때마다 저장한다. */
export async function runDays(deps: RunnerDeps, meta: RunMeta, targetDay: number): Promise<RunResult> {
  const { store, adapter, config, log } = deps;
  const startSpent = store.totalCostUsd();
  const budget = new BudgetGuard(config.budgetUsd, startSpent);
  const onCall = (e: Parameters<CallOptions["onCall"]>[0]) => store.appendCall(e);
  const dailyOpts: CallOptions = { adapter, budget, model: meta.models.daily, effort: meta.effort.daily ?? undefined, onCall };
  const auditOpts: CallOptions = { adapter, budget, model: meta.models.audit, effort: meta.effort.audit ?? undefined, onCall };
  const won = (usd: number) => `${(usd * config.usdKrw).toFixed(2)}원`;

  let saved = store.readState();
  const newDays: DayRecord[] = [];
  const finish = (stoppedBy: RunResult["stoppedBy"]): RunResult => ({
    lastDay: saved.last_day,
    stoppedBy,
    spentThisRunUsd: budget.spentUsd - startSpent,
    newDays,
  });

  // 지난 실행이 감사 직전에 멈췄다면 그 감사부터 한다
  for (const w of pendingAuditWindows(store, meta, saved.last_day)) {
    if (!(await audit(w))) return finish("budget");
  }

  const history: Intensity[] = store.readDays(saved.last_day).map((d) => d.intensity);
  for (let day = saved.last_day + 1; day <= targetDay; day++) {
    const info = describeDay(meta.story_start_date, day, meta.hemisphere);
    const intensity = drawIntensity(meta.seed, day, history);
    const result = await generateDay(dailyOpts, { state: saved.state, info, intensity, hemisphere: meta.hemisphere });
    if (result.kind === "budget") {
      log(`  ${day}일째: 비용 상한 ${config.budgetUsd}달러에 닿아 멈춘다 (누적 $${budget.spentUsd.toFixed(4)}).`);
      return finish("budget");
    }

    const { attempts, output } = result;
    const totals = sumAttempts(attempts);
    // 앞선 시도에서 걸린 문제는, 마지막 시도가 채택됐다면 재생성으로 해결된 것이다
    const finalAttempt = attempts.length;
    const consistency = attempts.flatMap((a) =>
      a.issues.map((i) => ({ ...i, attempt: a.attempt, resolved: output !== null && a.attempt < finalAttempt })),
    );

    let record: DayRecord;
    if (output) {
      const applied = applyDiary(saved.state, output, { day, date: info.date, intensity });
      saved = { last_day: day, state: applied.state };
      record = {
        day,
        date_in_story: info.date,
        weekday: info.weekday,
        season: info.season,
        intensity,
        status: "ok",
        model: meta.models.daily,
        diary: output.diary,
        headline: output.headline,
        summary: output.summary,
        scene: output.scene,
        reported_intensity: output.event_intensity,
        people_present: output.people_present,
        state_changes: applied.changes,
        consistency_issues: consistency,
        attempts,
        tokens: totals.tokens,
        cost_usd: totals.cost_usd,
        generated_at: new Date().toISOString(),
      };
    } else {
      saved = { last_day: day, state: saved.state };
      record = {
        day,
        date_in_story: info.date,
        weekday: info.weekday,
        season: info.season,
        intensity,
        status: "error",
        model: meta.models.daily,
        diary: null,
        headline: null,
        summary: null,
        scene: null,
        reported_intensity: null,
        people_present: [],
        state_changes: [],
        consistency_issues: consistency,
        attempts,
        tokens: totals.tokens,
        cost_usd: totals.cost_usd,
        generated_at: new Date().toISOString(),
      };
    }
    store.writeDay(record);
    store.writeState(saved);
    history.push(intensity);
    newDays.push(record);

    const mark = record.status === "ok" ? "✓" : "✗ 실패";
    log(
      `  ${String(day).padStart(2)}일째 ${shortDate(info.date)} ${INTENSITY_LABELS_KO[intensity].padEnd(5)} ${mark} 시도 ${attempts.length}번 · ${won(record.cost_usd)}${record.headline ? ` · ${record.headline}` : ""}`,
    );

    const w = auditWindowEndingAt(day, meta.planned_days);
    if (w && !(await audit(w))) return finish("budget");
  }
  return finish("done");

  async function audit(w: AuditWindow): Promise<boolean> {
    const days = store.readDays(w.toDay).filter((d) => d.day >= w.fromDay);
    const res = await runAudit(auditOpts, store.readState().state, w, days);
    if (res.kind === "budget") {
      log(`  ${w.week}주차 감사: 비용 상한 ${config.budgetUsd}달러에 닿아 멈춘다.`);
      return false;
    }
    store.writeAudit(res.record);
    const r = res.record;
    const fatal = r.findings.filter((f) => f.severity === "fatal").length;
    log(
      r.status === "ok"
        ? `  ↳ ${w.week}주차 감사 (${w.fromDay}~${w.toDay}일째): 모순 ${r.findings.length}건 (치명적 ${fatal}) · ${won(r.cost_usd)}`
        : `  ↳ ${w.week}주차 감사 실패: ${r.error}`,
    );
    return true;
  }
}

/** 이미 끝난 날 중에서 감사가 빠진 주 */
function pendingAuditWindows(store: RunStore, meta: RunMeta, lastDay: number): AuditWindow[] {
  const out: AuditWindow[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const w = auditWindowEndingAt(d, meta.planned_days);
    if (w && !store.hasAudit(w.week)) out.push(w);
  }
  return out;
}

function countAuditWindows(fromDay: number, toDay: number, plannedDays: number): number {
  let n = 0;
  for (let d = fromDay; d <= toDay; d++) if (auditWindowEndingAt(d, plannedDays)) n++;
  return n;
}

/** run 폴더에 리포트를 쓰고, publish면 reports/stage0-report.md에도 쓴다. */
export function saveReports(store: RunStore, config: RunConfig, opts: { publish: boolean }): string[] {
  const meta = store.readMeta();
  const saved = store.readState();
  const markdown = buildReport({
    meta,
    initial: store.readInitialCharacter(),
    saved,
    days: store.readDays(saved.last_day),
    audits: store.readAudits(),
    calls: store.readCalls(),
    money: {
      usdKrw: config.usdKrw,
      targetKrwPerDay: config.targetKrwPerDay,
      subscriptionKrw: config.subscriptionKrw,
      budgetUsd: config.budgetUsd,
    },
  });
  const written = [store.writeReport(markdown)];
  if (opts.publish) {
    writeText(PUBLISHED_REPORT, markdown);
    written.push(PUBLISHED_REPORT);
  }
  return written;
}
