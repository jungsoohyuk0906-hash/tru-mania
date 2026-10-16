import { shortDate } from "./engine/calendar.js";
import type { CallLogEntry } from "./engine/generate.js";
import { INTENSITY_LABELS_KO, INTENSITY_ORDER, INTENSITY_WEIGHTS, intensityRank } from "./engine/intensity.js";
import { ACTIVITIES, LOCATIONS, TIMES_OF_DAY, WEATHERS } from "./scene/vocabulary.js";
import type { CharacterInput, CharacterState, Intensity } from "./schema/character.js";
import type { AuditFinding, AuditRecord, DayRecord } from "./schema/day.js";
import type { RunMeta, SavedState } from "./store.js";

// 기획서 8장 "0단계 검증 리포트와 통과 기준" 형식의 리포트를 만든다.
// 통과 여부는 기준을 글자 그대로 적용한 기계적 판정이다. 해석이 갈리는 부분은 "사람이 결정할 것"에 따로 적는다.

export interface ReportInput {
  meta: RunMeta;
  initial: CharacterInput;
  saved: SavedState;
  days: DayRecord[];
  audits: AuditRecord[];
  calls: CallLogEntry[];
  money: { usdKrw: number; targetKrwPerDay: number; subscriptionKrw: number; budgetUsd: number };
}

const MAX_MINOR = 3;
const MAX_COST_GROWTH = 1.5;
const QUIET_RANGE = [0.5, 0.6] as const;

