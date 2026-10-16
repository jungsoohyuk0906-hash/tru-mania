import type { Intensity } from "../schema/character.js";
import { seededRandom } from "../util/random.js";

// 기획서 6장 1단계 "사건 강도 결정 (코드)".
// 비율과 제한은 기획서 값 그대로다. 바꾸려면 사람이 정한다.
export const INTENSITY_WEIGHTS: Record<Intensity, number> = {
  none: 0.55,
  small: 0.3,
  medium: 0.12,
  major: 0.03,
};

/** 큰 사건 뒤 최소 이 일수 동안은 큰 사건 금지 */
export const MAJOR_COOLDOWN_DAYS = 7;

export const INTENSITY_ORDER: Intensity[] = ["none", "small", "medium", "major"];

export const INTENSITY_LABELS_KO: Record<Intensity, string> = {
  none: "무사건",
  small: "작은 일",
  medium: "중간 사건",
  major: "큰 사건",
};

export const INTENSITY_GUIDE_KO: Record<Intensity, string> = {
  none: "특별한 일 없이 지나가는 하루. 루틴과 사소한 감상만 있다. 새로운 갈등이나 사건을 만들지 않는다.",
  small: "하루 기분을 조금 바꾸는 소소한 일 하나 (예: 오랜만의 연락, 작은 실수, 뜻밖의 칭찬). 삶의 설정은 바뀌지 않는다.",
  medium: "며칠 동안 영향이 남는 일 하나 (예: 가까운 사람과의 다툼, 일에서의 큰 피드백, 이사 제안). 천천히 변하는 설정이 바뀔 수 있다.",
  major: "삶의 방향을 바꿀 만한 일 하나 (예: 이직 결정, 이별, 가족의 큰 병). 천천히 변하는 설정이 바뀔 수 있다.",
};

export function intensityRank(i: Intensity): number {
  return INTENSITY_ORDER.indexOf(i);
}

/**
 * 오늘 허용되는 강도 목록.
 * @param history 1일차부터 어제까지 코드가 뽑은 강도 (index 0 = 1일차)
 */
export function allowedIntensities(history: Intensity[]): Intensity[] {
  const yesterday = history[history.length - 1];
  const recent = history.slice(-MAJOR_COOLDOWN_DAYS);
  const majorCooldown = recent.includes("major");
  const noConsecutiveBig = yesterday === "medium" || yesterday === "major";

  return INTENSITY_ORDER.filter((i) => {
    if (i === "major" && (majorCooldown || noConsecutiveBig)) return false;
    if (i === "medium" && noConsecutiveBig) return false;
    return true;
  });
}

/** 오늘의 강도를 뽑는다. 막힌 강도의 확률은 남은 강도에 비례해서 나눈다. */
export function drawIntensity(seed: string, day: number, history: Intensity[]): Intensity {
  const allowed = allowedIntensities(history);
  const total = allowed.reduce((sum, i) => sum + INTENSITY_WEIGHTS[i], 0);
  const roll = seededRandom(seed, `intensity:${day}`)() * total;
  let acc = 0;
  for (const i of allowed) {
    acc += INTENSITY_WEIGHTS[i];
    if (roll < acc) return i;
  }
  return allowed[allowed.length - 1] ?? "none";
}
