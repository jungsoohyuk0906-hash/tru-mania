import {
  ACTIVITIES,
  LOCATIONS,
  TIMES_OF_DAY,
  WEATHERS,
  type Activity,
  type Location,
} from "./vocabulary.js";

// 허용되는 장소 × 행동 조합. 1단계에서 도트 부품으로 그릴 수 있는 조합만 남긴다.
// 기획서 예시: transit + sleeping 허용, office + sleeping 불가.
export const ALLOWED_ACTIVITIES: Record<Location, readonly Activity[]> = {
  home: ["sleeping", "eating", "working", "laptop_work", "resting"],
  office: ["eating", "working", "laptop_work", "resting"],
  cafe: ["eating", "working", "laptop_work", "resting"],
  street: ["eating", "working", "walking", "resting"],
  transit: ["sleeping", "laptop_work", "resting"],
};

// 눈이 올 수 있는 달. 북반구 기준, 남반구는 6개월 밀린다.
const SNOW_MONTHS_NORTH = [11, 12, 1, 2, 3];

export type Hemisphere = "north" | "south";

export function snowMonths(hemisphere: Hemisphere): number[] {
  if (hemisphere === "north") return SNOW_MONTHS_NORTH;
  return SNOW_MONTHS_NORTH.map((m) => ((m + 5) % 12) + 1);
}

/** scene 값이 부품 목록과 규칙표를 지키는지 검사한다. 문제가 없으면 빈 배열. */
export function checkScene(
  scene: { location: string; activity: string; time_of_day: string; weather: string },
  ctx: { month: number; hemisphere: Hemisphere },
): { code: string; message: string }[] {
  const problems: { code: string; message: string }[] = [];
  const inList = (list: readonly string[], v: string) => list.includes(v);

  if (!inList(LOCATIONS, scene.location)) {
    problems.push({ code: "SCENE_VOCAB", message: `장소 '${scene.location}'는 부품 목록에 없다 (${LOCATIONS.join(", ")})` });
  }
  if (!inList(ACTIVITIES, scene.activity)) {
    problems.push({ code: "SCENE_VOCAB", message: `행동 '${scene.activity}'는 부품 목록에 없다 (${ACTIVITIES.join(", ")})` });
  }
  if (!inList(TIMES_OF_DAY, scene.time_of_day)) {
    problems.push({ code: "SCENE_VOCAB", message: `시간대 '${scene.time_of_day}'는 부품 목록에 없다 (${TIMES_OF_DAY.join(", ")})` });
  }
  if (!inList(WEATHERS, scene.weather)) {
    problems.push({ code: "SCENE_VOCAB", message: `날씨 '${scene.weather}'는 부품 목록에 없다 (${WEATHERS.join(", ")})` });
  }
  if (problems.length > 0) return problems;

  const allowed = ALLOWED_ACTIVITIES[scene.location as Location];
  if (!allowed.includes(scene.activity as Activity)) {
    problems.push({
      code: "SCENE_COMBO",
      message: `장면 조합 ${scene.location} + ${scene.activity}는 허용되지 않는다 (${scene.location}에서 가능한 행동: ${allowed.join(", ")})`,
    });
  }
  if (scene.weather === "snow" && !snowMonths(ctx.hemisphere).includes(ctx.month)) {
    problems.push({ code: "SCENE_WEATHER_SEASON", message: `${ctx.month}월에는 눈(snow)이 올 수 없다` });
  }
  return problems;
}

/** 프롬프트에 넣을 규칙표 설명. 매일 같은 문자열이어야 캐싱이 유지된다. */
export function describeSceneRules(hemisphere: Hemisphere): string {
  const lines = LOCATIONS.map((loc) => `  - ${loc}: ${ALLOWED_ACTIVITIES[loc].join(", ")}`);
  return [
    `- location: ${LOCATIONS.join(", ")}`,
    `- activity: ${ACTIVITIES.join(", ")}`,
    `- time_of_day: ${TIMES_OF_DAY.join(", ")}`,
    `- weather: ${WEATHERS.join(", ")}`,
    "장소별로 가능한 행동:",
    ...lines,
    `눈(snow)은 ${snowMonths(hemisphere).join("·")}월에만 쓴다.`,
  ].join("\n");
}