export function buildReport(input: ReportInput): string {
  const { meta, initial, saved, days, audits, calls, money } = input;
  const out: string[] = [];
  const krw = (usd: number) => usd * money.usdKrw;
  const won = (usd: number) => fmtWon(krw(usd));

  const okDays = days.filter((d) => d.status === "ok");
  const errorDays = days.filter((d) => d.status === "error");
  const n = days.length;
  const complete = saved.last_day >= meta.planned_days;
  const isMock = meta.adapter === "mock";
  const totalUsd = calls.reduce((s, c) => s + c.cost_usd, 0);
  const auditUsd = calls.filter((c) => c.purpose === "audit").reduce((s, c) => s + c.cost_usd, 0);
  const allFindings = audits.flatMap((a) => a.findings);
  const fatalFindings = allFindings.filter((f) => f.severity === "fatal");
  const minorFindings = allFindings.filter((f) => f.severity === "minor");
  const validationIssues = days.flatMap((d) => d.consistency_issues.filter((i) => i.blocking).map((i) => ({ ...i, day: d })));
  const caughtFatal = validationIssues.filter((i) => i.severity === "fatal");

  // ── 머리말
  out.push(`# 트루무비 0단계 검증 리포트`);
  out.push("");
  if (isMock) {
    out.push("> **모의 실행(mock)** — 실제 AI 호출 없이 파이프라인만 확인한 결과다. 일기 내용, 토큰, 비용 수치는 의미가 없다.");
    out.push("");
  }
  if (!complete) {
    out.push(`> **중간 리포트** — 계획 ${meta.planned_days}일 중 ${saved.last_day}일까지 진행했다. 기준 판정은 지금까지의 결과에 대한 참고값이다.`);
    out.push("");
  }
  const first = days[0];
  const last = days[days.length - 1];
  out.push(`- 인물: ${initial.state.immutable.name} (\`${meta.character_file}\`)`);
  out.push(`- 실행: \`${meta.run_id}\` · 시드 \`${meta.seed}\``);
  out.push(`- 생성한 날: ${n}일 (채택 ${okDays.length}일, 실패 ${errorDays.length}일) / 계획 ${meta.planned_days}일`);
  if (first && last) out.push(`- 이야기 속 기간: ${first.date_in_story} ~ ${last.date_in_story}`);
  out.push(
    `- 모델: 매일 일기 \`${meta.models.daily}\` (effort ${meta.effort.daily ?? "기본값"}) · 주간 감사 \`${meta.models.audit}\` (effort ${meta.effort.audit ?? "기본값"})`,
  );
  out.push(
    `- 누적 비용: ${fmtUsd(totalUsd)} (${won(totalUsd)}) · API 호출 ${calls.length}번 · 비용 상한 ${fmtUsd(money.budgetUsd)}`,
  );
  out.push(`- 환율 가정: 1달러 = ${money.usdKrw.toLocaleString("ko-KR")}원`);
  out.push("");

  // ── 통과 기준
  const perDayUsd = n > 0 ? totalUsd / n : 0;
  const day1 = days.find((d) => d.day === 1);
  const dayLast = last;
  const growth = day1 && dayLast && day1.cost_usd > 0 ? dayLast.cost_usd / day1.cost_usd : null;
  const firstWeek = days.filter((d) => d.day <= 7);
  const lastWeek = days.slice(-7);
  const weekGrowth =
    firstWeek.length > 0 && lastWeek.length > 0 && avg(firstWeek.map((d) => d.cost_usd)) > 0
      ? avg(lastWeek.map((d) => d.cost_usd)) / avg(firstWeek.map((d) => d.cost_usd))
      : null;
  const quietRatio = n > 0 ? days.filter((d) => d.intensity === "none").length / n : 0;
  const partial = complete ? "" : " (중간)";
  const verdict = (pass: boolean) => (pass ? "통과" : "미달") + partial;

  out.push("## 통과 기준 판정");
  out.push("");
  out.push("| 항목 | 기준 | 결과 | 판정 |");
  out.push("| --- | --- | --- | --- |");
  out.push(
    `| 치명적 모순 (불변 설정 변경, 사망자 재등장) | 0건 | 주간 감사에서 ${fatalFindings.length}건 (자동 검증이 막아 재생성한 시도 ${caughtFatal.length}건은 제외) | ${verdict(fatalFindings.length === 0)} |`,
  );
  out.push(
    `| 경미한 모순 (사소한 사실 불일치) | ${meta.planned_days}일 중 ${MAX_MINOR}건 이하 | 주간 감사에서 ${minorFindings.length}건 | ${verdict(minorFindings.length <= MAX_MINOR)} |`,
  );
  out.push(
    `| 하루 비용 | 인물 1명당 약 ${money.targetKrwPerDay}원 이하 | ${won(perDayUsd)} (재생성·감사 포함 전체 비용 ÷ ${n}일) | ${verdict(krw(perDayUsd) <= money.targetKrwPerDay)} |`,
  );
  out.push(
    `| 비용 추이 | 마지막 날이 1일차의 ${MAX_COST_GROWTH}배 이하 | ${
      growth === null || !day1 || !dayLast
        ? "계산 불가"
        : `1일차 ${won(day1.cost_usd)} → ${dayLast.day}일차 ${won(dayLast.cost_usd)} (×${growth.toFixed(2)})`
    } | ${growth === null ? "판정 불가" : verdict(growth <= MAX_COST_GROWTH)} |`,
  );
  out.push(
    `| 무사건 비율 | ${pct(QUIET_RANGE[0])}~${pct(QUIET_RANGE[1])} | ${pct(quietRatio)} (${n}일 중 ${days.filter((d) => d.intensity === "none").length}일) | ${verdict(quietRatio >= QUIET_RANGE[0] && quietRatio <= QUIET_RANGE[1])} |`,
  );
  out.push(`| 읽는 재미 | 샘플 5개를 직접 읽고 판단 | 6절 샘플 참고 | 사람 판단 |`);
  out.push("");
  if (weekGrowth !== null) {
    out.push(
      `비용 추이는 하루치 변동이 커서 주 평균으로도 본다: 첫 주 평균 ${won(avg(firstWeek.map((d) => d.cost_usd)))} → 마지막 7일 평균 ${won(avg(lastWeek.map((d) => d.cost_usd)))} (×${weekGrowth.toFixed(2)}).`,
    );
    out.push("");
  }

  // ── 1. 설정 원본과 현재 상태
  out.push(`## 1. 인물 설정 원본과 ${saved.last_day}일 뒤 상태`);
  out.push("");
  out.push(...compareStates(initial.state, saved.state));
  out.push("");

  // ── 2. 일관성 오류
  out.push("## 2. 일관성 오류 목록");
  out.push("");
  out.push(
    `자동 검증은 매일 일기를 받아들이기 전에 규칙 위반을 잡아 재생성한다 (최대 2번). 주간 감사는 채택된 일기 7일치를 상위 모델이 다시 읽고 모순을 찾는다.`,
  );
  out.push("");
  out.push(`### 자동 검증 (재생성 대상) — ${validationIssues.length}건`);
  out.push("");
  if (validationIssues.length === 0) {
    out.push("없음.");
  } else {
    out.push("| 날 | 날짜 | 시도 | 심각도 | 종류 | 내용 | 재생성으로 해결 |");
    out.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const i of validationIssues) {
      out.push(
        `| ${i.day.day} | ${shortDate(i.day.date_in_story)} | ${i.attempt} | ${sev(i.severity)} | ${i.code} | ${cell(i.message)} | ${i.resolved ? "예" : "아니오"} |`,
      );
    }
  }
  out.push("");
  const warnings = days.flatMap((d) => d.consistency_issues.filter((i) => !i.blocking).map((i) => ({ ...i, day: d })));
  if (warnings.length > 0) {
    out.push(`### 자동 검증 경고 (기록만, 재생성 안 함) — ${warnings.length}건`);
    out.push("");
    out.push("| 날 | 종류 | 내용 |");
    out.push("| --- | --- | --- |");
    for (const w of warnings) out.push(`| ${w.day.day} | ${w.code} | ${cell(w.message)} |`);
    out.push("");
  }
  out.push(`### 주간 감사 — ${allFindings.length}건 (치명적 ${fatalFindings.length}, 경미 ${minorFindings.length})`);
  out.push("");
  if (audits.length === 0) {
    out.push("아직 감사한 주가 없다 (7일째부터 감사한다).");
  } else {
    out.push("| 주차 | 기간 | 상태 | 발견 | 총평 |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const a of audits) {
      out.push(
        `| ${a.week} | ${a.from_day}~${a.to_day}일째 | ${a.status === "ok" ? "완료" : `실패: ${cell(a.error ?? "")}`} | ${a.findings.length}건 | ${cell(a.overall ?? "")} |`,
      );
    }
    out.push("");
    if (allFindings.length > 0) {
      out.push("| 날 | 심각도 | 종류 | 내용 | 근거 |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const f of allFindings) {
        out.push(`| ${f.day} | ${sev(f.severity)} | ${findingType(f)} | ${cell(f.description)} | ${cell(f.evidence)} |`);
      }
    }
  }
  out.push("");
  if (errorDays.length > 0) {
    out.push(`### 생성 실패한 날 — ${errorDays.length}일`);
    out.push("");
    out.push("재생성 2번 뒤에도 검증을 통과하지 못해 기록 없이 넘어간 날이다.");
    out.push("");
    for (const d of errorDays) {
      const lastAttempt = d.attempts[d.attempts.length - 1];
      const reasons = lastAttempt?.issues.filter((i) => i.blocking).map((i) => i.message).join("; ") ?? "";
      out.push(`- ${d.day}일째 ${shortDate(d.date_in_story)} [${INTENSITY_LABELS_KO[d.intensity]}]: ${reasons}`);
    }
    out.push("");
  }

  // ── 3. 사건 강도
  out.push("## 3. 사건 강도 분포");
  out.push("");
  out.push("코드가 확률로 뽑은 강도와, 채택된 일기에서 AI가 실제로 썼다고 보고한 강도를 함께 본다.");
  out.push("");
  out.push("| 강도 | 목표 비율 | 코드가 뽑은 비율 | AI가 쓴 비율 (채택된 날) |");
  out.push("| --- | --- | --- | --- |");
  for (const i of INTENSITY_ORDER) {
    const assigned = days.filter((d) => d.intensity === i).length;
    const reported = okDays.filter((d) => d.reported_intensity === i).length;
    out.push(
      `| ${INTENSITY_LABELS_KO[i]} | ${pct(INTENSITY_WEIGHTS[i])} | ${pct(ratio(assigned, n))} (${assigned}일) | ${pct(ratio(reported, okDays.length))} (${reported}일) |`,
    );
  }
  const downgraded = okDays.filter((d) => d.reported_intensity && intensityRank(d.reported_intensity) < intensityRank(d.intensity)).length;
  out.push("");
  out.push(`큰 사건 뒤 7일 금지와 중간 이상 연속 금지 규칙 때문에 중간·큰 사건은 목표보다 조금 덜 나온다. AI가 정해진 강도보다 작게 쓴 날: ${downgraded}일.`);
  out.push("");

  // ── 4. 토큰과 비용
  out.push("## 4. 토큰과 비용");
  out.push("");
  const diaryCalls = calls.filter((c) => c.purpose === "diary");
  const okAttempts = okDays.map((d) => d.attempts[d.attempts.length - 1]).filter((a) => a !== undefined);
  out.push("| 항목 | 값 |");
  out.push("| --- | --- |");
  out.push(`| 하루 평균 입력 토큰 (채택된 시도, 캐시 포함) | ${fmtInt(avg(okAttempts.map((a) => a.tokens.input + a.tokens.cache_read + a.tokens.cache_write)))} |`);
  out.push(`| 그중 캐시에서 읽은 토큰 | ${fmtInt(avg(okAttempts.map((a) => a.tokens.cache_read)))} |`);
  out.push(`| 하루 평균 출력 토큰 (채택된 시도, thinking 포함) | ${fmtInt(avg(okAttempts.map((a) => a.tokens.output)))} |`);
  out.push(`| 하루 평균 시도 횟수 | ${avg(days.map((d) => d.attempts.length)).toFixed(2)} |`);
  out.push(`| 일기 생성 비용 합계 | ${fmtUsd(sum(diaryCalls.map((c) => c.cost_usd)))} (${won(sum(diaryCalls.map((c) => c.cost_usd)))}) |`);
  out.push(`| 주간 감사 비용 합계 | ${fmtUsd(auditUsd)} (${won(auditUsd)}) |`);
  out.push(`| 하루 평균 비용 (전체 ÷ ${n}일) | ${fmtUsd(perDayUsd)} (${won(perDayUsd)}) |`);
  out.push(
    `| 30일 기준 월 원가 | ${won(perDayUsd * 30)} (월 구독료 ${money.subscriptionKrw.toLocaleString("ko-KR")}원의 ${pct(ratio(krw(perDayUsd * 30), money.subscriptionKrw))}) |`,
  );
  out.push("");
  out.push("### 날짜별 추이");
  out.push("");
  out.push("| 날 | 날짜 | 강도 | 시도 | 입력 | 캐시 읽기 | 출력 | 비용 |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const d of days) {
    out.push(
      `| ${d.day} | ${shortDate(d.date_in_story)} | ${INTENSITY_LABELS_KO[d.intensity]} | ${d.attempts.length}${d.status === "error" ? " (실패)" : ""} | ${fmtInt(d.tokens.input + d.tokens.cache_write)} | ${fmtInt(d.tokens.cache_read)} | ${fmtInt(d.tokens.output)} | ${won(d.cost_usd)} |`,
    );
  }
  out.push("");
  out.push("입력은 캐시에 쓴 토큰을 포함한다. 토큰과 비용은 그날의 모든 시도(재생성 포함)를 더한 값이다.");
  out.push("");

  // ── 5. 장면 분포
  out.push("## 5. 장면(scene) 분포");
  out.push("");
  const scenes = okDays.map((d) => d.scene).filter((s) => s !== null);
  const dims: [string, keyof NonNullable<DayRecord["scene"]>, readonly string[]][] = [
    ["장소", "location", LOCATIONS],
    ["행동", "activity", ACTIVITIES],
    ["시간대", "time_of_day", TIMES_OF_DAY],
    ["날씨", "weather", WEATHERS],
  ];
  for (const [label, key, values] of dims) {
    const counts = values.map((v) => [v, scenes.filter((s) => s[key] === v).length] as const);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    out.push(`- **${label}**: ${counts.map(([v, c]) => `${v} ${c} (${pct(ratio(c, scenes.length))})`).join(" · ")}`);
    if (top && scenes.length > 0 && top[1] / scenes.length > 0.5) {
      out.push(`  - ${top[0]}에 절반 넘게 몰렸다.`);
    }
  }
  out.push("");

  // ── 6. 샘플
  out.push("## 6. 읽어볼 만한 날 5개");
  out.push("");
  out.push("무사건 날 2개, 사건 있는 날 3개를 기간 전체에서 고르게 뽑았다. 읽는 재미는 이 글들로 판단한다.");
  out.push("");
  for (const d of pickSamples(okDays)) {
    out.push(`### ${d.day}일째 · ${shortDate(d.date_in_story)} · ${INTENSITY_LABELS_KO[d.intensity]} — ${d.headline ?? ""}`);
    out.push("");
    if (d.scene) out.push(`장면: ${d.scene.location} · ${d.scene.activity} · ${d.scene.time_of_day} · ${d.scene.weather}`);
    out.push("");
    out.push(...(d.diary ?? "").split("\n").map((l) => `> ${l}`));
    out.push("");
  }

  // ── 7. 사람이 결정할 것
  out.push("## 7. 다음 단계 전에 사람이 결정할 것");
  out.push("");
  for (const item of decisions({ input, complete, fatal: fatalFindings.length, minor: minorFindings.length, perDayKrw: krw(perDayUsd), growth, weekGrowth, quietRatio, errorDays })) {
    out.push(`- ${item}`);
  }
  out.push("");
  out.push(`_생성: ${new Date().toISOString()}_`);
  return `${out.join("\n")}\n`;
}

