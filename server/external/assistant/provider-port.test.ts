import { afterEach, describe, expect, it, vi } from "vitest";

import { type AssistantPortInput, buildPortInput } from "../../domain/index.ts";
import {
  ASSISTANT_SETTING_OFF,
  institutionAiSwitchOf,
  PRODUCTION_ASSISTANT_SETTING,
  readAssistantSetting,
} from "./institution-setting.ts";
import {
  AI_DISABLED_RULES,
  createAssistantProviderPort,
  createProductionAssistantProviderPort,
  isCostConfigured,
} from "./provider-port.ts";
import { createSyntheticAssistant } from "./synthetic-assistant.ts";

// SRV-1809 (plan M9.0-S2, M9.0-S3; D-267 O1, O5, O9, O10; OC-1, OC-2).
// Acceptance 1: without the setting switched on the port answers ai_disabled.
// Invented values only: model-test-1 and amounts that mean nothing (T8).

function input(): AssistantPortInput {
  return buildPortInput({
    instructions: "Upute poslužitelja za svrhu proofreading (izmišljeno).",
    data: [{ kind: "paragraph", text: "Izmišljeni odlomak o gradskom vijeću.", truncated: false }],
    tools: [],
    purposeKey: "proofreading",
    modelId: "model-test-1",
  });
}

/** A complete configuration from the test only: the code has no amount of its own. */
const COST = Object.freeze({
  studentDayMicro: 3n,
  studentAssignmentDayMicro: 2n,
  reserveMicro: 1n,
});
const ON = Object.freeze({ enabled: true });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("institution setting (M9.0-S3, OC-1)", () => {
  it("is off by default and in production", () => {
    expect(ASSISTANT_SETTING_OFF).toEqual({ enabled: false, transcription: false, tools: false });
    expect(PRODUCTION_ASSISTANT_SETTING).toEqual(ASSISTANT_SETTING_OFF);
    expect(Object.isFrozen(PRODUCTION_ASSISTANT_SETTING)).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty object", {}],
    ["a string true", { enabled: "true" }],
    ["one", { enabled: 1 }],
    ["an array", [true]],
    ["a typo beside enabled", { enabled: true, tool: true }],
    ["an inherited flag", Object.create({ enabled: true }) as unknown],
    ["a class instance", Object.assign(new (class {})(), { enabled: true })],
  ])("reads %s as off", (_name, value) => {
    expect(readAssistantSetting(value)).toEqual(ASSISTANT_SETTING_OFF);
  });

  it("turns transcription and tools on only beside the assistant", () => {
    expect(readAssistantSetting({ transcription: true, tools: true })).toEqual(
      ASSISTANT_SETTING_OFF,
    );
    expect(readAssistantSetting({ enabled: true })).toEqual({
      enabled: true,
      transcription: false,
      tools: false,
    });
    expect(readAssistantSetting({ enabled: true, transcription: true, tools: true })).toEqual({
      enabled: true,
      transcription: true,
      tools: true,
    });
  });

  it("gives the domain switch nothing while the assistant is off", () => {
    expect(institutionAiSwitchOf({ enabled: false, transcription: true, tools: true })).toEqual({
      transcription: false,
      tools: false,
    });
    expect(institutionAiSwitchOf(readAssistantSetting({ enabled: true, tools: true }))).toEqual({
      transcription: false,
      tools: true,
    });
  });
});

describe("cost configuration: empty means off (P1, D-267 O5)", () => {
  it("is configured only with every limit above zero", () => {
    expect(isCostConfigured(COST)).toBe(true);
  });

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["a missing limit", { studentDayMicro: 3n, studentAssignmentDayMicro: 2n }],
    ["a null limit", { ...COST, reserveMicro: null }],
    ["a zero limit", { ...COST, studentDayMicro: 0n }],
    ["a negative limit", { ...COST, studentDayMicro: -1n }],
    ["a number instead of bigint", { ...COST, reserveMicro: 1 }],
    ["a string", { ...COST, reserveMicro: "1" }],
    ["an extra key", { ...COST, serviceCapMicro: 9n }],
    ["an array", [COST]],
  ])("is not configured with %s", (_name, value) => {
    expect(isCostConfigured(value)).toBe(false);
  });
});

describe("gated provider port (acceptance 1)", () => {
  it("answers ai_disabled without the setting, and never calls the adapter", async () => {
    for (const setting of [undefined, null, {}, { enabled: false }, ASSISTANT_SETTING_OFF]) {
      const adapter = createSyntheticAssistant({ branch: "success", actualMicro: 1n });
      const port = createAssistantProviderPort({ setting, costConfig: COST, adapter });
      expect(await port.complete(input())).toEqual({ kind: "ai_disabled", rule: "setting_off" });
      expect(adapter.calls).toEqual([]);
    }
  });

  it("answers ai_disabled with an empty cost configuration", async () => {
    for (const costConfig of [null, undefined, {}, { ...COST, reserveMicro: null }]) {
      const adapter = createSyntheticAssistant({ branch: "success", actualMicro: 1n });
      const port = createAssistantProviderPort({ setting: ON, costConfig, adapter });
      expect(await port.complete(input())).toEqual({
        kind: "ai_disabled",
        rule: "cost_config_empty",
      });
      expect(adapter.calls).toEqual([]);
    }
  });

  it("answers ai_disabled without an adapter", async () => {
    const port = createAssistantProviderPort({ setting: ON, costConfig: COST, adapter: null });
    expect(await port.complete(input())).toEqual({ kind: "ai_disabled", rule: "no_adapter" });
  });

  it("checks the setting first, then the cost configuration, then the adapter", async () => {
    const port = createAssistantProviderPort({ setting: null, costConfig: null, adapter: null });
    expect(await port.complete(input())).toMatchObject({ rule: "setting_off" });
    expect(AI_DISABLED_RULES).toEqual(["setting_off", "cost_config_empty", "no_adapter"]);
  });

  it("returns the synthetic adapter's invented text when everything is on", async () => {
    const adapter = createSyntheticAssistant({ branch: "success", actualMicro: 1n });
    const port = createAssistantProviderPort({ setting: ON, costConfig: COST, adapter });
    expect(await port.complete(input())).toEqual({
      kind: "success",
      text: "Synthetic answer for purpose proofreading.",
      actualMicro: 1n,
    });
    expect(adapter.calls).toHaveLength(1);
  });

  it("passes every adapter branch through unchanged", async () => {
    const adapter = createSyntheticAssistant([{ branch: "timeout" }, { branch: "provider_error" }]);
    const port = createAssistantProviderPort({ setting: ON, costConfig: COST, adapter });
    expect(await port.complete(input())).toEqual({ kind: "timeout" });
    expect(await port.complete(input())).toEqual({ kind: "provider_error" });
  });

  it("production has no setting, no cost configuration and no adapter, and opens no network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const port = createProductionAssistantProviderPort();
    expect(port.setting).toEqual(ASSISTANT_SETTING_OFF);
    expect(await port.complete(input())).toEqual({ kind: "ai_disabled", rule: "setting_off" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads the setting once, at composition: a later change of the value turns nothing on", async () => {
    const value: Record<string, unknown> = { enabled: false };
    const adapter = createSyntheticAssistant({ branch: "success", actualMicro: 1n });
    const port = createAssistantProviderPort({ setting: value, costConfig: COST, adapter });
    value.enabled = true;
    expect(await port.complete(input())).toMatchObject({ kind: "ai_disabled" });
    expect(adapter.calls).toEqual([]);
  });
});
