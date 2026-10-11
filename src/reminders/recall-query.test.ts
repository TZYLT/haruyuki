import { describe, expect, test } from "bun:test";
import { parseQuery } from "@/backend/local/transcript-search";
import { recallQueryTerms, recallQueryText } from "@/reminders/recall-query";

/**
 * The reason this layer exists is measured, not aesthetic: `tokenize` keeps a
 * punctuation-free Han run whole, and CJK term matching is a substring scan, so the
 * raw sentence `我上次说的财务系统是怎么记账的` is one 15-character term that no document
 * contains. These tests pin the replacement behaviour.
 */

const SENTENCE = "我上次说的财务系统是怎么记账的";

describe("recall query terms", () => {
  test("turns a Han sentence into windows instead of one unusable term", () => {
    const query = recallQueryTerms(SENTENCE);
    expect(query.phrases).toEqual([]);
    // The whole run is gone: nothing contains it.
    expect(query.terms).not.toContain(SENTENCE);
    // The windows that make the sentence findable.
    expect(query.terms).toContain("财务");
    expect(query.terms).toContain("系统");
    expect(query.terms).toContain("记账");
    expect(query.terms).toContain("财务系");
  });

  test("a short run keeps itself as a term", () => {
    expect(recallQueryTerms("泰山").terms).toEqual(["泰山"]);
    expect(recallQueryTerms("财务系统").terms).toContain("财务系统");
  });

  test("drops a window made only of function words", () => {
    expect(recallQueryTerms("的了是我").terms).toEqual([]);
    // A window that merely *contains* a function word survives: 目的 and 个人
    // would otherwise be unreachable.
    expect(recallQueryTerms("目的").terms).toEqual(["目的"]);
    expect(recallQueryTerms("个人").terms).toEqual(["个人"]);
  });

  test("keeps Latin terms and drops Latin function words", () => {
    expect(recallQueryTerms("the finance ledger").terms).toEqual([
      "finance",
      "ledger",
    ]);
  });

  test("a quoted phrase stays a strict phrase and is not windowed", () => {
    const query = recallQueryTerms('"记忆库" 索引');
    expect(query.phrases).toEqual(["记忆库"]);
    expect(query.terms).toEqual(["索引"]);
    expect(query.terms).not.toContain("记忆");
  });

  test("an unclosed quote is ordinary text, not a phrase", () => {
    const query = recallQueryTerms('记忆库 "财务系统');
    expect(query.phrases).toEqual([]);
    expect(query.terms).toContain("财务");
  });

  test("caps the term count, keeping the longer windows", () => {
    const query = recallQueryTerms(SENTENCE, { maxTerms: 8 });
    expect(query.terms).toHaveLength(8);
    // Longest first: every emitted term is a 3-character window.
    expect(query.terms.every((term) => term.length === 3)).toBe(true);
  });

  test("is deterministic", () => {
    expect(recallQueryTerms(SENTENCE)).toEqual(recallQueryTerms(SENTENCE));
  });

  test("an input with no searchable terms yields nothing", () => {
    for (const text of ["", "   ", "!!!", "。、"]) {
      const query = recallQueryTerms(text);
      expect(query.terms).toEqual([]);
      expect(query.phrases).toEqual([]);
    }
  });
});

describe("the text form round-trips", () => {
  test("re-parsing the emitted text reproduces the same terms and phrases", () => {
    // The memory source takes a parsed query, so nothing depends on this today —
    // but it is the property that makes the two sources provably agree about what
    // the user asked, and it is cheap to keep true.
    for (const text of [
      SENTENCE,
      "财务系统 记账",
      '"记忆库" 索引',
      "the finance ledger",
      "上次那个 harness 的 compaction 有什么坑",
    ]) {
      const query = recallQueryTerms(text);
      const reparsed = parseQuery(recallQueryText(query));
      expect(reparsed.terms).toEqual([...query.terms]);
      expect(reparsed.phrases).toEqual([...query.phrases]);
    }
  });
});
