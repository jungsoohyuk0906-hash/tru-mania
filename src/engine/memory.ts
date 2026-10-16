import { EDITABLE_FIELDS, type CharacterState, type Intensity, type MemoryLayer } from "../schema/character.js";
import type { DiaryOutput, StateChangeRecord } from "../schema/day.js";
import { shortDate } from "./calendar.js";
import { findItem, knownNames, sameName } from "./validate.js";

// 기획서 6장 6단계 "상태 반영과 기억 정리 (코드)".

/** 최근 며칠을 요약 원문으로 남길지. 그보다 오래된 날은 주 단위 요약으로 압축한다. */
export const RECENT_DAYS_KEPT = 7;

export interface ApplyContext {
  day: number;
  date: string;
  intensity: Intensity;
}

/** 검증을 통과한 하루치 결과를 상태에 반영한다. 원래 상태는 건드리지 않고 새 상태를 돌려준다. */
export function applyDiary(
  prev: CharacterState,
  out: DiaryOutput,
  ctx: ApplyContext,
): { state: CharacterState; changes: StateChangeRecord[] } {
  const state = structuredClone(prev);
  const changes: StateChangeRecord[] = [];
  const quietDay = ctx.intensity === "none" || ctx.intensity === "small";

  for (const c of out.state_changes) {
    const field = c.field.trim();
    if (c.layer === "volatile" && (EDITABLE_FIELDS.volatile as readonly string[]).includes(field)) {
      const key = field as (typeof EDITABLE_FIELDS.volatile)[number];
      const from = state.volatile[key];
      if (from !== c.to) {
        state.volatile[key] = c.to;
        changes.push({ layer: "volatile", field, from, to: c.to, reason: c.reason });
      }
    } else if (!quietDay && c.layer === "slow" && (EDITABLE_FIELDS.slow as readonly string[]).includes(field)) {
      const key = field as (typeof EDITABLE_FIELDS.slow)[number];
      const from = state.slow[key];
      if (from !== c.to) {
        state.slow[key] = c.to;
        state.slow.change_log.push({ day: ctx.day, field, from, to: c.to, reason: c.reason });
        changes.push({ layer: "slow", field, from, to: c.to, reason: c.reason });
      }
    }
  }

  // 새로 등장한 사람
  for (const p of out.new_people) {
    if (knownNames(state).some((k) => sameName(k, p.name))) continue;
    state.memory.cast.push({ name: p.name, relation: p.relation, first_seen_day: ctx.day, status: "active", note: p.note });
    changes.push({ layer: "memory", field: "cast", from: null, to: `${p.name} (${p.relation})`, reason: "첫 등장" });
  }
  // new_people에 없이 people_present에만 나온 이름도 등록해 둔다 (검증에서 경고로 기록됨)
  for (const name of out.people_present) {
    if (sameName(name, state.immutable.name) || knownNames(state).some((k) => sameName(k, name))) continue;
    state.memory.cast.push({ name, first_seen_day: ctx.day, status: "active", note: "자동 등록 (new_people 누락)" });
    changes.push({ layer: "memory", field: "cast", from: null, to: name, reason: "자동 등록" });
  }

  if (!quietDay) {
    for (const r of out.relationship_updates) {
      const existing = state.slow.relationships.find((x) => sameName(x.name, r.name));
      const from = existing ? { relation: existing.relation, closeness: existing.closeness } : null;
      const to = { relation: r.relation, closeness: r.closeness };
      if (existing) {
        existing.relation = r.relation;
        existing.closeness = r.closeness;
      } else {
        state.slow.relationships.push({ name: r.name, relation: r.relation, closeness: r.closeness });
        if (!state.memory.cast.some((c) => sameName(c.name, r.name))) {
          state.memory.cast.push({ name: r.name, relation: r.relation, first_seen_day: ctx.day, status: "active" });
        }
      }
      const field = `relationships.${existing?.name ?? r.name}`;
      state.slow.change_log.push({ day: ctx.day, field, from, to, reason: r.reason });
      changes.push({ layer: "slow", field, from, to, reason: r.reason });
    }
    for (const u of out.cast_updates) {
      if (state.immutable.family.some((f) => sameName(f.name, u.name))) continue;
      const member = state.memory.cast.find((c) => sameName(c.name, u.name));
      if (!member || member.status === u.status) continue;
      const from = member.status;
      member.status = u.status;
      changes.push({ layer: "memory", field: `cast.${member.name}.status`, from, to: u.status, reason: u.reason });
    }
  }

  // 고민과 미해결 일
  for (const r of out.concerns_resolved) {
    const hit = findItem(state.volatile.open_concerns, r);
    if (hit) state.volatile.open_concerns = state.volatile.open_concerns.filter((x) => x !== hit);
  }
  for (const a of out.concerns_added) {
    if (a.trim() && !state.volatile.open_concerns.includes(a.trim())) state.volatile.open_concerns.push(a.trim());
  }
  for (const r of out.threads_resolved) {
    const hit = findItem(state.memory.open_threads, r);
    if (hit) state.memory.open_threads = state.memory.open_threads.filter((x) => x !== hit);
  }
  for (const a of out.threads_added) {
    if (a.trim() && !state.memory.open_threads.includes(a.trim())) state.memory.open_threads.push(a.trim());
  }

  state.volatile.scene = out.scene;

  state.memory.recent_days.push({
    day: ctx.day,
    date: ctx.date,
    intensity: ctx.intensity,
    headline: out.headline.trim(),
    summary: out.summary.trim(),
  });
  state.memory = compactMemory(state.memory, ctx.day);

  return { state, changes };
}

/**
 * 최근 7일만 요약 원문으로 남기고, 그보다 오래된 날은 주 단위 요약으로 옮긴다.
 * 주 단위 요약은 그 주의 한 줄 요약(headline)을 이어 붙인 것이다.
 * 날이 지나도 프롬프트가 무한히 길어지지 않게 하는 장치다.
 */
export function compactMemory(memory: MemoryLayer, currentDay: number): MemoryLayer {
  const keepFrom = currentDay - RECENT_DAYS_KEPT + 1;
  const keep = memory.recent_days.filter((d) => d.day >= keepFrom);
  const old = memory.recent_days.filter((d) => d.day < keepFrom);
  if (old.length === 0) return memory;

  const weekly = memory.weekly_summaries.map((w) => ({ ...w }));
  for (const d of old) {
    const week = Math.ceil(d.day / 7);
    const entry = `${shortDate(d.date)} ${d.headline}`;
    const existing = weekly.find((w) => w.week === week);
    if (existing) {
      existing.text = `${existing.text} · ${entry}`;
      existing.from_day = Math.min(existing.from_day, d.day);
      existing.to_day = Math.max(existing.to_day, d.day);
    } else {
      weekly.push({ week, from_day: d.day, to_day: d.day, text: entry });
    }
  }
  weekly.sort((a, b) => a.week - b.week);
  return { ...memory, recent_days: keep, weekly_summaries: weekly };
}
