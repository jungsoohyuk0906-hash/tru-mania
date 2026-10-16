import { z } from "zod";
import { SceneSchema } from "../scene/vocabulary.js";

// 기획서 5장 "데이터 모델". 인물 상태는 변하는 속도에 따라 네 계층으로 나눈다.

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 한다");

export const IntensitySchema = z.enum(["none", "small", "medium", "major"]);
export type Intensity = z.infer<typeof IntensitySchema>;

/** 불변 — 절대 바뀌지 않는다. AI는 읽기만 한다. */
export const ImmutableLayerSchema = z.object({
  name: z.string().min(1),
  birth_year: z.number().int(),
  hometown: z.string(),
  family: z.array(z.object({ relation: z.string(), name: z.string(), alive: z.boolean() })),
  core_traits: z.object({ mbti: z.string(), temperament: z.string() }),
});

export const RelationshipSchema = z.object({
  name: z.string(),
  relation: z.string(),
  closeness: z.number().min(0).max(1),
});

export const SlowChangeLogSchema = z.object({
  day: z.number().int(),
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
  reason: z.string(),
});

/** 천천히 변함 — 중간 사건 이상인 날에만 바뀐다. 변경 시 사유를 기록한다. */
export const SlowLayerSchema = z.object({
  job: z.string(),
  residence: z.string(),
  relationships: z.array(RelationshipSchema),
  long_term_goal: z.string(),
  values: z.string().optional(),
  change_log: z.array(SlowChangeLogSchema),
});

/** 자주 변함 — 매일 갱신된다. */
export const VolatileLayerSchema = z.object({
  mood: z.string(),
  health: z.string(),
  money: z.string(),
  open_concerns: z.array(z.string()),
  scene: SceneSchema,
});

export const RecentDaySchema = z.object({
  day: z.number().int(),
  date: DateString,
  intensity: IntensitySchema,
  headline: z.string(),
  summary: z.string(),
});

export const WeeklySummarySchema = z.object({
  week: z.number().int(),
  from_day: z.number().int(),
  to_day: z.number().int(),
  text: z.string(),
});

export const CastStatusSchema = z.enum(["active", "departed", "deceased"]);

export const CastMemberSchema = z.object({
  name: z.string(),
  relation: z.string().optional(),
  first_seen_day: z.number().int(),
  status: CastStatusSchema,
  note: z.string().optional(),
});

/** 기억 — 매일 추가되고, 오래된 것은 압축된다. */
export const MemoryLayerSchema = z.object({
  recent_days: z.array(RecentDaySchema),
  weekly_summaries: z.array(WeeklySummarySchema),
  cast: z.array(CastMemberSchema),
  open_threads: z.array(z.string()),
});

export const CharacterStateSchema = z.object({
  immutable: ImmutableLayerSchema,
  slow: SlowLayerSchema,
  volatile: VolatileLayerSchema,
  memory: MemoryLayerSchema,
});

/** data/characters/*.json 입력 형식. */
export const CharacterInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "영문 소문자, 숫자, - 만 쓴다"),
  story_start_date: DateString,
  hemisphere: z.enum(["north", "south"]).default("north"),
  state: CharacterStateSchema,
});

export type ImmutableLayer = z.infer<typeof ImmutableLayerSchema>;
export type SlowLayer = z.infer<typeof SlowLayerSchema>;
export type VolatileLayer = z.infer<typeof VolatileLayerSchema>;
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;
export type CastMember = z.infer<typeof CastMemberSchema>;
export type CharacterState = z.infer<typeof CharacterStateSchema>;
export type CharacterInput = z.infer<typeof CharacterInputSchema>;

/** 상태 변경 시 AI가 고칠 수 있는 필드. 그 밖의 필드는 검증에서 걸린다. */
export const EDITABLE_FIELDS = {
  volatile: ["mood", "health", "money"],
  slow: ["job", "residence", "long_term_goal", "values"],
} as const;

/** 불변 계층을 가리키는 필드 이름들. state_changes가 이 이름을 건드리면 치명적 오류다. */
export const IMMUTABLE_FIELD_NAMES = [
  "name",
  "birth_year",
  "hometown",
  "family",
  "core_traits",
  "mbti",
  "temperament",
] as const;
