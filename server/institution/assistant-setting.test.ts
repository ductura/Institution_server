import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";

import {
  assistantSettingOf,
  readAssistantSetting,
  type AssistantSettingSource,
} from "./assistant-setting.ts";

// Invented faculties and settings only.
const TOKEN = "T".repeat(43);
type Row = Record<string, unknown>;

function withRows(rows: Row[]): { withActor: WithActor; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows }));
  const withActor: WithActor = (_token, run) => run({ query } as unknown as ActorTransaction);
  return { withActor, query };
}

function failing(code: string): WithActor {
  return async () => {
    throw Object.assign(new Error("kanarinac-asistent-5d1"), { code });
  };
}

const ON: AssistantSettingSource = {
  assistant: true,
  switchOf: (slug) =>
    slug === "izmisljeni-fakultet" ? { version: 3, transcription: true, tools: false } : null,
};

afterEach(() => vi.restoreAllMocks());

describe("assistantSettingOf", () => {
  it("is both flags off and no version without a faculty setting, never changeable", () => {
    expect(assistantSettingOf(null, false)).toEqual({
      assistant: false,
      transcription: false,
      tools: false,
      settingVersion: null,
      changeable: false,
    });
  });

  it("shows the faculty switch as it is", () => {
    expect(assistantSettingOf({ version: 2, transcription: false, tools: true }, true)).toEqual({
      assistant: true,
      transcription: false,
      tools: true,
      settingVersion: 2,
      changeable: false,
    });
  });
});

describe("readAssistantSetting", () => {
  it("reads the switch of the session's faculty for an administrator", async () => {
    const { withActor, query } = withRows([
      { authenticated: true, admin: true, institutionSlug: "izmisljeni-fakultet" },
    ]);
    expect(await readAssistantSetting(TOKEN, withActor, ON)).toEqual({
      kind: "ok",
      setting: {
        assistant: true,
        transcription: true,
        tools: false,
        settingVersion: 3,
        changeable: false,
      },
    });
    // The institution comes from the session only: the statement has no parameter.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toHaveLength(1);
    expect(String(query.mock.calls[0]![0])).toContain("institution.actor_has_role('admin')");
  });

  it("a faculty without a setting is all off", async () => {
    const { withActor } = withRows([
      { authenticated: true, admin: true, institutionSlug: "drugi-fakultet" },
    ]);
    const read = await readAssistantSetting(TOKEN, withActor, ON);
    expect(read).toEqual({
      kind: "ok",
      setting: {
        assistant: true,
        transcription: false,
        tools: false,
        settingVersion: null,
        changeable: false,
      },
    });
  });

  it("a caller who is not an administrator is notFound and sees nothing", async () => {
    const switchOf = vi.fn(ON.switchOf);
    const { withActor } = withRows([
      { authenticated: true, admin: false, institutionSlug: "izmisljeni-fakultet" },
    ]);
    expect(await readAssistantSetting(TOKEN, withActor, { ...ON, switchOf })).toEqual({
      kind: "notFound",
    });
    expect(switchOf).not.toHaveBeenCalled();
  });

  it("no session, a closed session or ZD401 is unauthorized", async () => {
    expect(await readAssistantSetting(undefined, withRows([]).withActor, ON)).toEqual({
      kind: "unauthorized",
    });
    expect(await readAssistantSetting("kratki", withRows([]).withActor, ON)).toEqual({
      kind: "unauthorized",
    });
    const closed = withRows([{ authenticated: false, admin: false, institutionSlug: null }]);
    expect(await readAssistantSetting(TOKEN, closed.withActor, ON)).toEqual({
      kind: "unauthorized",
    });
    expect(await readAssistantSetting(TOKEN, failing("ZD401"), ON)).toEqual({
      kind: "unauthorized",
    });
  });

  it("ZD403 is notFound; any other failure or a malformed row is unavailable without its text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await readAssistantSetting(TOKEN, failing("ZD403"), ON)).toEqual({ kind: "notFound" });
    expect(await readAssistantSetting(TOKEN, failing("57014"), ON)).toEqual({
      kind: "unavailable",
    });
    for (const rows of [
      [],
      [{ authenticated: true, admin: "da", institutionSlug: "izmisljeni-fakultet" }],
      [{ authenticated: true, admin: true, institutionSlug: 7 }],
      [
        { authenticated: true, admin: true, institutionSlug: "izmisljeni-fakultet" },
        { authenticated: true, admin: true, institutionSlug: "izmisljeni-fakultet" },
      ],
    ]) {
      expect(await readAssistantSetting(TOKEN, withRows(rows).withActor, ON)).toEqual({
        kind: "unavailable",
      });
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain("kanarinac");
  });
});
