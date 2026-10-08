// Bottom-k MinHash sketch over token 5-gram shingles, used for duplicate-logic detection.

const K = 64;
const SHINGLE = 5;
export const MIN_FINGERPRINT_TOKENS = 40;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** tokens should already be normalized (identifiers of locals collapsed, literals collapsed). */
export function fingerprint(tokens: string[]): number[] | undefined {
  if (tokens.length < MIN_FINGERPRINT_TOKENS) return undefined;
  const set = new Set<number>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) {
    set.add(fnv1a(tokens.slice(i, i + SHINGLE).join(' ')));
  }
  return [...set].sort((a, b) => a - b).slice(0, K);
}

/** Estimated Jaccard similarity of two bottom-k sketches. */
export function similarity(a: number[], b: number[]): number {
  const union = [...new Set([...a, ...b])].sort((x, y) => x - y).slice(0, K);
  const sa = new Set(a);
  const sb = new Set(b);
  let both = 0;
  for (const h of union) if (sa.has(h) && sb.has(h)) both++;
  return union.length ? both / union.length : 0;
}
