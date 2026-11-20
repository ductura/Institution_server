import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";

import type { WithActor } from "../index.ts";
import { readSettingsValues } from "./index.ts";

const FIXTURE = readFileSync(
  new URL("../../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);

it("reads only the settings level and institution that the live session can manage", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(FIXTURE);
    await db.exec(`INSERT INTO settings.value (level, institution_id, key, value, updated_at)
      VALUES ('institution', pg_temp.id('fak_a'), 'citation.style', '"apa"', '2026-11-20T10:00:00Z'),
             ('institution', pg_temp.id('fak_b'), 'citation.style', '"chicago"', '2026-11-20T10:00:00Z')`);
    // Use the production RPC as ductus_app in the fixture's rollback-only transaction.
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(sql: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(sql, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const institution = (letter: string) =>
      readSettingsValues(withActor, letter.repeat(43), "institution", null);
    for (const [letter, value] of [
      ["C", "apa"],
      ["H", "chicago"],
    ]) {
      expect(await institution(letter!)).toMatchObject({
        status: 200,
        body: {
          values: [
            { key: "citation.style", value, bound: null, updatedAt: "2026-11-20T10:00:00.000Z" },
          ],
        },
      });
    }
    expect(await institution("D")).toEqual({ status: 404 });
    expect(await institution("Y")).toEqual({ status: 401 });
    expect(
      await readSettingsValues(
        withActor,
        "C".repeat(43),
        "course",
        "00000000-0000-4000-8000-0000000000c3",
      ),
    ).toEqual({ status: 404 });
  } finally {
    await db.close();
  }
});
