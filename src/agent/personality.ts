/**
 * Applying personalities to agents: agent creation via the backend and
 * rewriting persona/human files in an agent's memory repo.
 *
 * Pure preset definitions and content builders live in
 * `personality-presets.ts` (bundled into the `agent-presets` package export).
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getBackend } from "@/backend";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { settingsManager } from "@/settings-manager";
import type { CreateAgentOptions } from "./create";
import { getDefaultMemoryBlocks, parseMdxFrontmatter } from "./memory";
import {
  getScopedMemoryFilesystemRoot,
  isLettaCloud,
} from "./memory-filesystem";
import { detectMemoryFormat, type LocalMemoryFormat } from "./memory-format";
import { commitMemoryWrite, getMemoryRepoDir, pullMemory } from "./memory-git";
import {
  buildDefaultMemoryFile,
  buildPersonalityMemoryBlocks,
  FRONTMATTER_REGEX,
  getPersonalityBlockDefinitions,
  getPersonalityContent,
  getPersonalityCreationTags,
  getPersonalityDefaultMemoryFiles,
  getPersonalityOption,
  normalizeComparableContent,
  PERSONALITY_OPTIONS,
  type PersonalityEnvironment,
  type PersonalityId,
  type PersonalityOption,
  serializeFrontmatter,
} from "./personality-presets";

const execFile = promisify(execFileCb);

const ROOT_PERSONA_RELATIVE_PATH = "persona.md";
const ROOT_HUMAN_RELATIVE_PATH = "human.md";
const PRIMARY_PERSONA_RELATIVE_PATH = "system/persona.md";
const LEGACY_PERSONA_RELATIVE_PATH = "memory/system/persona.md";
const PRIMARY_HUMAN_RELATIVE_PATH = "system/human.md";
const LEGACY_HUMAN_RELATIVE_PATH = "memory/system/human.md";

export interface ApplyPersonalityToMemoryParams {
  agentId: string;
  personalityId: PersonalityId;
  commitMessage?: string;
}

export interface ApplyPersonalityToMemoryResult {
  changed: boolean;
  personality: PersonalityOption;
  personaRelativePath: string;
  humanRelativePath: string;
  commitMessage?: string;
}

function ensureTrailingNewline(content: string): string {
  return `${content.trimEnd()}\n`;
}

function getMemoryFileRelativePathForRepo(
  repoDir: string,
  primaryRelativePath: string,
  legacyRelativePath: string,
): string {
  const primaryPath = join(repoDir, primaryRelativePath);
  if (existsSync(primaryPath)) {
    return primaryRelativePath;
  }

  const legacyPath = join(repoDir, legacyRelativePath);
  if (existsSync(legacyPath)) {
    return legacyRelativePath;
  }

  // Prefer legacy layout when the repo has a top-level memory/ directory.
  if (existsSync(join(repoDir, "memory"))) {
    return legacyRelativePath;
  }

  return primaryRelativePath;
}

function getPersonaRelativePathForRepo(repoDir: string): string {
  return getMemoryFileRelativePathForRepo(
    repoDir,
    PRIMARY_PERSONA_RELATIVE_PATH,
    LEGACY_PERSONA_RELATIVE_PATH,
  );
}

function getHumanRelativePathForRepo(repoDir: string): string {
  return getMemoryFileRelativePathForRepo(
    repoDir,
    PRIMARY_HUMAN_RELATIVE_PATH,
    LEGACY_HUMAN_RELATIVE_PATH,
  );
}

export interface PersonalityMemoryTargets {
  personaRelativePath: string;
  humanRelativePath: string;
  format: LocalMemoryFormat;
}

/**
 * Where a personality switch may write persona/human in this memory repo.
 *
 * MemFS v2 (root-marker) keeps core memory at the repository root, and its
 * pre-commit hook rejects Markdown below any directory without its own
 * `MEMORY.md` index. Writing `system/persona.md` into such a repo therefore
 * cannot be committed — the switch fails and leaves stray files behind — so the
 * v2 targets are the root files. MemFS v1 keeps the `system/` layout, with
 * `memory/system/` as the pre-rename fallback.
 */
export function resolvePersonalityMemoryTargets(
  repoDir: string,
): PersonalityMemoryTargets {
  if (detectMemoryFormat(repoDir, false) === "memfs-v2") {
    return {
      personaRelativePath: ROOT_PERSONA_RELATIVE_PATH,
      humanRelativePath: ROOT_HUMAN_RELATIVE_PATH,
      format: "memfs-v2",
    };
  }

  return {
    personaRelativePath: getPersonaRelativePathForRepo(repoDir),
    humanRelativePath: getHumanRelativePathForRepo(repoDir),
    format: "memfs-v1",
  };
}

