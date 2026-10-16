import { parseArgs } from "node:util";
import { loadDotEnv, readConfig } from "../src/config.js";
import { saveReports } from "../src/runner.js";
import { RunStore } from "../src/store.js";

// 저장된 run으로 리포트를 다시 만든다. 환율·목표 비용 같은 가정값을 바꾼 뒤에 쓴다.
//   npm run report -- --run seoyun-stage0 [--publish]
// --publish: reports/stage0-report.md 에도 쓴다

loadDotEnv();
const { values } = parseArgs({
  options: {
    run: { type: "string", default: "seoyun-stage0" },
    publish: { type: "boolean", default: false },
  },
});

const store = new RunStore(values.run);
if (!store.exists()) {
  console.error(`run '${values.run}'이 없다 (data/runs/ 확인)`);
  process.exit(1);
}
const meta = store.readMeta();
// 가격 계산은 run에 기록된 비용을 쓰므로 모델 설정은 run의 것을 그대로 쓴다
process.env.TRUMOVIE_DAILY_MODEL = meta.models.daily;
process.env.TRUMOVIE_AUDIT_MODEL = meta.models.audit;
const config = readConfig({ mock: meta.adapter === "mock" });
for (const p of saveReports(store, config, { publish: values.publish })) console.log(`리포트: ${p}`);
