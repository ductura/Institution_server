import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createActorReader, type WithActor } from "../../database/index.ts";

import { createDatabases, createLayers, createSettingsReadRoutes, startServer } from "../index.ts";

const FIXTURE = readFileSync(
  new URL("../../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);
const DATE = "2026-11-20T10:00:00.000Z";

it("serves stored values and defaults only in the scope of the live institution session", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(FIXTURE);
    await db.query(
      `INSERT INTO settings.value (level, institution_id, key, value, updated_at)
      VALUES ('institution', pg_temp.id('fak_a'), 'citation.style', '"apa"', $1),
             ('institution', pg_temp.id('fak_a'), 'lekta.profile', '"fpzg-politologija-diplomski"', $1),
             ('institution', pg_temp.id('fak_a'), 'thresholds.paste_event_chars', '250', $1)`,
      [DATE],
    );
    // Both fixture writes and reads use the rollback-only test transaction.
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(text: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(text, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: null }),
      databases: createDatabases(),
      routes: createSettingsReadRoutes({ withActor, actorReader: createActorReader(withActor) }),
    });
    const get = (letter: string) =>
      fetch(`http://127.0.0.1:${server.port}/api/v1/settings/values?level=institution`, {
        headers: { cookie: `__Host-ductus_session=${letter.repeat(43)}` },
      });
    try {
      const inherited = [
        { key: "citation.style", value: "fpzg", source: "default", bound: null },
        { key: "lekta.profile", value: "fpzg-opci-akademski-rad", source: "default", bound: null },
      ];
      for (const letter of ["A", "D"]) {
        const response = await get(letter);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          level: "institution",
          course: null,
          inherited,
          values: [
            { key: "citation.style", value: "apa", bound: null, updatedAt: DATE },
            {
              key: "lekta.profile",
              value: "fpzg-politologija-diplomski",
              bound: null,
              updatedAt: DATE,
            },
          ],
        });
      }
      const other = await get("J");
      expect(other.status).toBe(200);
      expect(await other.json()).toMatchObject({ inherited, values: [] });
      const admin = await get("C");
      expect(admin.status).toBe(200);
      expect(await admin.json()).toMatchObject({
        values: expect.arrayContaining([
          { key: "thresholds.paste_event_chars", value: 250, bound: null, updatedAt: DATE },
        ]),
      });
      expect((await get("G")).status).toBe(404);
      expect((await get("Y")).status).toBe(401);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});
