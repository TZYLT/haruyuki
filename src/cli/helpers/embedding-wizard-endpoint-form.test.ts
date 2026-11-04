import { describe, expect, test } from "bun:test";
import { runEmbeddingWizardEndpointTest } from "@/cli/helpers/embedding-wizard-actions";
import {
  applyEmbeddingWizardEvent,
  createEmbeddingWizardState,
  type EmbeddingWizardDeps,
  type EmbeddingWizardState,
} from "@/cli/helpers/embedding-wizard-state";

/**
 * The endpoint form's one invariant (48-1 §7.2): a test embedding is only
 * evidence for the exact URL, model and credential it was measured with.
 *
 * Kept in its own file because the main state-machine test is at the 1,000-line
 * ceiling; this is the "edit invalidates the pass" half of the endpoint flow,
 * and it is the one an Enter press after a back-navigation would otherwise skip.
 */

const apply = applyEmbeddingWizardEvent;

function fakeDeps(): { deps: EmbeddingWizardDeps; probes: () => number } {
  let probes = 0;
  return {
    deps: {
      downloadModel: async () => {
        throw new Error("not used");
      },
      probeEndpoint: async (request) => {
        probes += 1;
        return {
          kind: request.kind,
          model: request.model,
          dimensions: 768,
          norm: 1,
          latencyMs: 12,
        };
      },
      calibrate: async () => {
        throw new Error("not used");
      },
      saveSettings: () => undefined,
      startBuild: () => "not used",
      readEnv: () => undefined,
    },
    probes: () => probes,
  };
}

/** Walk the endpoint form to the masked-key screen, no key typed yet. */
function atEndpointKey(): EmbeddingWizardState {
  let state = apply(createEmbeddingWizardState(), {
    type: "choose-backend",
    backend: "endpoint",
  });
  state = apply(state, { type: "choose-gpu", role: "auto" });
  state = apply(state, { type: "choose-endpoint-kind", kind: "openai" });
  state = apply(state, {
    type: "update-endpoint",
    field: "baseUrl",
    value: "https://api.example.com/v1",
  });
  state = apply(state, { type: "next" });
  state = apply(state, {
    type: "update-endpoint",
    field: "model",
    value: "text-embedding-3-small",
  });
  state = apply(state, { type: "next" });
  state = apply(state, { type: "next" });
  return state;
}

function atEndpointTest(): EmbeddingWizardState {
  let state = atEndpointKey();
  state = apply(state, {
    type: "update-endpoint",
    field: "apiKey",
    value: "sk-test-123",
  });
  return apply(state, { type: "next" });
}

describe("the endpoint form's test-embed", () => {
  test("editing the credential or the URL invalidates the pass it was measured with", async () => {
    const { deps, probes } = fakeDeps();
    const passed = await runEmbeddingWizardEndpointTest(atEndpointTest(), deps);
    expect(passed.endpoint.test.phase).toBe("passed");
    expect(passed.endpoint.verified).not.toBeNull();
    expect(probes()).toBe(1);

    // Escape from the test screen lands on the masked key field; changing the
    // credential there must clear the pass, or Enter would advance to a form
    // that was never tested (48-1 §7.2).
    const atKey = apply(passed, { type: "back" });
    expect(atKey.step).toBe("endpoint-key");
    const edited = apply(atKey, {
      type: "update-endpoint",
      field: "apiKey",
      value: "sk-other-key",
    });
    expect(edited.endpoint.test.phase).toBe("idle");
    expect(edited.endpoint.verified).toBeNull();
    const forward = apply(edited, { type: "next" });
    expect(forward.step).toBe("endpoint-test");
    // Enter on the test screen cannot skip the fresh round trip.
    expect(apply(forward, { type: "next" }).step).toBe("endpoint-test");

    // The environment-variable name is the same credential by another route.
    const byEnvName = apply(apply(passed, { type: "back" }), {
      type: "update-endpoint",
      field: "apiKeyEnv",
      value: "HARUYUKI_EMBEDDING_API_KEY",
    });
    expect(byEnvName.endpoint.test.phase).toBe("idle");
    expect(byEnvName.endpoint.verified).toBeNull();

    // And so is an edited URL or model.
    for (const update of [
      { field: "baseUrl" as const, value: "https://api.example.com/v2" },
      { field: "model" as const, value: "text-embedding-3-large" },
    ]) {
      const state = apply(passed, { type: "update-endpoint", ...update });
      expect(state.endpoint.test.phase).toBe("idle");
      expect(state.endpoint.verified).toBeNull();
    }
  });
});
