import { checkScene, type Hemisphere } from "../scene/rules.js";
import {
  EDITABLE_FIELDS,
  IMMUTABLE_FIELD_NAMES,
  type CharacterState,
  type Intensity,
} from "../schema/character.js";
import { DiaryOutputSchema, type ConsistencyIssue, type DiaryOutput } from "../schema/day.js";
import { intensityRank, INTENSITY_LABELS_KO } from "./intensity.js";

// 기획서 6장 4단계 "자동 검증 (코드)". blocking 문제가 하나라도 있으면 재생성한다.
// 심각도: fatal = 불변 설정 변경 시도, 사망자 재등장 (통과 기준의 "치명적 모순")
//         minor = 그 밖의 형식·규칙 위반

export interface ValidationContext {
  state: CharacterState;
  day: number;
  date: string;
  month: number;
  hemisphere: Hemisphere;
  intensity: Intensity;
}

export interface ValidationResult {
  output: DiaryOutput | null;
  issues: ConsistencyIssue[];
}

const DIARY_MIN_CHARS = 300;
const DIARY_MAX_CHARS = 2500;
// 인물이 독자를 의식하는 표현. 원칙 2 "인물은 사용자를 모른다"
const FOURTH_WALL = /(독자 여러분|구독자 여러분|시청자 여러분|이 (일기|글)을? (읽|보)는 (당신|분|사람)|누군가 (나를|내 일기를) (지켜|보고|읽고))/;

