import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDay, storyDate } from "../src/engine/calendar.js";
import { allowedIntensities, drawIntensity, MAJOR_COOLDOWN_DAYS } from "../src/engine/intensity.js";
import { applyDiary, compactMemory } from "../src/engine/memory.js";
import { parseAndValidate, sameName, type ValidationContext } from "../src/engine/validate.js";
import { checkScene } from "../src/scene/rules.js";
import type { CharacterState, Intensity } from "../src/schema/character.js";
import type { DiaryOutput } from "../src/schema/day.js";
import { loadCharacter } from "../src/character.js";

const base = loadCharacter("data/characters/seoyun.json").state;

function schedule(seed: string, days: number): Intensity[] {
  const h: Intensity[] = [];
  for (let d = 1; d <= days; d++) h.push(drawIntensity(seed, d, h));
  return h;
}

test("사건 강도: 같은 seed면 같은 결과", () => {
  assert.deepEqual(schedule("a", 60), schedule("a", 60));
  assert.notDeepEqual(schedule("a", 60), schedule("b", 60));
});

test("사건 강도: 큰 사건 뒤 7일 금지, 중간 이상 연속 금지", () => {
  for (let s = 0; s < 500; s++) {
    const h = schedule(`s${s}`, 60);
    h.forEach((x, i) => {
      if (i > 0 && (h[i - 1] === "medium" || h[i - 1] === "major")) {
        assert.ok(x === "none" || x === "small", `seed s${s} day ${i + 1}`);
      }
      if (x === "major") {
        const window = h.slice(Math.max(0, i - MAJOR_COOLDOWN_DAYS), i);
        assert.ok(!window.includes("major"), `seed s${s} day ${i + 1}: major within cooldown`);
      }
    });
  }
  assert.deepEqual(allowedIntensities([]), ["none", "small", "medium", "major"]);
  assert.deepEqual(allowedIntensities(["medium"]), ["none", "small"]);
  assert.deepEqual(allowedIntensities(["major", "none"]), ["none", "small", "medium"]);
});

test("달력: 날짜는 하루씩, 요일과 계절", () => {
  assert.equal(storyDate("2026-03-01", 12), "2026-03-12");
  assert.equal(storyDate("2026-02-28", 2), "2026-03-01");
  const d = describeDay("2026-03-01", 1, "north");
  assert.equal(d.weekday, "일");
  assert.equal(d.isWeekend, true);
  assert.equal(d.season, "봄");
  assert.equal(describeDay("2026-03-01", 1, "south").season, "가을");
});

test("장면 규칙표: transit+sleeping 허용, office+sleeping 불가, 계절 밖 눈 불가", () => {
  const ctx = { month: 3, hemisphere: "north" as const };
  assert.deepEqual(checkScene({ location: "transit", activity: "sleeping", time_of_day: "night", weather: "clear" }, ctx), []);
  assert.equal(checkScene({ location: "office", activity: "sleeping", time_of_day: "night", weather: "clear" }, ctx)[0]?.code, "SCENE_COMBO");
  assert.equal(
    checkScene({ location: "home", activity: "resting", time_of_day: "night", weather: "snow" }, { month: 7, hemisphere: "north" })[0]?.code,
    "SCENE_WEATHER_SEASON",
  );
  assert.equal(checkScene({ location: "moon", activity: "resting", time_of_day: "night", weather: "clear" }, ctx)[0]?.code, "SCENE_VOCAB");
});

test("이름 비교: 성 뺀 이름과 호칭은 같은 사람", () => {
  assert.ok(sameName("이도현", "도현"));
  assert.ok(sameName("도현이", "이도현"));
  assert.ok(sameName("김정희", "김 정희"));
  assert.ok(!sameName("이도현", "이도윤"));
  assert.ok(!sameName("현", "이도현"));
});

function goodOutput(over: Partial<DiaryOutput> = {}): DiaryOutput {
  return {
    date: "2026-03-12",
    event_intensity: "none",
    diary: "오늘도 별일 없이 지나갔다. ".repeat(30),
    headline: "조용한 목요일",
    summary: "출근하고 퇴근했다.",
    scene: { location: "office", activity: "working", time_of_day: "afternoon", weather: "clear" },
    state_changes: [],
    relationship_updates: [],
    people_present: [],
    new_people: [],
    cast_updates: [],
    concerns_added: [],
    concerns_resolved: [],
    threads_added: [],
    threads_resolved: [],
    ...over,
  };
}

const vctx = (intensity: Intensity, state: CharacterState = base): ValidationContext => ({
  state,
  day: 12,
  date: "2026-03-12",
  month: 3,
  hemisphere: "north",
  intensity,
});

const codes = (text: string, ctx: ValidationContext) =>
  parseAndValidate(text, ctx).issues.filter((i) => i.blocking).map((i) => `${i.code}:${i.severity}`);

test("검증: 정상 출력은 통과", () => {
  const r = parseAndValidate(JSON.stringify(goodOutput()), vctx("none"));
  assert.ok(r.output);
  assert.deepEqual(r.issues, []);
});

