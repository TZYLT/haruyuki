import { isCjkRun, tokenize } from "@/backend/local/transcript-search";
import type { RecallQueryTerms } from "./recall-port";

/**
 * Turning the user's sentence into terms the scorer can use.
 *
 * The problem this solves is measured, not theoretical: `tokenize` keeps a
 * punctuation-free Han run as **one token** (《26》§5.10), and CJK term frequency is
 * a **substring** scan. So the query `我上次说的财务系统是怎么记账的` becomes a single
 * 15-character token, no document contains that substring, and recall returns
 * nothing at all. The user's ruling (《26》§10.4) is to fix that on the query side
 * with an n-gram sliding window instead of a dictionary: a 2–3 character window
 * over each Han run produces terms that *do* substring-match the stored runs,
 * which also means no existing index has to be rebuilt.
 *
 * Two things are deliberately not done here:
 *
 * - **No dictionary.** Segmenting Han text properly needs a word list this repo
 *   does not have and would have to maintain. Windows are worse per term and much
 *   better per unknown word, which is the trade the ruling chose.
 * - **No coordination rule.** "A document must match at least N different terms"
 *   would suppress most window noise, but it needs the scorer to know about it,
 *   and the scorer is shared with the transcript search index. The window's noise
 *   is instead bounded by dropping pure-function-word windows and by capping how
 *   many terms one query may contribute.
 */

/**
 * Characters that are almost never a content word on their own. Used only to drop
 * a window that is *made of* them — never to reject a window that merely contains
 * one, because `目的` and `个人` would die with that rule.
 */
const CJK_STOPWORD_CHARACTERS = new Set(
  "的了吗呢吧啊呀哦嗯呀是我你他她它们是在有和与就都也还这那哪什么很太被把给让从到对为以及或但而却则于之其该每各些个不没要会能可想说请帮上下前后里外时".split(
    "",
  ),
);

/** Latin function words. `tokenize` already dropped punctuation and casing. */
const LATIN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
]);

/** Shortest and longest window emitted for a Han run. */
const MIN_WINDOW = 2;
const MAX_WINDOW = 3;

export type RecallQueryOptions = {
  /**
   * Cap on the terms one query may contribute.
   *
   * Document frequencies are computed per term over the whole corpus, so cost grows
   * with the term count — but after the scorer reads the joined record text instead
   * of walking tokens, 25 terms over the measured index corpus cost ~25 ms against
   * ~20 ms for 5. The cap is therefore a bound on pathological input, not a tuning
   * knob: 32 covers a 15-character sentence's 25 windows without truncating it.
   */
  maxTerms: number;
};

export const RECALL_QUERY_DEFAULTS: RecallQueryOptions = { maxTerms: 32 };

function isStopwordWindow(value: string): boolean {
  return Array.from(value).every((character) =>
    CJK_STOPWORD_CHARACTERS.has(character),
  );
}

/**
 * Every 2- and 3-character window of a Han run, plus the run itself when it is
 * short enough to be a plausible whole word (windowing a 4-character run would
 * otherwise lose the run, which is its best term).
 */
function windowsForRun(run: string): string[] {
  const characters = Array.from(run);
  const windows = new Set<string>();
  if (characters.length <= MIN_WINDOW + 2) windows.add(run);
  for (let size = MAX_WINDOW; size >= MIN_WINDOW; size -= 1) {
    for (let index = 0; index + size <= characters.length; index += 1) {
      windows.add(characters.slice(index, index + size).join(""));
    }
  }
  return [...windows];
}

function termsForSegment(segment: string): string[] {
  const terms: string[] = [];
  for (const token of tokenize(segment)) {
    if (!isCjkRun(token)) {
      if (!LATIN_STOPWORDS.has(token)) terms.push(token);
      continue;
    }
    for (const window of windowsForRun(token)) {
      if (isStopwordWindow(window)) continue;
      terms.push(window);
    }
  }
  return terms;
}

/**
 * Splits the raw input into quoted phrases and the terms for everything else.
 *
 * Quote handling mirrors `parseQuery` so both sources agree on what a quoted
 * phrase means — including the "unclosed quote" case, where the quote is treated
 * as ordinary text rather than swallowing the rest of the sentence.
 */
export function recallQueryTerms(
  text: string,
  options: RecallQueryOptions = RECALL_QUERY_DEFAULTS,
): RecallQueryTerms {
  const terms: string[] = [];
  const phrases: string[] = [];
  let buffer = "";
  let inQuote = false;
  let sawUnclosedQuote = false;

  const flush = (): void => {
    const value = buffer.trim();
    buffer = "";
    if (!value) return;
    if (inQuote) {
      const phrase = tokenize(value).join(" ");
      if (phrase) phrases.push(phrase);
      return;
    }
    terms.push(...termsForSegment(value));
  };

  for (const character of text.trim()) {
    if (character === '"') {
      if (inQuote) {
        flush();
        inQuote = false;
      } else {
        flush();
        inQuote = true;
      }
      continue;
    }
    buffer += character;
  }
  if (inQuote) sawUnclosedQuote = true;
  flush();

  if (sawUnclosedQuote) {
    return { terms: capTerms(termsForSegment(text), options), phrases: [] };
  }
  return { terms: capTerms(terms, options), phrases: [...new Set(phrases)] };
}

/**
 * Keeps the most specific windows first — longer terms before shorter ones, and
 * within one length the order the text produced. Deterministic, so two sources
 * and two runs always see the same list.
 */
function capTerms(
  terms: readonly string[],
  options: RecallQueryOptions,
): string[] {
  const unique = [...new Set(terms)];
  const max = Math.max(1, Math.trunc(options.maxTerms));
  if (unique.length <= max) return unique;
  const ranked = unique
    .map((term, index) => ({ term, index }))
    .sort(
      (left, right) =>
        right.term.length - left.term.length || left.index - right.index,
    );
  return ranked
    .slice(0, max)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.term);
}

/**
 * The string form of a parsed query, for a source whose entry point still takes
 * text. Round-trips through `parseQuery`: a window is a 2- or 3-character Han run,
 * which `tokenize` keeps whole, and a phrase is quoted.
 */
export function recallQueryText(query: RecallQueryTerms): string {
  const parts = query.phrases.map((phrase) => `"${phrase}"`);
  parts.push(...query.terms);
  return parts.join(" ");
}
