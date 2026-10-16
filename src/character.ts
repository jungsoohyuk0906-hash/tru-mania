import fs from "node:fs";
import { CharacterInputSchema, type CharacterInput } from "./schema/character.js";
import { sameName } from "./engine/validate.js";

/** 인물 설정 파일을 읽고 검사한다. 관계에 있는 사람은 등장 인물 목록에도 넣어 둔다. */
export function loadCharacter(file: string): CharacterInput {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const parsed = CharacterInputSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`인물 설정 파일 형식 오류 (${file}):\n${lines.join("\n")}`);
  }
  const character = parsed.data;
  const cast = character.state.memory.cast;
  for (const r of character.state.slow.relationships) {
    if (!cast.some((c) => sameName(c.name, r.name))) {
      cast.push({ name: r.name, relation: r.relation, first_seen_day: 0, status: "active" });
    }
  }
  return character;
}
