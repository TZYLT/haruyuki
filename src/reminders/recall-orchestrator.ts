import { truncateEnd } from "@/cli/helpers/text-layout";
import type {
  RecallCandidate,
  RecallDiversity,
  RecallEntry,
  RecallSourceId,
} from "./recall-port";

/**
 * Choosing what to inject, from the candidates both sources returned.
 *
 * Pure on purpose. Everything policy-shaped about recall lives here — the dedup
 * filter, the score floor, the slot allocation, the character budget — so it can be
 * asserted directly on a fixture instead of inferred from a live turn. The service
 * above it owns only I/O.
 *
 * Two orderings matter and are not interchangeable. The score floor is applied
 * *after* the dedup filter, so it asks "is the best thing we may still send good
 * enough?", not "was the best thing we have good enough?" — a hit the window already
 * covers must not silence a genuine second match. And the budget is applied *last*,
 * by dropping from the lowest score upwards, which is the rule the requirement
 * states.
 */

export type RecallSelectionInput = {
  candidates: readonly RecallCandidate[];
  limit: number;
  /** Relative floor: `topScore * minScoreRatio`. `0` disables it. */
  minScoreRatio: number;
  diversity: RecallDiversity;
  excerptCharacters: number;
  totalCharacters: number;
  /** Fingerprints already injected inside the dedup window. */
  suppressed: ReadonlySet<string>;
};

export type RecallSelection = {
  entries: RecallEntry[];
  /** The absolute floor that was applied; `0` when there was nothing to compare. */
  threshold: number;
  /** Candidates removed because the window already covered them. */
  deduped: number;
  /** Candidates removed by the score floor. */
  belowThreshold: number;
};

function compareCandidates(
  left: RecallCandidate,
  right: RecallCandidate,
): number {
  return (
    right.score - left.score ||
    left.source.localeCompare(right.source) ||
    left.file.localeCompare(right.file) ||
    (left.startLine ?? 0) - (right.startLine ?? 0) ||
    (left.messageId ?? "").localeCompare(right.messageId ?? "")
  );
}

/**
 * At most one entry per source *file*: a conversation for a transcript hit, a
 * document for a memory hit.
 *
 * A hard cap, not a preference: an unused slot stays unused rather than being
 * refilled from a file that already contributed, because the setting exists to stop
 * one long document from taking every slot. With the measured corpora — 30 memory
 * files and 32 conversations — a short result means few distinct files matched,
 * which is information, not a hole to fill.
 */
function selectOnePerFile(
  ordered: readonly RecallCandidate[],
  limit: number,
): RecallCandidate[] {
  const usedFiles = new Set<string>();
  const chosen: RecallCandidate[] = [];
  for (const candidate of ordered) {
    const key = `${candidate.source}\u0000${candidate.file}`;
    if (usedFiles.has(key)) continue;
    usedFiles.add(key);
    chosen.push(candidate);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

/**
 * Half the slots per source, and the odd slot to the better remaining score.
 *
 * With `limit = 3` that is one from each source plus the best of whatever is left,
 * so a two-source result is guaranteed whenever both sources matched — which is the
 * point of the mode — while the leftover slot still goes to the stronger hit rather
 * than to an arbitrary source.
 */
function selectSplitBySource(
  ordered: readonly RecallCandidate[],
  limit: number,
): RecallCandidate[] {
  const share = Math.floor(limit / 2);
  const taken: Record<RecallSourceId, number> = { transcript: 0, memory: 0 };
  const chosen: RecallCandidate[] = [];
  for (const candidate of ordered) {
    if (share <= 0) break;
    if (taken[candidate.source] >= share) continue;
    taken[candidate.source] += 1;
    chosen.push(candidate);
  }
  if (chosen.length < limit) {
    const picked = new Set(chosen);
    for (const candidate of ordered) {
      if (picked.has(candidate)) continue;
      chosen.push(candidate);
      if (chosen.length >= limit) break;
    }
  }
  return chosen.sort(compareCandidates);
}

export function selectRecallEntries(
  input: RecallSelectionInput,
): RecallSelection {
  const limit = Math.max(0, Math.trunc(input.limit));
  let deduped = 0;
  const eligible: RecallCandidate[] = [];
  for (const candidate of input.candidates) {
    if (input.suppressed.has(candidate.fingerprint)) {
      deduped += 1;
      continue;
    }
    eligible.push(candidate);
  }
  eligible.sort(compareCandidates);

  const top = eligible[0];
  const threshold =
    top && input.minScoreRatio > 0 ? top.score * input.minScoreRatio : 0;
  const relevant = eligible.filter((candidate) => candidate.score >= threshold);
  const belowThreshold = eligible.length - relevant.length;

  const chosen =
    limit === 0
      ? []
      : input.diversity === "file"
        ? selectOnePerFile(relevant, limit)
        : input.diversity === "split"
          ? selectSplitBySource(relevant, limit)
          : relevant.slice(0, limit);

  const perEntry = Math.max(0, Math.trunc(input.excerptCharacters));
  const total = Math.max(0, Math.trunc(input.totalCharacters));
  // A character budget of `0` is a supported setting, and it means "no excerpt
  // text" rather than "an entry with nothing in it". An empty entry is not a
  // passage: it would put a header in the block, claim a passage in the summary
  // line the user reads, and suppress its fingerprint for `dedupTurns` — all for
  // text nobody ever sees. Dropping it here is what makes `entries.length > 0`
  // mean "there is something to inject" everywhere downstream.
  const entries: RecallEntry[] = chosen
    .map((candidate) => ({
      ...candidate,
      text: truncateEnd(candidate.text, perEntry),
    }))
    .filter((entry) => entry.text.length > 0);
  // "Over budget: drop from the lowest score" — the entries are still in score
  // order, so the tail is the lowest-scoring end.
  while (entries.length > 1) {
    const used = entries.reduce((sum, entry) => sum + entry.text.length, 0);
    if (used <= total) break;
    entries.pop();
  }

  return { entries, threshold, deduped, belowThreshold };
}
