import { z } from "zod";
import { SceneSchema } from "../scene/vocabulary.js";
import { CastStatusSchema, IntensitySchema } from "./character.js";

// AI가 하루치로 돌려주는 JSON. structured outputs로 형식을 강제하고, 내용은 validate.ts가 검사한다.
// layer, field는 일부러 자유 문자열로 둔다. 불변 계층을 건드리려는 시도를 코드가 잡아내기 위해서다.
export const DiaryOutputSchema = z.object({
  date: z.string(),
  event_intensity: IntensitySchema,
  diary: z.string(),
  headline: z.string(),
  summary: z.string(),
  scene: SceneSchema,
  state_changes: z.array(
    z.object({ layer: z.string(), field: z.string(), to: z.string(), reason: z.string() }),
  ),
  relationship_updates: z.array(
    z.object({ name: z.string(), relation: z.string(), closeness: z.number().min(0).max(1), reason: z.string() }),
  ),
  people_present: z.array(z.string()),
  new_people: z.array(z.object({ name: z.string(), relation: z.string(), note: z.string() })),
  cast_updates: z.array(z.object({ name: z.string(), status: CastStatusSchema, reason: z.string() })),
  concerns_added: z.array(z.string()),
  concerns_resolved: z.array(z.string()),
  threads_added: z.array(z.string()),
  threads_resolved: z.array(z.string()),
});
export type DiaryOutput = z.infer<typeof DiaryOutputSchema>;

export interface TokenUsage {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export interface ConsistencyIssue {
  code: string;
  severity: "fatal" | "minor";
  message: string;
  /** true면 그날 일기를 받아들이지 않고 재생성한다. false면 기록만 한다. */
  blocking: boolean;
}

export interface AttemptRecord {
  attempt: number;
  ok: boolean;
  stop_reason: string | null;
  error?: string;
  issues: ConsistencyIssue[];
  tokens: TokenUsage;
  cost_usd: number;
}

export interface StateChangeRecord {
  layer: "volatile" | "slow" | "memory";
  field: string;
  from: unknown;
  to: unknown;
  reason?: string;
}

/** data/runs/<run>/days/day-NNN.json — 기획서의 "하루 기록"을 확장한 형식. */
export interface DayRecord {
  day: number;
  date_in_story: string;
  weekday: string;
  season: string;
  /** 코드가 뽑은 오늘의 사건 강도 */
  intensity: z.infer<typeof IntensitySchema>;
  /** ok: 일기 채택, error: 재생성 2번 후에도 실패해 건너뛴 날 */
  status: "ok" | "error";
  model: string;
  diary: string | null;
  headline: string | null;
  summary: string | null;
  scene: z.infer<typeof SceneSchema> | null;
  reported_intensity: z.infer<typeof IntensitySchema> | null;
  people_present: string[];
  state_changes: StateChangeRecord[];
  /** 시도마다 나온 문제와, 이후 재생성으로 해결됐는지 */
  consistency_issues: (ConsistencyIssue & { attempt: number; resolved: boolean })[];
  attempts: AttemptRecord[];
  tokens: TokenUsage;
  cost_usd: number;
  generated_at: string;
}

export const AuditFindingSchema = z.object({
  day: z.number().int(),
  severity: z.enum(["fatal", "minor"]),
  type: z.enum([
    "immutable_contradiction",
    "deceased_reappearance",
    "personality_shift",
    "fact_mismatch",
    "timeline",
    "other",
  ]),
  description: z.string(),
  evidence: z.string(),
});
export const AuditOutputSchema = z.object({
  findings: z.array(AuditFindingSchema),
  overall: z.string(),
});
export type AuditOutput = z.infer<typeof AuditOutputSchema>;
export type AuditFinding = z.infer<typeof AuditFindingSchema>;

/** data/runs/<run>/audits/week-NN.json */
export interface AuditRecord {
  week: number;
  from_day: number;
  to_day: number;
  model: string;
  status: "ok" | "error";
  error?: string;
  findings: AuditFinding[];
  overall: string | null;
  tokens: TokenUsage;
  cost_usd: number;
  generated_at: string;
}
