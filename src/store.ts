import fs from "node:fs";
import path from "node:path";
import type { CallLogEntry } from "./engine/generate.js";
import type { Effort } from "./llm/adapter.js";
import type { CharacterInput, CharacterState } from "./schema/character.js";
import type { AuditRecord, DayRecord } from "./schema/day.js";

// 실행 결과는 data/runs/<run_id>/ 아래 파일로 남는다. 하루가 끝날 때마다 저장하므로
// 중간에 멈춰도 같은 run으로 다시 실행하면 이어서 진행한다.
//
//   meta.json              실행 설정 (모델, 시드, 예산 등). 처음 만들 때 고정된다
//   character.initial.json 인물 설정 원본
//   state.json             마지막으로 끝난 날 이후의 인물 상태
//   days/day-NNN.json      하루 기록
//   audits/week-NN.json    주간 감사 결과
//   calls.jsonl            API 호출 한 번마다 한 줄 (토큰, 비용). 누적 비용의 기준
//   report.md              리포트

export interface RunMeta {
  run_id: string;
  created_at: string;
  adapter: "anthropic" | "mock";
  character_file: string;
  character_id: string;
  seed: string;
  story_start_date: string;
  hemisphere: "north" | "south";
  planned_days: number;
  models: { daily: string; audit: string };
  effort: { daily: Effort | null; audit: Effort | null };
}

export interface SavedState {
  last_day: number;
  state: CharacterState;
}

export const RUNS_DIR = path.join("data", "runs");

export class RunStore {
  readonly dir: string;

  constructor(runId: string, baseDir = RUNS_DIR) {
    this.dir = path.join(baseDir, runId);
  }

  exists(): boolean {
    return fs.existsSync(path.join(this.dir, "meta.json"));
  }

  create(meta: RunMeta, character: CharacterInput): void {
    fs.mkdirSync(path.join(this.dir, "days"), { recursive: true });
    fs.mkdirSync(path.join(this.dir, "audits"), { recursive: true });
    writeJson(path.join(this.dir, "meta.json"), meta);
    writeJson(path.join(this.dir, "character.initial.json"), character);
    this.writeState({ last_day: 0, state: character.state });
  }

  readMeta(): RunMeta {
    return readJson(path.join(this.dir, "meta.json"));
  }

  writeMeta(meta: RunMeta): void {
    writeJson(path.join(this.dir, "meta.json"), meta);
  }

  readInitialCharacter(): CharacterInput {
    return readJson(path.join(this.dir, "character.initial.json"));
  }

  readState(): SavedState {
    return readJson(path.join(this.dir, "state.json"));
  }

  writeState(s: SavedState): void {
    writeJson(path.join(this.dir, "state.json"), s);
  }

  writeDay(rec: DayRecord): void {
    writeJson(path.join(this.dir, "days", `day-${pad(rec.day, 3)}.json`), rec);
  }

  /** 1일차부터 lastDay까지의 하루 기록 (없는 날은 건너뜀) */
  readDays(lastDay: number): DayRecord[] {
    const out: DayRecord[] = [];
    for (let d = 1; d <= lastDay; d++) {
      const p = path.join(this.dir, "days", `day-${pad(d, 3)}.json`);
      if (fs.existsSync(p)) out.push(readJson(p));
    }
    return out;
  }

  writeAudit(rec: AuditRecord): void {
    writeJson(path.join(this.dir, "audits", `week-${pad(rec.week, 2)}.json`), rec);
  }

  hasAudit(week: number): boolean {
    return fs.existsSync(path.join(this.dir, "audits", `week-${pad(week, 2)}.json`));
  }

  readAudits(): AuditRecord[] {
    const dir = path.join(this.dir, "audits");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^week-\d+\.json$/.test(f))
      .sort()
      .map((f) => readJson<AuditRecord>(path.join(dir, f)));
  }

  appendCall(entry: CallLogEntry): void {
    fs.appendFileSync(path.join(this.dir, "calls.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  readCalls(): CallLogEntry[] {
    const p = path.join(this.dir, "calls.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as CallLogEntry);
  }

  /** 지금까지 이 run에서 쓴 비용 (실패한 시도, 감사 포함) */
  totalCostUsd(): number {
    return this.readCalls().reduce((s, c) => s + c.cost_usd, 0);
  }

  writeReport(markdown: string): string {
    const p = path.join(this.dir, "report.md");
    writeText(p, markdown);
    return p;
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

export function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

/** 쓰는 도중 멈춰도 파일이 깨지지 않게 임시 파일에 쓴 뒤 바꿔 넣는다. */
export function writeText(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

export function writeJson(p: string, value: unknown): void {
  writeText(p, `${JSON.stringify(value, null, 2)}\n`);
}
