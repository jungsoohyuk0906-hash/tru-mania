import type { DayInfo } from "../engine/calendar.js";
import { ALLOWED_ACTIVITIES, snowMonths, type Hemisphere } from "../scene/rules.js";
import { LOCATIONS, TIMES_OF_DAY, type Location } from "../scene/vocabulary.js";
import type { Intensity } from "../schema/character.js";
import type { DiaryOutput, TokenUsage } from "../schema/day.js";
import { seededRandom } from "../util/random.js";
import type { LlmAdapter, LlmRequest, LlmResponse } from "./adapter.js";

// 모의 어댑터. API 키 없이 파이프라인 전체(검증, 재생성, 상태 반영, 기억 압축, 비용 기록, 리포트)를 돌려보기 위한 것이다.
// 글 내용과 토큰 수는 흉내일 뿐 실제 모델의 품질이나 비용을 뜻하지 않는다.

interface DiaryHint {
  kind: "diary";
  attempt: number;
  info: DayInfo;
  intensity: Intensity;
  name: string;
  known: string[];
  openConcerns: string[];
  openThreads: string[];
  hemisphere: Hemisphere;
}

interface AuditHint {
  kind: "audit";
  window: { week: number; fromDay: number; toDay: number };
  days: { day: number; ok: boolean }[];
}

export interface MockOptions {
  seed: string;
  /** 첫 시도에 일부러 규칙을 어길 확률 (재생성 경로 확인용) */
  faultRate?: number;
  /** 이 날들은 모든 시도에서 규칙을 어긴다 (실패 처리 경로 확인용) */
  alwaysFailDays?: number[];
}

export class MockAdapter implements LlmAdapter {
  readonly provider = "mock";
  private readonly opts: Required<MockOptions>;
  private readonly cached = new Set<string>();

  constructor(opts: MockOptions) {
    this.opts = { faultRate: 0.15, alwaysFailDays: [], ...opts };
  }

  async countInputTokens(req: LlmRequest): Promise<number> {
    return approxTokens(req.system + req.user);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const hint = req.mockHint as DiaryHint | AuditHint | undefined;
    const text =
      hint?.kind === "diary" ? JSON.stringify(this.diary(hint)) : hint?.kind === "audit" ? JSON.stringify(this.audit(hint)) : "{}";

    // 같은 system 프롬프트는 두 번째부터 캐시에서 읽은 것으로 친다.
    const sysTokens = approxTokens(req.system);
    const cacheKey = `${req.model}:${req.system}`;
    const hit = this.cached.has(cacheKey);
    this.cached.add(cacheKey);
    const tokens: TokenUsage = {
      input: approxTokens(req.user),
      cache_write: hit ? 0 : sysTokens,
      cache_read: hit ? sysTokens : 0,
      output: approxTokens(text) + 400,
    };
    return { text, stopReason: "end_turn", tokens };
  }

  private diary(h: DiaryHint): DiaryOutput {
    const rnd = seededRandom(this.opts.seed, `mock:${h.info.day}:${h.attempt}`);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

    const location: Location = pick(LOCATIONS);
    const activity = pick(ALLOWED_ACTIVITIES[location]);
    const weather = rnd() < 0.25 ? (snowMonths(h.hemisphere).includes(h.info.month) ? "snow" : "rain") : "clear";
    const friend = h.known.find((n) => n !== h.name);

    const out: DiaryOutput = {
      date: h.info.date,
      event_intensity: h.intensity,
      diary: mockDiaryText(h, rnd),
      headline: `${h.info.weekday}요일, ${HEADLINES[h.intensity]}`,
      summary: `${h.info.day}일째. ${SUMMARIES[h.intensity]}${friend && h.intensity !== "none" ? ` ${friend}와 연락했다.` : ""}`,
      scene: { location, activity, time_of_day: pick(TIMES_OF_DAY), weather },
      state_changes: [{ layer: "volatile", field: "mood", to: pick(MOODS), reason: "하루를 보내고 든 기분" }],
      relationship_updates: [],
      people_present: friend && h.intensity !== "none" ? [friend] : [],
      new_people: [],
      cast_updates: [],
      concerns_added: [],
      concerns_resolved: [],
      threads_added: [],
      threads_resolved: [],
    };

    if (h.intensity === "small" && rnd() < 0.3) out.concerns_added.push(`${h.info.day}일째에 생긴 작은 걱정`);
    if (h.intensity === "medium") {
      const newcomer = `모의인물${h.info.day}`;
      out.new_people.push({ name: newcomer, relation: "새로 알게 된 사람", note: "모의 실행용" });
      out.people_present.push(newcomer);
      if (h.openThreads[0]) out.threads_resolved.push(h.openThreads[0]);
      out.threads_added.push(`${newcomer}에게 답장하기`);
    }
    if (h.intensity === "major") {
      out.state_changes.push({ layer: "slow", field: "long_term_goal", to: `${h.info.day}일째에 다시 정한 목표`, reason: "큰 사건 이후 생각이 바뀜" });
    }
    if (h.openConcerns[0] && rnd() < 0.2) out.concerns_resolved.push(h.openConcerns[0]);

    // 일부러 규칙을 어겨 재생성·실패 처리 경로를 확인한다
    const forceFault = this.opts.alwaysFailDays.includes(h.info.day);
    if (forceFault || (h.attempt === 1 && rnd() < this.opts.faultRate)) {
      const fault = forceFault ? 0 : Math.floor(rnd() * 3);
      if (fault === 0) out.scene = { ...out.scene, location: "office", activity: "sleeping" };
      if (fault === 1) out.state_changes.push({ layer: "immutable", field: "hometown", to: "대구", reason: "모의 오류" });
      if (fault === 2) out.date = "1999-01-01";
    }
    return out;
  }

