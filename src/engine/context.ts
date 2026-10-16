import { describeSceneRules, type Hemisphere } from "../scene/rules.js";
import type { CharacterState, Intensity } from "../schema/character.js";
import { shortDate, type DayInfo } from "./calendar.js";
import { INTENSITY_GUIDE_KO, INTENSITY_LABELS_KO } from "./intensity.js";

// 기획서 6장 2단계 "맥락 조립 (코드)".
// system: 작성 규칙 + 불변 계층. 매일 바이트 단위로 같아야 프롬프트 캐싱이 된다.
// user:   천천히 변함 + 자주 변함 + 기억 + 오늘 정보. 매일 달라진다.

export function buildDiarySystem(state: CharacterState, hemisphere: Hemisphere): string {
  const im = state.immutable;
  return `너는 한 사람의 하루를 그 사람이 직접 쓴 일기로 옮기는 작가다. 아래 인물은 실제로 살아가는 사람이고, 너는 매일 그 사람의 일기 한 편을 쓴다.

## 일기 작성 규칙
1. ${im.name} 본인의 1인칭으로, 본인을 위해 쓴다. 누군가 이 일기를 읽는다는 사실을 본인은 모른다. 독자에게 말을 걸거나 설정을 설명하지 않는다.
2. 하루에 일어나는 일의 크기는 '오늘의 사건 강도'를 넘지 않는다. 무사건인 날은 루틴과 사소한 감상만으로 쓴다. 지루한 날이 있어야 사건이 사건이 된다.
3. 불변 설정(맨 아래)은 어떤 경우에도 바뀌지 않는다. 이름, 생년, 출신지, 가족 구성과 생사, 핵심 성격과 어긋나는 내용을 쓰지 않는다. 가족은 불변 설정에 적힌 사람뿐이다. 다른 가족을 새로 만들지 않는다.
4. 천천히 변하는 설정(직업, 사는 곳, 관계, 장기 목표, 가치관)은 사건 강도가 중간 사건(medium) 이상인 날에만, 그날 사건의 결과로만 바꾼다.
5. 퇴장했거나 세상을 떠난 사람은 직접 등장하거나 연락해 오지 않는다. 떠올리거나 언급하는 것은 괜찮다.
6. 기억(지난 주들, 최근 7일, 등장 인물, 약속·미해결 일)과 이어지게 쓴다. 이미 있었던 일과 모순되지 않게 한다. 미해결 일은 서두르지 않고 자연스러운 때에 다룬다.
7. 요일, 계절, 날씨가 하루에 자연스럽게 묻어나게 한다.
8. 일기 본문은 500~1,000자로 쓴다.
9. 사람을 부를 때는 등장 인물 목록에 있는 이름을 그대로 쓴다.

## scene (오늘의 한 장면)
오늘 하루 중 이 사람다운 한 순간을 고른다. 값은 아래 목록에서만 고르고, 장소와 행동은 허용된 조합만 쓴다.
${describeSceneRules(hemisphere)}

## 출력 필드
- date: 오늘 날짜 (사용자 메시지에 적힌 YYYY-MM-DD 그대로)
- event_intensity: 실제로 쓴 일의 크기 (none, small, medium, major 중 하나)
- diary: 일기 본문
- headline: 오늘을 한 줄로 (30자 이내)
- summary: 나중에 기억할 사실 위주 2~3문장. 누구를 만났는지, 무엇이 바뀌었는지, 남은 일
- scene: 오늘의 한 장면
- state_changes: 어제와 달라진 설정. layer와 field는 다음 중 하나다
  - layer "volatile": field "mood"(기분), "health"(건강), "money"(돈 사정). 어제와 같으면 넣지 않는다
  - layer "slow": field "job", "residence", "long_term_goal", "values". 중간 사건 이상인 날만
  - to에는 바뀐 값, reason에는 이유
- relationship_updates: 관계 변화 (천천히 변하는 설정이라 중간 사건 이상인 날만). name, relation, closeness(0~1), reason
- people_present: 오늘 직접 만나거나 통화·메시지를 주고받은 사람의 이름 (본인 제외, 이름이 있는 사람만)
- new_people: 오늘 처음 등장한, 이름이 있는 사람. name, relation, note
- cast_updates: 등장 인물이 멀리 떠나거나(departed) 세상을 떠난(deceased) 경우만. 중간 사건 이상인 날만
- concerns_added / concerns_resolved: 진행 중인 고민의 추가와 해결 (해결은 기존 문구 그대로)
- threads_added / threads_resolved: 약속·미해결 일의 추가와 해결 (해결은 기존 문구 그대로)
해당 사항이 없는 목록은 빈 배열로 둔다.

## 불변 설정
- 이름: ${im.name}
- 출생 연도: ${im.birth_year}
- 출신지: ${im.hometown}
- 가족: ${im.family.map((f) => `${f.relation} ${f.name}(${f.alive ? "생존" : "작고"})`).join(", ") || "없음"}
- MBTI: ${im.core_traits.mbti}
- 기질: ${im.core_traits.temperament}`;
}