/** Absolute path of the persona file this repo's layout uses. */
export function getPersonaFilePath(repoDir: string): string {
  const { personaRelativePath } = resolvePersonalityMemoryTargets(repoDir);
  return join(repoDir, personaRelativePath);
}

/** Display name for a v2 core file, matching the create path's `name` field. */
function memoryFileDisplayName(relativePath: string): string {
  const stem = relativePath.replace(/\.md$/, "").split("/").at(-1) ?? "";
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

/**
 * "cloud" environment covers any remote backend; only Letta Cloud gets the
 * v2 root layout. Self-hosted servers keep the legacy memfs mode.
 */
async function resolvePersonalityMemoryPromptMode(
  environment: PersonalityEnvironment,
): Promise<CreateAgentOptions["memoryPromptMode"]> {
  if (environment === "local") return "local-memfs";
  try {
    return (await isLettaCloud()) ? "root-memfs" : "memfs";
  } catch {
    // Settings may be uninitialized in tests; fall back to the URL check.
    return isCloudServerUrl() ? "root-memfs" : "memfs";
  }
}

export async function buildCreateAgentOptionsForPersonality(params: {
  personalityId: PersonalityId;
  name?: string;
  description?: string;
  model?: string;
  tags?: string[];
  environment?: PersonalityEnvironment;
}): Promise<CreateAgentOptions> {
  const { personalityId, name, description, model, tags } = params;
  const personality = getPersonalityOption(personalityId);
  const defaultMemoryBlocks = await getDefaultMemoryBlocks();
  const environment =
    params.environment ??
    (getBackend().capabilities.localMemfs ? "local" : "cloud");

  return {
    name: name ?? personality.label,
    description: description ?? personality.description,
    model: model ?? personality.defaultModel,
    tags: [...getPersonalityCreationTags(personalityId), ...(tags ?? [])],
    memoryPromptMode: await resolvePersonalityMemoryPromptMode(environment),
    memoryBlocks: buildPersonalityMemoryBlocks(
      personalityId,
      defaultMemoryBlocks,
      environment,
    ),
  };
}

export async function enableMemfsForCreatedAgent(params: {
  agentId: string;
  agentTags?: string[] | null;
}): Promise<void> {
  const { agentId } = params;

  try {
    // The removed API backend was the only backend that served server-side
    // memory, and tagging an agent there was how memfs got enabled. The local
    // in-process backend owns its memory on disk, so enabling is local state.
    if (getBackend().capabilities.localMemfs) {
      settingsManager.setMemfsEnabled(agentId, true);
    }
  } catch {
    // Self-hosted or memfs not available - skip silently
  }
}

export async function createAgentForPersonality(params: {
  personalityId: PersonalityId;
  name?: string;
  description?: string;
  model?: string;
  tags?: string[];
}): Promise<
  Awaited<ReturnType<typeof import("@/agent/create")["createAgent"]>>
> {
  const { createAgent } = await import("@/agent/create");
  const createOptions = await buildCreateAgentOptionsForPersonality(params);
  const result = await createAgent(createOptions);

  await enableMemfsForCreatedAgent({
    agentId: result.agent.id,
    agentTags: result.agent.tags,
  });

  if (getPersonalityDefaultMemoryFiles(params.personalityId).length > 0) {
    const { enableMemfsIfCloud } = await import("@/agent/memory-filesystem");
    await enableMemfsIfCloud(result.agent.id, {
      agentTags: result.agent.tags,
    });
  }

  return result;
}

export function replaceBodyPreservingFrontmatter(
  existingPersonaFile: string,
  newBody: string,
  options?: { description?: string },
): string {
  const frontmatterMatch = existingPersonaFile.match(FRONTMATTER_REGEX);
  if (!frontmatterMatch || frontmatterMatch.index !== 0) {
    throw new Error(
      "Memory file is missing valid frontmatter; cannot safely replace its body.",
    );
  }

  const normalizedBody = ensureTrailingNewline(newBody.trim());
  if (!normalizedBody.trim()) {
    throw new Error("Personality content cannot be empty");
  }

  const { frontmatter } = parseMdxFrontmatter(existingPersonaFile);
  const mergedFrontmatter = { ...frontmatter };
  if (options?.description !== undefined) {
    mergedFrontmatter.description = options.description;
  }

  return `${serializeFrontmatter(mergedFrontmatter)}\n\n${normalizedBody}`;
}

export function detectPersonalityFromPersonaFile(
  personaFileContent: string,
): PersonalityId | null {
  const currentBody = normalizeComparableContent(
    personaFileContent.replace(FRONTMATTER_REGEX, ""),
  );

  for (const option of PERSONALITY_OPTIONS) {
    const expected = normalizeComparableContent(
      getPersonalityContent(option.id),
    );
    if (currentBody === expected) {
      return option.id;
    }
  }

  return null;
}

async function getMemoryCommitAuthor(agentId: string): Promise<{
  agentId: string;
  authorName: string;
}> {
  let authorName = agentId;

  try {
    const agent = await getBackend().retrieveAgent(agentId);
    if (agent.name?.trim()) {
      authorName = agent.name.trim();
    }
  } catch {
    // best-effort fallback to agent id
  }

  return {
    agentId,
    authorName,
  };
}

function applyPersonalityFiles(
  filesToUpdate: Array<{
    relativePath: string;
    absolutePath: string;
    templatePromptAssetName: string;
    content: string;
    description?: string;
    /** v2 core files require `name`; omitted for the legacy layout. */
    name?: string;
  }>,
): string[] {
  const changedPaths: string[] = [];

  for (const file of filesToUpdate) {
    const existingContent = existsSync(file.absolutePath)
      ? readFileSync(file.absolutePath, "utf-8")
      : null;
    const nextContent = existingContent
      ? replaceBodyPreservingFrontmatter(existingContent, file.content, {
          description: file.description,
        })
      : buildDefaultMemoryFile(
          file.templatePromptAssetName,
          file.content,
          file.description,
          { name: file.name },
        );

    if (
      existingContent !== null &&
      normalizeComparableContent(existingContent) ===
        normalizeComparableContent(nextContent)
    ) {
      continue;
    }

    mkdirSync(dirname(file.absolutePath), { recursive: true });
    writeFileSync(file.absolutePath, nextContent, "utf-8");
    changedPaths.push(file.relativePath);
  }

  return changedPaths;
}

export async function applyPersonalityToMemory(
  params: ApplyPersonalityToMemoryParams,
): Promise<ApplyPersonalityToMemoryResult> {
  const personality = getPersonalityOption(params.personalityId);
  const isLocalMemfs = getBackend().capabilities.localMemfs;
  const blockDefinitions = getPersonalityBlockDefinitions(
    params.personalityId,
    isLocalMemfs ? "local" : "cloud",
  );

  const repoDir = isLocalMemfs
    ? getScopedMemoryFilesystemRoot(params.agentId)
    : getMemoryRepoDir(params.agentId);

  // Fail early if the memory repo has uncommitted changes
  const statusResult = await execFile("git", ["status", "--porcelain"], {
    cwd: repoDir,
    timeout: 10_000,
    windowsHide: true,
  });
  if (statusResult.stdout?.toString().trim()) {
    throw new Error(
      "Memory repo has uncommitted changes. Commit or discard them before switching personality.",
    );
  }

  if (!isLocalMemfs) {
    await pullMemory(params.agentId);
  }

  const targets = resolvePersonalityMemoryTargets(repoDir);
  const personaRelativePath = targets.personaRelativePath;
  const humanRelativePath = targets.humanRelativePath;
  const v2Name = (relativePath: string) =>
    targets.format === "memfs-v2"
      ? memoryFileDisplayName(relativePath)
      : undefined;
  const personaPath = join(repoDir, personaRelativePath);
  const humanPath = join(repoDir, humanRelativePath);

  const filesToUpdate = [
    {
      relativePath: personaRelativePath,
      absolutePath: personaPath,
      templatePromptAssetName: blockDefinitions.persona.templatePromptAssetName,
      content: blockDefinitions.persona.value,
      description: blockDefinitions.persona.description,
      name: v2Name(personaRelativePath),
    },
    {
      relativePath: humanRelativePath,
      absolutePath: humanPath,
      templatePromptAssetName: blockDefinitions.human.templatePromptAssetName,
      content: blockDefinitions.human.value,
      description: blockDefinitions.human.description,
      name: v2Name(humanRelativePath),
    },
  ];

  const changedPaths = applyPersonalityFiles(filesToUpdate);

  if (changedPaths.length === 0) {
    return {
      changed: false,
      personality,
      personaRelativePath,
      humanRelativePath,
    };
  }

  const commitMessage =
    params.commitMessage ??
    `chore(personality): switch to ${personality.label}`;

  const author = await getMemoryCommitAuthor(params.agentId);
  const commitResult = await commitMemoryWrite({
    memoryDir: repoDir,
    pathspecs: changedPaths,
    reason: commitMessage,
    author,
    syncMode: isLocalMemfs ? "local" : "remote",
  });

  if (!commitResult.committed) {
    return {
      changed: false,
      personality,
      personaRelativePath,
      humanRelativePath,
    };
  }

  return {
    changed: true,
    personality,
    personaRelativePath,
    humanRelativePath,
    commitMessage,
  };
}
