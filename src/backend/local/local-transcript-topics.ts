/**
 * Topic-marker scan for a local transcript. Markers are metadata appended to
 * `messages.jsonl` (see `LocalTranscriptTopicEntry`); this module owns reading
 * them back.
 *
 * The scan cannot use the bounded tail reader in `local-transcript.ts`: a trim
 * keeps every marker, so the oldest one may sit far before the resident window.
 * It also must not parse the message rows, which dominate the file by orders of
 * magnitude — hence the chunked byte scan plus a substring pre-filter.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  isLocalTranscriptTopicEntry,
  type LocalTranscriptTopicEntry,
} from "./local-transcript-topic-entry";

/** Read granularity for the scan below; not a knob, so it stays module-private. */
const TOPIC_SCAN_CHUNK_BYTES = 256 * 1024;

/**
 * Yield the raw lines of a JSONL file in bounded chunks. `StringDecoder` holds
 * partial multi-byte characters across chunk boundaries, so a title containing
 * non-ASCII text survives a split.
 */
function* rawJsonlLines(path: string, chunkBytes: number): Generator<string> {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size === 0) return;

  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(Math.max(1, Math.min(size, chunkBytes)));
  const decoder = new StringDecoder("utf8");
  let carry = "";
  try {
    let offset = 0;
    while (offset < size) {
      const bytes = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (bytes <= 0) break;
      offset += bytes;
      carry += decoder.write(buffer.subarray(0, bytes));
      let newline = carry.indexOf("\n");
      while (newline >= 0) {
        yield carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        newline = carry.indexOf("\n");
      }
    }
    carry += decoder.end();
  } finally {
    closeSync(fd);
  }
  if (carry.length > 0) yield carry;
}

/**
 * Read every topic marker in a transcript, oldest first. Unparseable lines and
 * rows that do not satisfy the marker shape are skipped: a marker is metadata,
 * so a damaged one must never block loading a conversation.
 */
export function readLocalTranscriptTopicEntries(
  messagesPath: string,
  options: { chunkBytes?: number } = {},
): LocalTranscriptTopicEntry[] {
  const entries: LocalTranscriptTopicEntry[] = [];
  for (const line of rawJsonlLines(
    messagesPath,
    options.chunkBytes ?? TOPIC_SCAN_CHUNK_BYTES,
  )) {
    // Cheap pre-filter before JSON.parse: the discriminator key is a small
    // substring next to a line that may hold thousands of message tokens.
    if (!line.includes('"topic"')) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (isLocalTranscriptTopicEntry(row)) entries.push(row);
  }
  return entries;
}
