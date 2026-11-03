/**
 * Conservative token estimation for the vector-recall chunker (feature 48, B1).
 *
 * The chunker must not load a model tokenizer: it runs in the main process and
 * its output must be deterministic for a given text. The estimate therefore
 * over-counts rather than under-counts — CJK 1 token/char, ASCII 1/4 char,
 * punctuation 1/2 — so a window built from it stays under the model limit even
 * for text the tokenizer would split differently.
 */

/** Non-ASCII punctuation and symbols; CJK ideographs/kana/hangul come first. */
const NON_ASCII_PUNCTUATION = /[\p{P}\p{S}]/u;

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // Hiragana + Katakana
    (codePoint >= 0x3100 && codePoint <= 0x312f) || // Bopomofo
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Ext. A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f) // CJK Ext. B–F
  );
}

/** Unicode whitespace (including the ideographic space) in code-point terms. */
export function isWhitespaceCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x20 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  );
}

/** Token cost of one code point; the single source for every estimate here. */
export function tokenCostOfCodePoint(codePoint: number): number {
  if (isWhitespaceCodePoint(codePoint)) return 0.25;
  if (codePoint < 0x80) {
    const isAsciiPunctuation =
      (codePoint >= 0x21 && codePoint <= 0x2f) ||
      (codePoint >= 0x3a && codePoint <= 0x40) ||
      (codePoint >= 0x5b && codePoint <= 0x60) ||
      (codePoint >= 0x7b && codePoint <= 0x7e);
    return isAsciiPunctuation ? 0.5 : 0.25;
  }
  if (isCjkCodePoint(codePoint)) return 1;
  if (NON_ASCII_PUNCTUATION.test(String.fromCodePoint(codePoint))) return 0.5;
  // Unknown script: one token per character is the conservative choice.
  return 1;
}

/**
 * Conservative embedding-token estimate: CJK 1/char, ASCII 1/4, punctuation
 * 1/2. Deliberately an over-estimate, so a window derived from it stays under
 * the model limit even though it never loads the model tokenizer.
 */
export function estimateEmbeddingTokens(text: string): number {
  if (text.length === 0) return 0;
  let total = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0;
    total += tokenCostOfCodePoint(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return total <= 0 ? 0 : Math.ceil(total);
}
