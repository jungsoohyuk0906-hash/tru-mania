// 재현 가능한 난수. 같은 seed와 날짜면 언제 다시 실행해도 같은 값이 나온다.
// 중간에 멈췄다가 이어서 실행해도 사건 강도가 바뀌지 않게 하기 위해서다.

function hashString(input: string): number {
  // FNV-1a 32bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** seed 문자열과 키(예: "intensity:12")로 [0, 1) 난수 생성기를 만든다. */
export function seededRandom(seed: string, key: string): () => number {
  return mulberry32(hashString(`${seed}:${key}`));
}
