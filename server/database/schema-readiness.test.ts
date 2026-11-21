// SRV-1812: the migration state of the main database from the catalogue only
// (never the dbmate ledger, D-91 measure 6). Fake transactions; the SQL
// against a real database is in schema-readiness.pg.integration.test.ts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createSchemaReadinessReader,
  MIGRATION_LOCK_KEY,
  SCHEMA_READINESS_SQL,
} from "./schema-readiness.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

type Call = { text: string; values: readonly unknown[] | undefined };

function fake(answer: unknown[] | { thrown: unknown }): {
  withActor: WithActor;
  calls: Call[];
  tokens: unknown[];
} {
  const calls: Call[] = [];
  const tokens: unknown[] = [];
  const tx: ActorTransaction = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("set_config")) return { rows: [], rowCount: 1 };
      if ("thrown" in answer) throw answer.thrown;
      return { rows: answer as never[], rowCount: answer.length };
    },
  };
  const withActor = (async (token: unknown, fn: (t: ActorTransaction) => Promise<unknown>) => {
    tokens.push(token);
    return fn(tx);
  }) as WithActor;
  return { withActor, calls, tokens };
}

describe("createSchemaReadinessReader", () => {
  it("is pending while the migration lock is held, even with a ledger", async () => {
    const { withActor } = fake([{ ledger: true, migrating: true }]);
    await expect(createSchemaReadinessReader(withActor, 900)()).resolves.toEqual({
      migrated: false,
      reason: "migrating",
    });
  });

  it("is pending when the migrator has never run (no ledger)", async () => {
    const { withActor } = fake([{ ledger: false, migrating: false }]);
    await expect(createSchemaReadinessReader(withActor, 900)()).resolves.toEqual({
      migrated: false,
      reason: "not_migrated",
    });
  });

  it.each([
    ["no row", []],
    [
      "two rows",
      [
        { ledger: true, migrating: false },
        { ledger: true, migrating: false },
      ],
    ],
    ["a string", [{ ledger: "t", migrating: false }]],
    ["a null", [{ ledger: true, migrating: null }]],
  ])("refuses %s with a code and no value", async (_, rows) => {
    const { withActor } = fake(rows);
    await expect(createSchemaReadinessReader(withActor, 900)()).rejects.toMatchObject({
      code: "SCHEMA_READINESS_SHAPE",
      message: "schema readiness row has another shape",
    });
  });

  it("throws a database failure on unchanged", async () => {
    const failure = Object.assign(new Error("izmišljena greška"), { code: "57014" });
    const { withActor } = fake({ thrown: failure });
    await expect(createSchemaReadinessReader(withActor, 900)()).rejects.toBe(failure);
  });

  it("is migrated with a ledger and no lock, without a session and under the statement limit", async () => {
    const { withActor, calls, tokens } = fake([{ ledger: true, migrating: false }]);
    await expect(createSchemaReadinessReader(withActor, 900)()).resolves.toEqual({
      migrated: true,
    });
    expect(tokens).toEqual([null]);
    expect(calls).toEqual([
      {
        text: "SELECT pg_catalog.set_config('statement_timeout', $1, true)",
        values: ["900ms"],
      },
      { text: SCHEMA_READINESS_SQL, values: [MIGRATION_LOCK_KEY] },
    ]);
  });
});

describe("SCHEMA_READINESS_SQL", () => {
  it("reads only the catalogue, never the rows of the ledger (D-91 measure 6)", () => {
    expect(SCHEMA_READINESS_SQL).not.toMatch(/FROM\s+public\./iu);
    expect(SCHEMA_READINESS_SQL).not.toContain("to_regclass");
    for (const relation of SCHEMA_READINESS_SQL.matchAll(/\b(?:FROM|JOIN)\s+([\w.]+)/giu))
      expect(relation[1]).toMatch(/^pg_catalog\./u);
  });

  it("uses the lock key of the migration runner", () => {
    const runner = readFileSync(
      new URL("../../scripts/db/migrate-locked.ts", import.meta.url),
      "utf8",
    );
    expect(runner).toContain(`export const LOCK_KEY = "${MIGRATION_LOCK_KEY}";`);
  });
});