test("검증: JSON 아님, scene 목록 밖 값", () => {
  assert.deepEqual(codes("not json", vctx("none")), ["FORMAT:minor"]);
  const bad = { ...goodOutput(), scene: { location: "moon", activity: "working", time_of_day: "afternoon", weather: "clear" } };
  assert.deepEqual(codes(JSON.stringify(bad), vctx("none")), ["SCENE_VOCAB:minor"]);
});

test("검증: 불변 계층 변경은 치명적", () => {
  const out = goodOutput({ state_changes: [{ layer: "immutable", field: "hometown", to: "대구", reason: "" }] });
  assert.deepEqual(codes(JSON.stringify(out), vctx("major")), ["IMMUTABLE_CHANGE:fatal"]);
  const viaField = goodOutput({ state_changes: [{ layer: "slow", field: "core_traits.mbti", to: "ENFP", reason: "" }] });
  assert.deepEqual(codes(JSON.stringify(viaField), vctx("major")), ["IMMUTABLE_CHANGE:fatal"]);
  const family = goodOutput({ event_intensity: "major", cast_updates: [{ name: "김정희", status: "deceased", reason: "" }] });
  assert.deepEqual(codes(JSON.stringify(family), vctx("major")), ["IMMUTABLE_CHANGE:fatal"]);
});

test("검증: 중간 사건 미만인 날 천천히 변하는 설정 변경 금지", () => {
  const out = goodOutput({ state_changes: [{ layer: "slow", field: "job", to: "프리랜서", reason: "" }] });
  assert.deepEqual(codes(JSON.stringify(out), vctx("small")), ["SLOW_CHANGE_ON_QUIET_DAY:minor"]);
  assert.deepEqual(codes(JSON.stringify({ ...out, event_intensity: "medium" }), vctx("medium")), []);
});

test("검증: 사건 강도 초과, 날짜 불일치", () => {
  assert.deepEqual(codes(JSON.stringify(goodOutput({ event_intensity: "medium" })), vctx("small")), ["INTENSITY_EXCEEDED:minor"]);
  assert.deepEqual(codes(JSON.stringify(goodOutput({ date: "2026-03-13" })), vctx("none")), ["DATE_MISMATCH:minor"]);
});

test("검증: 사망자 재등장은 치명적, 퇴장자 재등장은 경미", () => {
  const state = structuredClone(base);
  state.memory.cast.push({ name: "박민수", first_seen_day: 2, status: "deceased" });
  state.memory.cast.push({ name: "최유리", first_seen_day: 3, status: "departed" });
  assert.deepEqual(codes(JSON.stringify(goodOutput({ people_present: ["민수"] })), vctx("none", state)), ["DECEASED_REAPPEARED:fatal"]);
  assert.deepEqual(codes(JSON.stringify(goodOutput({ people_present: ["최유리"] })), vctx("none", state)), ["DEPARTED_REAPPEARED:minor"]);
});

test("검증: 이미 아는 사람을 새 인물로 등록하면 재생성", () => {
  const out = goodOutput({ new_people: [{ name: "도현", relation: "친구", note: "" }] });
  assert.deepEqual(codes(JSON.stringify(out), vctx("none")), ["DUPLICATE_PERSON:minor"]);
});

test("상태 반영: 자주 변함, 새 인물, 미해결 일, 기억", () => {
  const out = goodOutput({
    event_intensity: "small",
    state_changes: [{ layer: "volatile", field: "mood", to: "가벼움", reason: "감기가 나음" }],
    people_present: ["이도현", "정하늘"],
    new_people: [{ name: "정하늘", relation: "새 저자", note: "첫 미팅" }],
    threads_resolved: ["도현과 주말 약속"],
    threads_added: ["하늘 원고 피드백 보내기"],
  });
  const { state, changes } = applyDiary(base, out, { day: 12, date: "2026-03-12", intensity: "small" });
  assert.equal(state.volatile.mood, "가벼움");
  assert.equal(base.volatile.mood, "피곤함", "원래 상태는 그대로");
  assert.ok(state.memory.cast.some((c) => c.name === "정하늘" && c.first_seen_day === 12));
  assert.deepEqual(state.memory.open_threads, ["하늘 원고 피드백 보내기"]);
  assert.equal(state.memory.recent_days.length, 1);
  assert.deepEqual(state.immutable, base.immutable);
  assert.ok(changes.some((c) => c.field === "mood"));
});

test("기억 압축: 최근 7일만 남기고 나머지는 주 단위 요약", () => {
  let memory = structuredClone(base.memory);
  for (let d = 1; d <= 16; d++) {
    memory.recent_days.push({ day: d, date: storyDate("2026-03-01", d), intensity: "none", headline: `h${d}`, summary: `s${d}` });
    memory = compactMemory(memory, d);
  }
  assert.deepEqual(memory.recent_days.map((d) => d.day), [10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(memory.weekly_summaries.map((w) => [w.week, w.from_day, w.to_day]), [[1, 1, 7], [2, 8, 9]]);
  assert.match(memory.weekly_summaries[0]?.text ?? "", /3\/1\(일\) h1 · .* · 3\/7\(토\) h7$/);
});