function compareStates(a: CharacterState, b: CharacterState): string[] {
  const out: string[] = [];
  const same = JSON.stringify(a.immutable) === JSON.stringify(b.immutable);
  out.push(`**불변**: ${same ? "변경 없음." : "원본과 다르다 — 코드 결함이다. 확인이 필요하다."}`);
  out.push("");
  out.push("**천천히 변함**");
  out.push("");
  out.push("| 항목 | 원본 | 현재 |");
  out.push("| --- | --- | --- |");
  const slowRows: [string, unknown, unknown][] = [
    ["직업", a.slow.job, b.slow.job],
    ["사는 곳", a.slow.residence, b.slow.residence],
    ["장기 목표", a.slow.long_term_goal, b.slow.long_term_goal],
    ["가치관", a.slow.values ?? "-", b.slow.values ?? "-"],
    ["관계", relText(a), relText(b)],
  ];
  for (const [k, x, y] of slowRows) out.push(`| ${k} | ${cell(String(x))} | ${cell(String(y))}${x !== y ? " **(바뀜)**" : ""} |`);
  out.push("");
  if (b.slow.change_log.length > 0) {
    out.push("변경 기록 (무엇이, 왜 바뀌었나):");
    out.push("");
    out.push("| 날 | 항목 | 이전 | 이후 | 이유 |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const c of b.slow.change_log) {
      out.push(`| ${c.day} | ${c.field} | ${cell(show(c.from))} | ${cell(show(c.to))} | ${cell(c.reason)} |`);
    }
    out.push("");
  } else {
    out.push("천천히 변하는 설정은 한 번도 바뀌지 않았다.");
    out.push("");
  }
  out.push("**자주 변함**");
  out.push("");
  out.push("| 항목 | 원본 | 현재 |");
  out.push("| --- | --- | --- |");
  out.push(`| 기분 | ${cell(a.volatile.mood)} | ${cell(b.volatile.mood)} |`);
  out.push(`| 건강 | ${cell(a.volatile.health)} | ${cell(b.volatile.health)} |`);
  out.push(`| 돈 사정 | ${cell(a.volatile.money)} | ${cell(b.volatile.money)} |`);
  out.push(`| 진행 중인 고민 | ${cell(a.volatile.open_concerns.join(" / ") || "-")} | ${cell(b.volatile.open_concerns.join(" / ") || "-")} |`);
  out.push("");
  const cast = b.memory.cast;
  const newcomers = cast.filter((c) => c.first_seen_day > 0);
  out.push("**기억**");
  out.push("");
  out.push(
    `- 등장 인물 ${cast.length}명 (활동 ${cast.filter((c) => c.status === "active").length}, 퇴장 ${cast.filter((c) => c.status === "departed").length}, 작고 ${cast.filter((c) => c.status === "deceased").length})`,
  );
  if (newcomers.length > 0) {
    out.push(`- 새로 등장한 사람: ${newcomers.map((c) => `${c.name}(${c.relation ?? "관계 미상"}, ${c.first_seen_day}일째)`).join(", ")}`);
  }
  out.push(`- 남아 있는 약속·미해결 일: ${b.memory.open_threads.join(" / ") || "없음"}`);
  out.push(`- 기억 압축: 최근 ${b.memory.recent_days.length}일은 요약 원문, 그 이전은 주 단위 요약 ${b.memory.weekly_summaries.length}개`);
  return out;
}

