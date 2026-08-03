/** 키 정렬 직렬화 — 같은 값이면 항상 같은 문자열을 만든다. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(record[k])).join(',') + '}';
}

/** FNV-1a 64비트 해시(16진 문자열). 전투 결과 재현 검증용. */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