export interface DiaryUserInput {
  state: CharacterState;
  info: DayInfo;
  intensity: Intensity;
  /** 재생성일 때, 이전 시도에서 걸린 문제들 */
  feedback?: string[];
}

export function buildDiaryUser({ state, info, intensity, feedback }: DiaryUserInput): string {
  const { slow, volatile: vol, memory } = state;
  const lines: string[] = [];

  lines.push("# 오늘");
  lines.push(`- ${info.day}일째 · ${info.date} (${info.weekday}요일, ${info.isWeekend ? "주말" : "평일"}) · ${info.season}`);
  lines.push(`- 오늘의 사건 강도: ${INTENSITY_LABELS_KO[intensity]} (${intensity}) — ${INTENSITY_GUIDE_KO[intensity]}`);

  lines.push("", "# 지금의 삶 (천천히 변하는 설정)");
  lines.push(`- 직업: ${slow.job}`);
  lines.push(`- 사는 곳: ${slow.residence}`);
  lines.push(`- 장기 목표: ${slow.long_term_goal}`);
  if (slow.values) lines.push(`- 가치관: ${slow.values}`);
  lines.push(
    `- 관계: ${slow.relationships.map((r) => `${r.name}(${r.relation}, 친밀도 ${r.closeness})`).join(", ") || "없음"}`,
  );
  const recentChanges = slow.change_log.slice(-5);
  if (recentChanges.length > 0) {
    lines.push("- 최근 바뀐 것:");
    for (const c of recentChanges) {
      lines.push(`  - ${c.day}일째 ${c.field}: ${fmt(c.from)} → ${fmt(c.to)} (${c.reason})`);
    }
  }

  lines.push("", "# 어제까지의 상태 (자주 변하는 설정)");
  lines.push(`- 기분: ${vol.mood} / 건강: ${vol.health} / 돈 사정: ${vol.money}`);
  lines.push(`- 진행 중인 고민: ${vol.open_concerns.join(" / ") || "없음"}`);
  const s = vol.scene;
  lines.push(`- 마지막 장면: ${s.location} · ${s.activity} · ${s.time_of_day} · ${s.weather}`);

  lines.push("", "# 기억");
  if (memory.weekly_summaries.length > 0) {
    lines.push("## 지난 주들 (오래된 순)");
    for (const w of memory.weekly_summaries) {
      lines.push(`- ${w.week}주차 (${w.from_day}~${w.to_day}일째): ${w.text}`);
    }
  }
  lines.push("## 최근 7일");
  if (memory.recent_days.length === 0) lines.push("- (아직 없음. 오늘이 첫 기록이다)");
  for (const d of memory.recent_days) {
    lines.push(`- ${shortDate(d.date)} [${INTENSITY_LABELS_KO[d.intensity]}] ${d.headline} — ${d.summary}`);
  }

  lines.push("## 등장 인물");
  for (const f of state.immutable.family) {
    lines.push(`- ${f.name} · ${f.relation} · 가족 · ${f.alive ? "생존" : "작고 (직접 등장 불가)"}`);
  }
  for (const c of memory.cast) {
    const status = c.status === "active" ? "활동 중" : c.status === "departed" ? "퇴장 (직접 등장 불가)" : "작고 (직접 등장 불가)";
    const since = c.first_seen_day > 0 ? `${c.first_seen_day}일째 첫 등장` : "처음부터 아는 사이";
    lines.push(`- ${c.name} · ${c.relation ?? "관계 미상"} · ${since} · ${status}`);
  }

  lines.push("## 약속·미해결 일");
  lines.push(memory.open_threads.length > 0 ? memory.open_threads.map((t) => `- ${t}`).join("\n") : "- 없음");

  if (feedback && feedback.length > 0) {
    lines.push("", "# 다시 쓰기");
    lines.push("이전 시도에서 아래 문제가 발견됐다. 고쳐서 처음부터 다시 쓴다.");
    for (const f of feedback) lines.push(`- ${f}`);
  }

  lines.push("", `오늘(${info.date})의 일기를 JSON으로 쓴다.`);
  return lines.join("\n");
}

function fmt(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