function decisions(args: {
  input: ReportInput;
  complete: boolean;
  fatal: number;
  minor: number;
  perDayKrw: number;
  growth: number | null;
  weekGrowth: number | null;
  quietRatio: number;
  errorDays: DayRecord[];
}): string[] {
  const { input, complete, fatal, minor, perDayKrw, growth, weekGrowth, quietRatio, errorDays } = args;
  const { meta, money } = input;
  const items: string[] = [];
  if (meta.adapter === "mock") {
    items.push("이 리포트는 모의 실행이다. 실제 판단은 API 키로 실제 모델을 돌린 리포트로 한다.");
  }
  if (!complete) {
    items.push(`아직 ${meta.planned_days}일 전체가 아니다. 이 결과를 보고 다음 단계(더 긴 실행)로 넘어갈지 정한다.`);
  }
  items.push("**읽는 재미**: 6절 샘플 5개를 읽고 \"계속 들여다보고 싶은가\"를 판단한다. 숫자로 잴 수 없는 유일한 기준이다.");
  if (fatal > 0) items.push(`치명적 모순이 ${fatal}건 나왔다. 기준(0건) 미달이다. 감사 결과가 실제 모순인지 확인하고, 프롬프트나 검증 규칙을 고칠지 정한다.`);
  if (minor > MAX_MINOR) items.push(`경미한 모순이 ${minor}건으로 기준(${MAX_MINOR}건)을 넘었다. 감사 모델이 너무 엄격한지, 실제로 기억이 흐트러지는지 판단이 필요하다.`);
  if (perDayKrw > money.targetKrwPerDay) items.push(`하루 비용이 목표(${money.targetKrwPerDay}원)를 넘었다. 모델, effort, 감사 주기 중 무엇을 바꿀지 정한다.`);
  if (growth !== null && weekGrowth !== null && (growth > MAX_COST_GROWTH) !== (weekGrowth > MAX_COST_GROWTH)) {
    items.push(
      `비용 추이 판정이 하루 기준(×${growth.toFixed(2)})과 주 평균 기준(×${weekGrowth.toFixed(2)})에서 다르게 나온다. 어느 쪽으로 판정할지 정한다.`,
    );
  }
  if (quietRatio < QUIET_RANGE[0] || quietRatio > QUIET_RANGE[1]) {
    items.push(`무사건 비율이 ${pct(quietRatio)}로 범위를 벗어났다. 확률 표본의 변동인지, 비율을 조정할지 정한다 (코드에서 임의로 바꾸지 않았다).`);
  }
  if (errorDays.length > 0) {
    items.push(`생성에 실패한 날이 ${errorDays.length}일 있다 (2절). 실패한 날을 허용할지, 재생성 횟수나 검증 규칙을 바꿀지 정한다.`);
  }
  items.push(
    `가정값 확인: 월 구독료 ${money.subscriptionKrw.toLocaleString("ko-KR")}원, 하루 목표 ${money.targetKrwPerDay}원, 환율 1달러 = ${money.usdKrw.toLocaleString("ko-KR")}원. 바뀌면 .env에서 고치고 \`npm run report\`로 다시 계산한다.`,
  );
  items.push(`모델 선택 유지 여부: 매일 \`${meta.models.daily}\`, 감사 \`${meta.models.audit}\`. 다른 모델과 비교하려면 새 run으로 같은 인물을 돌린다.`);
  items.push("장면 조합 규칙표(src/scene/rules.ts)가 1단계에서 만들 도트 부품과 맞는지 확인한다.");
  return items;
}

