import { describe, expect, it } from "vitest";

import {
  buildPortInput,
  parseProviderEntry,
  RESPONSE_MAX_BYTES,
} from "../../../server/domain/index.ts";
import {
  createFakeAi,
  FAKE_AI_ENV,
  FAKE_AI_MARKERS,
  FAKE_AI_MODEL_ID,
  FAKE_AI_PROVIDER_ENTRY,
  fakeAiFromEnv,
} from "./index.ts";

function input(paragraph: string, modelId = FAKE_AI_MODEL_ID, maxResponseBytes?: number) {
  return buildPortInput({
    instructions: "Izmišljene upute.",
    data: [{ kind: "paragraph", text: paragraph, truncated: false }],
    tools: [],
    purposeKey: "clarity",
    modelId,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });
}

describe("fake local AI", () => {
  it("answers deterministically and records the call", async () => {
    const fake = createFakeAi();
    const a = await fake.complete(input("Izmišljeni odlomak."));
    const b = await fake.complete(input("Izmišljeni odlomak."));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: "success", actualMicro: 0n });
    if (a.kind !== "success") throw new Error("expected success");
    expect(Buffer.byteLength(a.text)).toBeLessThanOrEqual(RESPONSE_MAX_BYTES);
    expect(fake.calls).toHaveLength(2);
  });

  it("never returns an answer above the port's maxResponseBytes", async () => {
    const fake = createFakeAi();
    const out = await fake.complete(input("Izmišljeni odlomak.", FAKE_AI_MODEL_ID, 10));
    expect(out).toEqual({ kind: "provider_error" });
    const ok = await fake.complete(input("Izmišljeni odlomak.", FAKE_AI_MODEL_ID, 1000));
    expect(ok.kind).toBe("success");
  });

  it("different paragraphs can give different answers", async () => {
    const fake = createFakeAi();
    const texts = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const out = await fake.complete(input(`Odlomak ${i}`));
      if (out.kind === "success") texts.add(out.text);
    }
    expect(texts.size).toBeGreaterThan(1);
  });

  it("refuses: a mode, a marker and a foreign model are provider errors or branches", async () => {
    expect(await createFakeAi({ mode: "refuse" }).complete(input("x"))).toEqual({
      kind: "provider_error",
    });
    expect(await createFakeAi().complete(input(`${FAKE_AI_MARKERS.refuse} x`))).toEqual({
      kind: "provider_error",
    });
    expect(await createFakeAi().complete(input("x", "another-model"))).toEqual({
      kind: "provider_error",
    });
  });

  it("times out and aborts", async () => {
    expect(await createFakeAi({ mode: "timeout" }).complete(input("x"))).toEqual({
      kind: "timeout",
    });
    expect(await createFakeAi().complete(input(`${FAKE_AI_MARKERS.timeout} x`))).toEqual({
      kind: "timeout",
    });
    expect(await createFakeAi().complete(input(`${FAKE_AI_MARKERS.aborted} x`))).toEqual({
      kind: "aborted",
    });
    expect(await createFakeAi({ delayMs: 50, timeoutMs: 5 }).complete(input("x"))).toEqual({
      kind: "timeout",
    });
    const controller = new AbortController();
    const pending = createFakeAi({ delayMs: 1000, signal: controller.signal }).complete(input("x"));
    controller.abort();
    expect(await pending).toEqual({ kind: "aborted" });
    const done = new AbortController();
    done.abort();
    expect(await createFakeAi({ signal: done.signal }).complete(input("x"))).toEqual({
      kind: "aborted",
    });
  });

  it("rejects what is not a port input and bad options", async () => {
    await expect(createFakeAi().complete({ ...input("x"), extra: 1 } as never)).rejects.toThrow(
      TypeError,
    );
    expect(() => createFakeAi({ actualMicro: -1n })).toThrow(TypeError);
    expect(() => createFakeAi({ mode: "nope" as never })).toThrow(TypeError);
  });

  it("is a valid provider entry for the faculty rules", () => {
    expect(parseProviderEntry(FAKE_AI_PROVIDER_ENTRY).ok).toBe(true);
  });

  it("is selected only by the explicit switch and only locally", () => {
    expect(fakeAiFromEnv({})).toBeNull();
    expect(fakeAiFromEnv({ [FAKE_AI_ENV]: "0" })).toBeNull();
    expect(fakeAiFromEnv({ [FAKE_AI_ENV]: "true" })).toBeNull();
    expect(fakeAiFromEnv({ [FAKE_AI_ENV]: "1", NODE_ENV: "development" })).not.toBeNull();
    expect(fakeAiFromEnv({ [FAKE_AI_ENV]: "1", NODE_ENV: "test" })).not.toBeNull();
    expect(() => fakeAiFromEnv({ [FAKE_AI_ENV]: "1", NODE_ENV: "production" })).toThrow(
      /only locally/u,
    );
    // Production without the switch stays quiet: the fake is simply off.
    expect(fakeAiFromEnv({ NODE_ENV: "production" })).toBeNull();
  });
});
