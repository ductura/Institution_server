// SRV-1303: the retention adapter over a scripted connection: the SQL each
// call sends, the dry run's rollback, and the closed codes for errors. The
// function itself is tested on PostgreSQL in db/main/tests/181-purge-ended-sessions.sql.
import { describe, expect, it } from "vitest";

import { createEndedSessionsPurge, type RetentionClient } from "./ended-sessions.ts";
import { ScheduledJobError } from "./schedule.ts";

const CUT = new Date("2026-11-07T00:00:00.000Z");
const dbError = (code: string) => Object.assign(new Error("synthetic database text"), { code });

function scripted(
  answer: (text: string) => { rows: Record<string, unknown>[] } | Error,
): RetentionClient & { calls: Array<{ text: string; values: readonly unknown[] | undefined }> } {
  const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      const result = answer(text);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("createEndedSessionsPurge", () => {
  it("purges through the retention function with the cut and returns the count", async () => {
    const client = scripted(() => ({ rows: [{ deleted: 4 }] }));
    expect(await createEndedSessionsPurge(client).purge(CUT)).toBe(4);
    expect(client.calls).toEqual([
      {
        text: "SELECT app.purge_ended_sessions($1::timestamptz) AS deleted",
        values: ["2026-11-07T00:00:00.000Z"],
      },
    ]);
  });

  it("counts with the same call inside a transaction it always rolls back", async () => {
    const client = scripted((text) =>
      text.startsWith("SELECT") ? { rows: [{ deleted: 3 }] } : { rows: [] },
    );
    expect(await createEndedSessionsPurge(client).count(CUT)).toBe(3);
    expect(client.calls.map((c) => c.text)).toEqual([
      "BEGIN",
      "SELECT app.purge_ended_sessions($1::timestamptz) AS deleted",
      "ROLLBACK",
    ]);
  });

  it("rolls the count back when the call fails, and reports the code", async () => {
    const client = scripted((text) =>
      text.startsWith("SELECT") ? dbError("ZD422") : { rows: [] },
    );
    await expect(createEndedSessionsPurge(client).count(CUT)).rejects.toEqual(
      new ScheduledJobError("invalid_cut"),
    );
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("gives no count when the rollback fails", async () => {
    const client = scripted((text) =>
      text === "ROLLBACK"
        ? dbError("08006")
        : text === "BEGIN"
          ? { rows: [] }
          : { rows: [{ deleted: 3 }] },
    );
    await expect(createEndedSessionsPurge(client).count(CUT)).rejects.toEqual(
      new ScheduledJobError("purge_unavailable"),
    );
  });

  it.each([
    ["ZD422", dbError("ZD422"), "invalid_cut"],
    ["42501", dbError("42501"), "purge_unavailable"],
    ["a thrown string", "synthetic", "purge_unavailable"],
  ])("maps %s to a closed code without its text", async (_label, thrown, code) => {
    const client: RetentionClient = {
      query: async () => {
        throw thrown;
      },
    };
    const error = await createEndedSessionsPurge(client)
      .purge(CUT)
      .catch((e: unknown) => e);
    expect(error).toEqual(new ScheduledJobError(code));
    expect(String((error as Error).message)).not.toContain("synthetic");
  });

  it.each([
    ["no row", []],
    ["two rows", [{ deleted: 1 }, { deleted: 1 }]],
    ["a string", [{ deleted: "4" }]],
    ["a negative count", [{ deleted: -1 }]],
    ["a fraction", [{ deleted: 1.5 }]],
  ])("refuses %s as the count", async (_label, rows) => {
    const client = scripted(() => ({ rows }));
    await expect(createEndedSessionsPurge(client).purge(CUT)).rejects.toEqual(
      new ScheduledJobError("invalid_count"),
    );
  });

  it("refuses an invalid date before any query", async () => {
    const client = scripted(() => ({ rows: [{ deleted: 0 }] }));
    await expect(createEndedSessionsPurge(client).purge(new Date(Number.NaN))).rejects.toEqual(
      new ScheduledJobError("invalid_cut"),
    );
    expect(client.calls).toEqual([]);
  });
});