/** 무사건 2개 + 사건 있는 날 3개를 기간 전체에서 고르게 고른다. */
export function pickSamples(okDays: DayRecord[]): DayRecord[] {
  const quiet = okDays.filter((d) => d.intensity === "none");
  const eventful = okDays.filter((d) => d.intensity !== "none");
  const spread = (xs: DayRecord[], k: number) => {
    if (xs.length <= k) return xs;
    return Array.from({ length: k }, (_, i) => xs[Math.floor(((i + 0.5) * xs.length) / k)]).filter(
      (x): x is DayRecord => x !== undefined,
    );
  };
  const picked: DayRecord[] = [...spread(quiet, 2)];
  // 강한 사건부터 하나씩, 남는 자리는 고르게
  const byLevel = (["major", "medium", "small"] as Intensity[]).map((lv) => eventful.filter((d) => d.intensity === lv));
  const chosen: DayRecord[] = [];
  for (const group of byLevel) {
    const mid = group[Math.floor(group.length / 2)];
    if (mid && chosen.length < 3) chosen.push(mid);
  }
  for (const d of spread(eventful, 3)) {
    if (chosen.length >= 3) break;
    if (!chosen.includes(d)) chosen.push(d);
  }
  picked.push(...chosen);
  return picked.sort((a, b) => a.day - b.day);
}

function relText(s: CharacterState): string {
  return s.slow.relationships.map((r) => `${r.name}(${r.relation}, ${r.closeness})`).join(", ") || "-";
}

function show(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function findingType(f: AuditFinding): string {
  const ko: Record<AuditFinding["type"], string> = {
    immutable_contradiction: "불변 설정 위반",
    deceased_reappearance: "사망·퇴장자 재등장",
    personality_shift: "성격 급변",
    fact_mismatch: "사실 불일치",
    timeline: "시간 흐름",
    other: "기타",
  };
  return ko[f.type];
}

function sev(s: "fatal" | "minor"): string {
  return s === "fatal" ? "치명적" : "경미";
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

function sum(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0);
}

function ratio(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(x * 100 < 10 && x > 0 ? 1 : 0)}%`;
}

function fmtInt(x: number): string {
  return Math.round(x).toLocaleString("ko-KR");
}

function fmtUsd(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

function fmtWon(krw: number): string {
  return `${krw < 10 ? krw.toFixed(2) : krw < 100 ? krw.toFixed(1) : Math.round(krw).toLocaleString("ko-KR")}원`;
}
