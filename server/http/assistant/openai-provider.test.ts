import { describe, expect, it } from "vitest";

import { DEFAULT_AI_MODEL, openAiProviderFrom, type OpenAiEnv } from "./openai-provider.ts";

const FULL = {
  ["OPENAI_API_KEY"]: "test-key",
  ["AI_RATE_INPUT_MICRO_PER_MTOK"]: "2",
  ["AI_RATE_OUTPUT_MICRO_PER_MTOK"]: "10",
};

const from = (env: OpenAiEnv) =>
  openAiProviderFrom(env, {
    transport: () => Promise.reject(new Error("no network in this test")),
  });

describe("openAiProviderFrom", () => {
  it("is null without a key, and with missing, zero or malformed prices (ai_disabled)", () => {
    expect(from({})).toBeNull();
    expect(from({ ...FULL, ["OPENAI_API_KEY"]: undefined })).toBeNull();
    expect(from({ ...FULL, ["OPENAI_API_KEY"]: "  " })).toBeNull();
    expect(from({ ...FULL, ["AI_RATE_INPUT_MICRO_PER_MTOK"]: undefined })).toBeNull();
    expect(from({ ...FULL, ["AI_RATE_OUTPUT_MICRO_PER_MTOK"]: "0" })).toBeNull();
    expect(from({ ...FULL, ["AI_RATE_OUTPUT_MICRO_PER_MTOK"]: "1.5" })).toBeNull();
    expect(from({ ...FULL, ["AI_RATE_OUTPUT_MICRO_PER_MTOK"]: "-3" })).toBeNull();
  });

  it("takes the model from AI_MODEL, else the default; passes the provider ban", () => {
    expect(from(FULL)?.config.provider.modelId).toBe(DEFAULT_AI_MODEL);
    const chosen = from({ ...FULL, ["AI_MODEL"]: "model-test-2" });
    expect(chosen?.config.provider).toMatchObject({
      providerId: "openai",
      modelId: "model-test-2",
    });
    expect(from({ ...FULL, ["AI_MODEL"]: "Bad Model!" })).toBeNull();
    expect(from({ ...FULL, ["AI_CONFIG_VERSION"]: "bad version" })).toBeNull();
  });
});
