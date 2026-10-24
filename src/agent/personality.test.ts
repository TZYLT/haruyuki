import { afterEach, describe, expect, test } from "bun:test";
import {
  buildCreateAgentOptionsForPersonality,
  detectPersonalityFromPersonaFile,
  enableMemfsForCreatedAgent,
  replaceBodyPreservingFrontmatter,
} from "@/agent/personality";
import {
  buildPersonalityTag,
  DEFAULT_CREATE_AGENT_PERSONALITIES,
  getDefaultHumanContent,
  getPersonalityBlockDefinitions,
  getPersonalityBlockValues,
  getPersonalityContent,
  getPersonalityCreationTags,
  getPersonalityDefaultMemoryFiles,
  getPersonalityHumanContent,
  ONBOARDING_PERSONALITIES,
  PERSONALITY_OPTIONS,
  resolvePersonalityId,
  resolvePersonalityIdFromTags,
} from "@/agent/personality-presets";
import { configureBackendMode } from "@/backend";
import { __testOverrideGetClient } from "@/backend/api/client";
import { settingsManager } from "@/settings-manager";

const VALID_FRONTMATTER = "---\ndescription: Persona\nlimit: 20000\n---\n\n";
const originalSetMemfsEnabled =
  settingsManager.setMemfsEnabled.bind(settingsManager);

afterEach(() => {
  __testOverrideGetClient(null);
  settingsManager.setMemfsEnabled = originalSetMemfsEnabled;
  configureBackendMode("api");
});

