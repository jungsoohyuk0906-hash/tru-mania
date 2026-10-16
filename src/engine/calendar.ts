import type { Hemisphere } from "../scene/rules.js";

// 이야기 속 날짜는 하루씩 진행된다. 시간대 문제를 피하려고 UTC 기준으로만 계산한다.

const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];

export interface DayInfo {
  day: number;
  date: string;
  month: number;
  weekday: string;
  isWeekend: boolean;
  season: string;
}

export function storyDate(startDate: string, day: number): string {
  const [y, m, d] = startDate.split("-").map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + (day - 1) * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function seasonOf(month: number, hemisphere: Hemisphere): string {
  const m = hemisphere === "north" ? month : ((month + 5) % 12) + 1;
  if (m >= 3 && m <= 5) return "봄";
  if (m >= 6 && m <= 8) return "여름";
  if (m >= 9 && m <= 11) return "가을";
  return "겨울";
}

export function describeDay(startDate: string, day: number, hemisphere: Hemisphere): DayInfo {
  const date = storyDate(startDate, day);
  const dt = new Date(`${date}T00:00:00Z`);
  const dow = dt.getUTCDay();
  const month = dt.getUTCMonth() + 1;
  return {
    day,
    date,
    month,
    weekday: WEEKDAYS_KO[dow] ?? "?",
    isWeekend: dow === 0 || dow === 6,
    season: seasonOf(month, hemisphere),
  };
}

/** "3/12(목)" 형태 */
export function shortDate(date: string): string {
  const dt = new Date(`${date}T00:00:00Z`);
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${WEEKDAYS_KO[dt.getUTCDay()]})`;
}
