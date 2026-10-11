import type { RecallDecision } from "./recall-port";
import { recallEntryHeader } from "./recall-reminder";

/**
 * `/recall now <query>`: what the search finds, right now.
 *
 * Deliberately not the injection text. The reminder is written for the model, with
 * its own framing and its self-limitation sentence; a person asking "does recall
 * find this?" wants the hits and where they came from. The two share the entry
 * header (`recallEntryHeader`) so a passage is named the same way in both, and
 * nothing else.
 */
export function formatRecallProbeLines(decision: RecallDecision): string[] {
  if (decision.entries.length === 0) {
    const detail = decision.reason ? ` (${decision.reason})` : "";
    return [`Recall found nothing for that query: ${decision.status}${detail}`];
  }

  const transcript = decision.entries.filter(
    (entry) => entry.source === "transcript",
  ).length;
  const lines = [
    `Recall found ${decision.entries.length} passage${decision.entries.length === 1 ? "" : "s"} (${transcript} from earlier conversations, ${decision.entries.length - transcript} from memory):`,
  ];
  decision.entries.forEach((entry, index) => {
    lines.push(`  ${index + 1}. ${recallEntryHeader(entry)}`);
    lines.push(`     ${entry.text.replace(/\n/g, " ")}`);
  });
  return lines;
}