  private audit(h: AuditHint) {
    const rnd = seededRandom(this.opts.seed, `mock-audit:${h.window.week}`);
    const okDays = h.days.filter((d) => d.ok);
    const findings =
      okDays.length > 0 && rnd() < 0.3
        ? [
            {
              day: okDays[Math.floor(rnd() * okDays.length)]?.day ?? h.window.fromDay,
              severity: "minor" as const,
              type: "fact_mismatch" as const,
              description: "모의 감사: 전날 언급한 약속 시간이 다르게 적혀 있다",
              evidence: "(모의 인용)",
            },
          ]
        : [];
    return { findings, overall: `모의 감사 ${h.window.week}주차: ${h.window.fromDay}~${h.window.toDay}일째를 검토했다.` };
  }
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 1.6);
}

const HEADLINES: Record<Intensity, string> = {
  none: "별일 없이 지나간 하루",
  small: "작은 일이 하나 있었던 날",
  medium: "마음이 오래 남을 일이 생긴 날",
  major: "많은 것이 달라진 날",
};

const SUMMARIES: Record<Intensity, string> = {
  none: "평소처럼 일하고 쉬었다.",
  small: "소소한 일 하나로 기분이 조금 달라졌다.",
  medium: "며칠은 생각날 일이 있었다.",
  major: "앞으로의 방향을 다시 생각하게 됐다.",
};

const MOODS = ["보통", "피곤함", "조금 들뜸", "차분함", "울적함"];

const FILLER = [
  "아침에 일어나서 창문을 열었더니 공기가 생각보다 차가웠다.",
  "출근길 지하철은 오늘도 붐볐고, 나는 이어폰을 끼고 아무 생각 없이 창밖을 봤다.",
  "점심은 회사 근처 국숫집에서 혼자 먹었다. 국물이 짰지만 그래도 따뜻해서 좋았다.",
  "오후에는 원고를 붙잡고 있었는데 문장 하나가 끝까지 마음에 걸렸다.",
  "퇴근하고 편의점에 들러 우유와 귤을 샀다. 별것 아닌데 손에 들고 걷는 기분이 괜찮았다.",
  "저녁에는 빨래를 개면서 라디오를 틀어 두었다. 오래된 노래가 나와서 잠깐 따라 불렀다.",
  "자기 전에 내일 할 일을 적어 두었다. 적어 두면 조금 덜 불안하다.",
  "요즘은 하루가 빨리 지나간다. 그게 좋은 건지 나쁜 건지는 아직 모르겠다.",
];

function mockDiaryText(h: DiaryHint, rnd: () => number): string {
  const parts = [`${h.info.season}, ${h.info.weekday}요일.`];
  const order = [...FILLER].sort(() => rnd() - 0.5);
  parts.push(...order);
  if (h.intensity !== "none") parts.push(`오늘은 ${SUMMARIES[h.intensity]} 그 일을 오래 곱씹었다.`);
  parts.push("(모의 실행으로 만든 글이다.)");
  return parts.join(" ");
}
