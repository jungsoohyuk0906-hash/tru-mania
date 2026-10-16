import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadCharacter } from "../src/character.js";
import type { RunConfig } from "../src/config.js";
import { MockAdapter } from "../src/llm/mock.js";
import { buildReport } from "../src/report.js";
import { openRun, runDays, type RunnerDeps } from "../src/runner.js";
import { RunStore } from "../src/store.js";

const config: RunConfig = {
  dailyModel: "claude-haiku-5-5",
  auditModel: "claude-opus-5-5",
  dailyEffort: null,
  auditEffort: null,
  budgetUsd: 10,
  usdKrw: 1400,
  targetKrwPerDay: 50,
  subscriptionKrw: 4900,
};

function setup(runId: string, opts: { cfg?: Partial<RunConfig>; alwaysFailDays?: number[] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trumovie-"));
  const store = new RunStore(runId, tmp);
  const character = loadCharacter("data/characters/seoyun.json");
  const cfg = { ...config, ...opts.cfg };
  const deps: RunnerDeps = {
    store,
    adapter: new MockAdapter({ seed: runId, alwaysFailDays: opts.alwaysFailDays ?? [] }),
    config: cfg,
    log: () => {},
  };
  const open = (targetDay: number) =>
    openRun(store, { runId, characterFile: "data/characters/seoyun.json", character, mock: true, config: cfg, targetDay });
  return { store, deps, open, cfg };
}

test("3일 → 10일로 이어서 실행하고, 7일째에 감사한다", async () => {
  const { store, deps, open } = setup("t-resume");
  const r1 = await runDays(deps, open(3).meta, 3);
  assert.equal(r1.lastDay, 3);
  assert.equal(store.readDays(3).length, 3);
  assert.equal(store.readAudits().length, 0);

  const { meta, created } = open(10);
  assert.equal(created, false);
  const r2 = await runDays(deps, meta, 10);
  assert.equal(r2.lastDay, 10);
  assert.deepEqual(r2.newDays.map((d) => d.day), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(store.readAudits().map((a) => [a.week, a.from_day, a.to_day]), [[1, 1, 7]]);

  const days = store.readDays(10);
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(`${days[i - 1]!.date_in_story}T00:00:00Z`).getTime();
    assert.equal(new Date(`${days[i]!.date_in_story}T00:00:00Z`).getTime() - prev, 86_400_000);
  }
  const calls = store.readCalls();
  assert.ok(Math.abs(store.totalCostUsd() - calls.reduce((s, c) => s + c.cost_usd, 0)) < 1e-12);
  assert.ok(Math.abs(days.reduce((s, d) => s + d.cost_usd, 0) + store.readAudits()[0]!.cost_usd - store.totalCostUsd()) < 1e-9);
});

test("재생성 2번 뒤에도 실패한 날은 오류로 기록하고 다음 날로 넘어간다", async () => {
  const { store, deps, open } = setup("t-fail", { alwaysFailDays: [2] });
  await runDays(deps, open(4).meta, 4);
  const days = store.readDays(4);
  assert.deepEqual(days.map((d) => d.status), ["ok", "error", "ok", "ok"]);
  assert.equal(days[1]!.attempts.length, 3);
  assert.ok(days[1]!.consistency_issues.every((i) => !i.resolved));
  assert.equal(store.readState().last_day, 4);
});

test("비용 상한에 닿으면 그날을 기록하지 않고 멈춘다", async () => {
  const { store, deps, open } = setup("t-budget", { cfg: { budgetUsd: 0.005 } });
  const r = await runDays(deps, open(10).meta, 10);
  assert.equal(r.stoppedBy, "budget");
  assert.ok(r.lastDay < 10);
  assert.ok(store.totalCostUsd() <= 0.005, `spent ${store.totalCostUsd()}`);
  assert.equal(store.readDays(10).length, r.lastDay);
});

test("모델을 바꾸면 같은 run을 이어서 쓸 수 없다", async () => {
  const { store, open } = setup("t-model");
  open(3);
  const character = loadCharacter("data/characters/seoyun.json");
  assert.throws(
    () =>
      openRun(store, {
        runId: "t-model",
        characterFile: "data/characters/seoyun.json",
        character,
        mock: true,
        config: { ...config, dailyModel: "claude-sonnet-5-5" },
        targetDay: 10,
      }),
    /모델/,
  );
});

test("리포트에 기획서 8장의 항목이 모두 들어간다", async () => {
  const { store, deps, open, cfg } = setup("t-report");
  await runDays(deps, open(14).meta, 14);
  const saved = store.readState();
  const md = buildReport({
    meta: store.readMeta(),
    initial: store.readInitialCharacter(),
    saved,
    days: store.readDays(saved.last_day),
    audits: store.readAudits(),
    calls: store.readCalls(),
    money: { usdKrw: cfg.usdKrw, targetKrwPerDay: cfg.targetKrwPerDay, subscriptionKrw: cfg.subscriptionKrw, budgetUsd: cfg.budgetUsd },
  });
  for (const heading of [
    "## 통과 기준 판정",
    "## 1. 인물 설정 원본과",
    "## 2. 일관성 오류 목록",
    "## 3. 사건 강도 분포",
    "## 4. 토큰과 비용",
    "## 5. 장면(scene) 분포",
    "## 6. 읽어볼 만한 날 5개",
    "## 7. 다음 단계 전에 사람이 결정할 것",
  ]) {
    assert.ok(md.includes(heading), heading);
  }
  assert.ok(md.includes("모의 실행"));
  assert.ok(md.includes("중간 리포트"));
  assert.equal((md.match(/^### \d+일째 · /gm) ?? []).length, 5);
});