export function parseAndValidate(text: string, ctx: ValidationContext): ValidationResult {
  const issues: ConsistencyIssue[] = [];
  const block = (code: string, message: string, severity: "fatal" | "minor" = "minor") =>
    issues.push({ code, severity, message, blocking: true });
  const note = (code: string, message: string) => issues.push({ code, severity: "minor", message, blocking: false });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    block("FORMAT", "응답이 JSON이 아니다");
    return { output: null, issues };
  }

  const parsed = DiaryOutputSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 5)) {
      const path = issue.path.join(".");
      if (path.startsWith("scene")) {
        block("SCENE_VOCAB", `scene 값이 부품 목록에 없다 (${path}: ${issue.message})`);
      } else {
        block("FORMAT", `JSON 형식 오류 (${path || "(최상위)"}: ${issue.message})`);
      }
    }
    return { output: null, issues };
  }
  const out = parsed.data;
  const { state } = ctx;
  const quietDay = intensityRank(ctx.intensity) < intensityRank("medium");

  // 날짜가 하루씩 이어지는지
  if (out.date !== ctx.date) {
    block("DATE_MISMATCH", `date가 ${out.date}인데 오늘은 ${ctx.date}이다`);
  }

  // 정해진 사건 강도를 넘지 않았는지 (AI 자기 보고 기준)
  if (intensityRank(out.event_intensity) > intensityRank(ctx.intensity)) {
    block(
      "INTENSITY_EXCEEDED",
      `오늘의 사건 강도는 ${INTENSITY_LABELS_KO[ctx.intensity]}(${ctx.intensity})인데 ${out.event_intensity} 크기의 일을 썼다`,
    );
  }

  // scene 값과 조합 규칙
  for (const p of checkScene(out.scene, { month: ctx.month, hemisphere: ctx.hemisphere })) {
    block(p.code, p.message);
  }

  // 일기 본문
  const len = out.diary.trim().length;
  if (len < DIARY_MIN_CHARS || len > DIARY_MAX_CHARS) {
    block("DIARY_LENGTH", `일기 본문이 ${len}자다 (500~1,000자로 쓴다)`);
  }
  if (FOURTH_WALL.test(out.diary)) {
    block("FOURTH_WALL", "일기 속 인물이 누군가 자기 일기를 보고 있다는 듯 쓴다 (인물은 관찰자를 모른다)");
  }
  if (!out.headline.trim() || !out.summary.trim()) {
    block("FORMAT", "headline 또는 summary가 비어 있다");
  }

  // 상태 변경
  for (const c of out.state_changes) {
    const field = c.field.trim();
    const touchesImmutable =
      c.layer === "immutable" ||
      IMMUTABLE_FIELD_NAMES.some((f) => field === f || field.startsWith(`${f}.`) || field.endsWith(`.${f}`));
    if (touchesImmutable) {
      block("IMMUTABLE_CHANGE", `불변 설정 '${field}'을(를) 바꾸려 했다`, "fatal");
      continue;
    }
    if (c.layer === "slow") {
      if (quietDay) {
        block("SLOW_CHANGE_ON_QUIET_DAY", `중간 사건 미만인 날에 천천히 변하는 설정 '${field}'을(를) 바꾸려 했다`);
      } else if (!(EDITABLE_FIELDS.slow as readonly string[]).includes(field)) {
        note("UNKNOWN_FIELD", `slow.${field}는 바꿀 수 있는 필드가 아니라 무시했다`);
      }
    } else if (c.layer === "volatile") {
      if (!(EDITABLE_FIELDS.volatile as readonly string[]).includes(field)) {
        note("UNKNOWN_FIELD", `volatile.${field}는 바꿀 수 있는 필드가 아니라 무시했다`);
      }
    } else {
      note("UNKNOWN_FIELD", `알 수 없는 계층 '${c.layer}'의 변경을 무시했다`);
    }
  }
  if (quietDay && out.relationship_updates.length > 0) {
    block(
      "SLOW_CHANGE_ON_QUIET_DAY",
      `중간 사건 미만인 날에 관계를 바꾸려 했다 (${out.relationship_updates.map((r) => r.name).join(", ")})`,
    );
  }

  // 인물 상태 변경 (퇴장·사망)
  for (const u of out.cast_updates) {
    const fam = state.immutable.family.find((f) => sameName(f.name, u.name));
    if (fam) {
      block("IMMUTABLE_CHANGE", `가족(${fam.relation} ${fam.name})의 상태는 불변 설정이라 바꿀 수 없다`, "fatal");
      continue;
    }
    if (quietDay) {
      block("SLOW_CHANGE_ON_QUIET_DAY", `중간 사건 미만인 날에 ${u.name}을(를) ${u.status} 상태로 바꾸려 했다`);
    }
    if (!state.memory.cast.some((c) => sameName(c.name, u.name))) {
      note("UNKNOWN_PERSON", `cast_updates의 ${u.name}은(는) 등장 인물 목록에 없다`);
    }
  }

  // 사망하거나 퇴장한 인물이 다시 등장했는지
  for (const name of out.people_present) {
    const fam = state.immutable.family.find((f) => sameName(f.name, name));
    if (fam && !fam.alive) {
      block("DECEASED_REAPPEARED", `세상을 떠난 ${fam.relation} ${fam.name}이(가) 다시 등장했다`, "fatal");
      continue;
    }
    const member = state.memory.cast.find((c) => sameName(c.name, name));
    if (member?.status === "deceased") {
      block("DECEASED_REAPPEARED", `세상을 떠난 ${member.name}이(가) 다시 등장했다`, "fatal");
    } else if (member?.status === "departed") {
      block("DEPARTED_REAPPEARED", `퇴장한 ${member.name}이(가) 다시 등장했다`);
    }
  }

  // 이미 아는 사람을 새 인물로 등록했는지
  const known = knownNames(state);
  for (const p of out.new_people) {
    const match = known.find((k) => sameName(k, p.name));
    if (match) {
      block("DUPLICATE_PERSON", `${p.name}은(는) 이미 아는 사람(${match})이다. new_people에 넣지 않는다`);
    }
  }
  for (const name of out.people_present) {
    const isNew = out.new_people.some((p) => sameName(p.name, name));
    if (!isNew && !known.some((k) => sameName(k, name)) && !sameName(name, state.immutable.name)) {
      note("UNKNOWN_PERSON", `people_present의 ${name}은(는) 처음 보는 이름이라 새 인물로 등록했다`);
    }
  }

  // 해결했다는 고민·미해결 일이 실제로 있는지
  for (const r of out.concerns_resolved) {
    if (!findItem(state.volatile.open_concerns, r)) note("RESOLVE_NOT_FOUND", `해결했다는 고민 '${r}'이(가) 목록에 없다`);
  }
  for (const r of out.threads_resolved) {
    if (!findItem(state.memory.open_threads, r)) note("RESOLVE_NOT_FOUND", `해결했다는 미해결 일 '${r}'이(가) 목록에 없다`);
  }

  return { output: issues.some((i) => i.blocking) ? null : out, issues };
}

export function knownNames(state: CharacterState): string[] {
  return [
    ...state.immutable.family.map((f) => f.name),
    ...state.slow.relationships.map((r) => r.name),
    ...state.memory.cast.map((c) => c.name),
  ];
}

const HONORIFIC = /(씨|님|이|아|야)$/;

/** "이도현", "도현", "도현이"를 같은 사람으로 본다. 성을 뺀 이름이나 호칭이 붙은 경우까지만 허용한다. */
export function sameName(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, "");
  const nb = b.replace(/\s+/g, "");
  if (!na || !nb) return false;
  if (na === nb) return true;
  const variants = (n: string) => {
    const v = [n];
    if (n.length >= 3 && HONORIFIC.test(n)) v.push(n.replace(HONORIFIC, ""));
    return v;
  };
  for (const x of variants(na)) {
    for (const y of variants(nb)) {
      if (x === y) return true;
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      // 성(1자) + 이름 형태에서 이름만 부른 경우
      if (short.length >= 2 && long.length === short.length + 1 && long.endsWith(short)) return true;
    }
  }
  return false;
}

/** 고민·미해결 일 문구를 찾는다. 완전히 같거나 한쪽이 다른 쪽을 포함하면 같은 항목이다. */
export function findItem(list: string[], text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  return list.find((item) => item === t) ?? list.find((item) => item.includes(t) || t.includes(item));
}
