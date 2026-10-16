import { z } from "zod";

// 기획서 6장 "부품 목록 (1단계 최소 세트)". scene 값은 이 목록 안에서만 고른다.
export const LOCATIONS = ["home", "office", "cafe", "street", "transit"] as const;
export const ACTIVITIES = ["sleeping", "eating", "working", "laptop_work", "walking", "resting"] as const;
export const TIMES_OF_DAY = ["morning", "afternoon", "evening", "night"] as const;
export const WEATHERS = ["clear", "rain", "snow"] as const;

export type Location = (typeof LOCATIONS)[number];
export type Activity = (typeof ACTIVITIES)[number];
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];
export type Weather = (typeof WEATHERS)[number];

export const SceneSchema = z.object({
  location: z.enum(LOCATIONS),
  activity: z.enum(ACTIVITIES),
  time_of_day: z.enum(TIMES_OF_DAY),
  weather: z.enum(WEATHERS),
});
export type Scene = z.infer<typeof SceneSchema>;

export const SCENE_LABELS_KO: Record<string, string> = {
  home: "집",
  office: "직장",
  cafe: "카페",
  street: "거리",
  transit: "이동 중(지하철·버스)",
  sleeping: "잠",
  eating: "식사",
  working: "일",
  laptop_work: "노트북 작업",
  walking: "걷기",
  resting: "휴식",
  morning: "아침",
  afternoon: "오후",
  evening: "저녁",
  night: "밤",
  clear: "맑음",
  rain: "비",
  snow: "눈",
};
