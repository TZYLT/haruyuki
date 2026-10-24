/**
 * What to say when the local backend has no model to run.
 *
 * This used to branch on whether the user held Cloud credentials, because the
 * logged-out copy pointed at `/login`. That command is gone, so there is only
 * one thing to suggest: connect a provider locally.
 */
const LOCAL_NO_MODEL_RESPONSE = [
  "It looks like we're in local mode, but we don't have any models available yet.",
  "",
  "to get set up, you can either:",
  "- run `/config connect` to add a provider from inside haruyuki code",
  "- export a provider key in your env and restart `haruyuki`, for example `export OPENAI_API_KEY=...`",
  "",
  "once one of those is set up, send your message again and we can get started.",
].join("\n");

export function buildLocalNoModelResponse(): string {
  return LOCAL_NO_MODEL_RESPONSE;
}

export function splitSyntheticAssistantResponse(text: string): string[] {
  const chunks: string[] = [];
  const lines = text.split(/(\n)/);

  for (const line of lines) {
    if (line === "") {
      continue;
    }
    if (line === "\n") {
      chunks.push(line);
      continue;
    }

    const parts = line.match(/\S+\s*|\s+/g) ?? [line];
    let current = "";
    for (const part of parts) {
      current += part;
      const trimmed = current.trimEnd();
      const shouldFlush =
        trimmed.endsWith(",") ||
        trimmed.endsWith(".") ||
        trimmed.endsWith(":") ||
        trimmed.endsWith("?") ||
        trimmed.endsWith("!") ||
        current.length >= 28;
      if (shouldFlush) {
        chunks.push(current);
        current = "";
      }
    }

    if (current) {
      chunks.push(current);
    }
  }

  return chunks.length > 0 ? chunks : [text];
}
