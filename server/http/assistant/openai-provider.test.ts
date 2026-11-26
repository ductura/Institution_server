import { describe, expect, it } from "vitest";

import { DEFAULT_AI_MODEL, openAiProviderFrom } from "./openai-provider.ts";

const FULL = {
  ["OPENAI_API_KEY"]: "test-key",
  ["AI_RATE_INPUT_MICRO_PER_MTOK"]: "2",
  ["AI_RATE_OUTPUT_MICRO_PER_MTOK"]: "10",
};

describe("openAiProviderFrom", () => {
  it("is null without a key, and with missing, zero or malformed prices (ai_disabled)", () => {
    expect(openAiProviderFrom({})).toBeNull();
    expect(openAiProviderFrom({ ...FULL, ["OPENAI_API_KEY"]: undefined })).toBeNull();
    expect(openAiProviderFrom({ ...FULL, ["OPENAI_API_KEY"]: "  " })).toBeNull();
    expect(openAiProviderFrom({ ...FULL, ["AI_RATE_INPUT_MICRO_PER_MTOK"]: undefined })).toBeNull();
    expect(openAiProviderFrom({ ...FULL, ["AI_RATE_OUTPUT_MICRO_PER_MTOK"]: "0" })).toBeNull();
    expect(openAiProviderFrom({ ...FULL, ["AI_RATE_OUTPUT_MICRO_PER_MTOK"]: "1.5" })).toBeNull();
    expect(openAiProviderFrom({ ...FULL, ["AI_RATE_OUTPUT_MICRO_PER_MTOK"]: "-3" })).toBeNull();
  });

  it("takes the model from AI_MODEL, else the default; passes the provider ban", () => {
    expect(openAiProviderFrom(FULL)?.config.provider.modelId).toBe(DEFAULT_AI_MODEL);
    const chosen = openAiProviderFrom({ ...FULL, ["AI_MODEL"]: "model-test-2" });
    expect(chosen?.config.provider).toMatchObject({
      providerId: "openai",
      modelId: "model-test-2",
    });
    expect(openAiProviderFrom({ ...FULL, ["AI_MODEL"]: "Bad Model!" })).toBeNull();
    expect(openAiProviderFrom({ ...FULL, ["AI_CONFIG_VERSION"]: "bad version" })).toBeNull();
  });
});