describe("personality helpers", () => {
  test("replaceBodyPreservingFrontmatter swaps body and keeps frontmatter", () => {
    const existing = `${VALID_FRONTMATTER}old persona content\n`;
    const updated = replaceBodyPreservingFrontmatter(existing, "new body");

    expect(updated.startsWith(VALID_FRONTMATTER)).toBe(true);
    expect(updated).toContain("new body\n");
    expect(updated).not.toContain("old persona content");
  });

  test("replaceBodyPreservingFrontmatter rejects missing frontmatter", () => {
    expect(() =>
      replaceBodyPreservingFrontmatter("no frontmatter", "new body"),
    ).toThrowError();
  });

  test("detectPersonalityFromPersonaFile resolves built-in personalities", () => {
    for (const option of PERSONALITY_OPTIONS) {
      const personaFile = `${VALID_FRONTMATTER}${getPersonalityContent(option.id)}`;
      expect(detectPersonalityFromPersonaFile(personaFile)).toBe(option.id);
    }
  });

  test("detectPersonalityFromPersonaFile returns null for unknown body", () => {
    const personaFile = `${VALID_FRONTMATTER}This does not match any preset.\n`;
    expect(detectPersonalityFromPersonaFile(personaFile)).toBeNull();
  });

  test("resolvePersonalityId accepts public Haruyuki alias", () => {
    expect(resolvePersonalityId("letta-code")).toBe("memo");
    expect(resolvePersonalityId("LettaCode")).toBe("memo");
    expect(resolvePersonalityId("memo")).toBe("memo");
  });

  test("personality block values always include both persona and human", () => {
    for (const option of PERSONALITY_OPTIONS) {
      const values = getPersonalityBlockValues(option.id);
      expect(values.persona.trim().length).toBeGreaterThan(0);
      expect(values.human.trim().length).toBeGreaterThan(0);
    }
  });

  test("claude and codex use the default human block", () => {
    const defaultHuman = getDefaultHumanContent();
    expect(getPersonalityHumanContent("claude")).toBe(defaultHuman);
    expect(getPersonalityHumanContent("codex")).toBe(defaultHuman);
  });

  test("tutorial uses its dedicated human block", () => {
    const tutorialHuman = getPersonalityHumanContent("tutorial");
    const definitions = getPersonalityBlockDefinitions("tutorial");

    expect(tutorialHuman).toContain("## What they work on");
    expect(tutorialHuman).not.toBe(getPersonalityHumanContent("memo"));
    expect(definitions.human.templatePromptAssetName).toBe(
      "human_tutorial.mdx",
    );
  });

  test("tutorial description explains the onboarding role", () => {
    const tutorialOption = PERSONALITY_OPTIONS.find(
      (option) => option.id === "tutorial",
    );

    expect(tutorialOption?.description).toBe(
      "I help with getting started with Haruyuki. I can answer any questions about Haruyuki, and also help you create and configure agents.",
    );
  });

  test("tutorial owns its default profile picture metadata", () => {
    expect(getPersonalityDefaultMemoryFiles("tutorial")).toEqual([
      {
        path: "profile.png",
        assetId: "tutor-profile",
        commitMessage: "chore: set default Tutor profile picture",
      },
    ]);
    expect(getPersonalityCreationTags("tutorial")).toEqual([
      buildPersonalityTag("tutorial"),
    ]);
    expect(getPersonalityDefaultMemoryFiles("memo")).toEqual([]);
    expect(getPersonalityCreationTags("memo")).toEqual([]);
  });

  test("personality tags round-trip without inferring unrelated tags", () => {
    for (const option of PERSONALITY_OPTIONS) {
      expect(
        resolvePersonalityIdFromTags([buildPersonalityTag(option.id)]),
      ).toBe(option.id);
    }
    expect(resolvePersonalityIdFromTags(["origin:onboarding"])).toBeNull();
  });

  test("default create-agent personalities include memo, tutorial, blank, linus, and kawaii", () => {
    expect(DEFAULT_CREATE_AGENT_PERSONALITIES).toEqual([
      "memo",
      "tutorial",
      "blank",
      "linus",
      "kawaii",
    ]);
  });

  test("buildCreateAgentOptionsForPersonality maps the curated presets to personality-specific memory blocks", async () => {
    for (const personality of [...DEFAULT_CREATE_AGENT_PERSONALITIES]) {
      const definitions = getPersonalityBlockDefinitions(personality);
      const options = await buildCreateAgentOptionsForPersonality({
        personalityId: personality,
      });
      const personaBlock = options.memoryBlocks?.find(
        (block): block is { label: string; value: string } =>
          "label" in block && block.label === "persona",
      );
      const humanBlock = options.memoryBlocks?.find(
        (block): block is { label: string; value: string } =>
          "label" in block && block.label === "human",
      );

      expect(options).toMatchObject({
        name: PERSONALITY_OPTIONS.find((option) => option.id === personality)
          ?.label,
        description: PERSONALITY_OPTIONS.find(
          (option) => option.id === personality,
        )?.description,
        // The environment is implicit here, and the only backend reports local
        // memfs; the Cloud root layout is reachable only via an explicit
        // `environment: "cloud"`.
        memoryPromptMode: "local-memfs",
      });
      expect(personaBlock?.value).toBe(definitions.persona.value);
      expect(humanBlock?.value).toBe(definitions.human.value);
    }
  });

  test("tutorial includes onboarding memory by default", async () => {
    expect(ONBOARDING_PERSONALITIES).toEqual(["memo", "tutorial"]);

    const options = await buildCreateAgentOptionsForPersonality({
      personalityId: "tutorial",
    });
    const onboardingBlock = options.memoryBlocks?.find(
      (block): block is { label: string; value: string } =>
        "label" in block && block.label === "onboarding",
    );

    expect(onboardingBlock?.value).toContain(
      "This is a first contact, not a feature tour.",
    );
    // There is no Cloud variant to offer a profile picture any more: the
    // default environment is local, and the local text says not to.
    expect(onboardingBlock?.value).toContain("This build runs locally.");
    expect(
      getPersonalityBlockDefinitions("tutorial").onboarding
        ?.templatePromptAssetName,
    ).toBe("onboarding.mdx");
  });

  test("local tutorial onboarding disables profile pictures and image generation", async () => {
    configureBackendMode("local");

    const options = await buildCreateAgentOptionsForPersonality({
      personalityId: "tutorial",
    });
    const onboardingBlock = options.memoryBlocks?.find(
      (block): block is { label: string; value: string } =>
        "label" in block && block.label === "onboarding",
    );

    expect(onboardingBlock?.value).toContain("This build runs locally.");
    expect(onboardingBlock?.value).toContain(
      "Do not offer or attempt to create, generate, or set a profile picture or other image.",
    );
    expect(onboardingBlock?.value).not.toContain(
      "Offer to create one yourself.",
    );
    expect(options.memoryPromptMode).toBe("local-memfs");
    expect(
      getPersonalityBlockDefinitions("tutorial", "local").onboarding
        ?.templatePromptAssetName,
    ).toBe("onboarding_local.mdx");
  });

  test("tutorial persona body drives proactive onboarding progression", () => {
    const body = getPersonalityContent("tutorial");
    expect(body).not.toContain("The skill owns the tutorial flow");
    expect(body).not.toContain("letta-help");
    expect(body).toContain("I never leave someone standing in an open field");
    expect(body).toContain("Every turn ends with a clear next step");
    expect(body).toContain("Progress through the onboarding naturally");
    expect(body).toContain("what should I call you");
    expect(body).toContain("do not run whatever build happens");
    expect(body).toContain("do not append remembered product commands");
    expect(body).toContain("load the self-configuration skill");
    expect(body).toContain("Ending a complete answer with");
    expect(body).toContain("the final sentence is the recommended action");
  });

  test("onboarding block is a first-contact guide, not a feature checklist", async () => {
    const options = await buildCreateAgentOptionsForPersonality({
      personalityId: "tutorial",
    });
    const onboardingBlock = options.memoryBlocks?.find(
      (block): block is { label: string; value: string } =>
        "label" in block && block.label === "onboarding",
    );

    // One question at a time, asked once, and no capability tour: S-13 came
    // from a greeting that turned into a workspace inspection.
    expect(onboardingBlock?.value).toContain("Ask one question at a time");
    expect(onboardingBlock?.value).toContain("Ask once.");
    expect(onboardingBlock?.value).toContain(
      "Do not read their files, inspect the working directory",
    );
    expect(onboardingBlock?.value).toContain("First contact:");
    expect(onboardingBlock?.value).not.toContain("Connect to a channel");
    expect(onboardingBlock?.value).not.toContain("Mark an item `[x]`");
  });

  test("unguided personalities do not include onboarding", async () => {
    for (const personality of [
      "blank",
      "coding",
      "linus",
      "kawaii",
      "claude",
      "codex",
    ] as const) {
      const options = await buildCreateAgentOptionsForPersonality({
        personalityId: personality,
      });
      expect(
        options.memoryBlocks?.some(
          (block) => "label" in block && block.label === "onboarding",
        ),
      ).toBe(false);
    }
  });

  test("buildCreateAgentOptionsForPersonality preserves caller-provided tags", async () => {
    const options = await buildCreateAgentOptionsForPersonality({
      personalityId: "memo",
      tags: ["desktop", "favorite"],
    });

    expect(options.tags).toEqual(["desktop", "favorite"]);
  });

  test("enableMemfsForCreatedAgent skips remote API calls on local backend", async () => {
    configureBackendMode("local");
    let getClientCalls = 0;
    let enabledAgentId: string | undefined;
    __testOverrideGetClient(async () => {
      getClientCalls += 1;
      return {
        agents: {
          update: async () => undefined,
        },
      };
    });
    settingsManager.setMemfsEnabled = (agentId, enabled) => {
      if (enabled) {
        enabledAgentId = agentId;
      }
    };

    await enableMemfsForCreatedAgent({
      agentId: "agent-local-test",
      agentTags: [],
    });

    expect(getClientCalls).toBe(0);
    expect(enabledAgentId).toBe("agent-local-test");
  });

  test("kawaii block definitions carry personality-specific descriptions", () => {
    const definitions = getPersonalityBlockDefinitions("kawaii");
    expect(definitions.persona.description).toContain("sparkly memory");
    expect(definitions.human.description).toContain("senpai");
  });

  test("blank personality uses persona_blank.mdx content", () => {
    const content = getPersonalityContent("blank");
    expect(content).toContain("blank starter personality");
    expect(content).toContain("ask the user to provide a personality prompt");
  });

  test("blank personality uses the default human block", () => {
    const defaultHuman = getDefaultHumanContent();
    expect(getPersonalityHumanContent("blank")).toBe(defaultHuman);
  });
});
