// SRV-1706 (plan M10.4, PRODUCT §5 rule 17, C-23, D-274 MQ10): work.access.get
// over the migrated main database, the contract and the handler together.
// A teacher's read of Ana's work shows to Ana as one row of five minutes in a
// Zagreb day; the teacher, another student and an unknown work read 404.
// Every person, work and text is invented (db/main/tests/fixtures).
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { workAccessGet } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import {
  createDatabases,
  createLayers,
  createWorkAccessRouteFor,
  startServer,
  type Running,
} from "../index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", FIXTURES), "utf8");
const evidence = readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
  /^\\ir institution\.inc\r?\n/mu,
  "",
);
const ORIGIN = "https://ductura.example.invalid";
// Session tokens of institution.inc: one letter per person, by id.
const VESNA = "A";
const ANA = "D";
const DORA = "E";

it("shows the owner who opened the work, and nobody else the log", async () => {
  const db = await createTestDatabase("main", { authority: true });
  let server: Running | undefined;
  try {
    await db.exec(institution);
    await db.exec(evidence);
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
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [createWorkAccessRouteFor({ withActor })],
    });
    const get = (actor: string | null, documentId = "doc-a", site = "same-origin") =>
      fetch(`http://127.0.0.1:${server!.port}/api/v1/works/${documentId}/access`, {
        headers: {
          "sec-fetch-site": site,
          ...(actor === null ? {} : { cookie: `__Host-ductus_session=${actor.repeat(43)}` }),
        },
      });

    const empty = await get(ANA);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ days: [], next: null, continued: false });

    // Vesna, teacher of K1, opens the summary of Ana's work twice in one window.
    for (let i = 0; i < 2; i += 1) {
      const { rows } = await db.query<{ v: string }>("SELECT pg_temp.ask('vesna', $1) AS v", [
        "SELECT outcome FROM app.read_process_summary_source('doc-a')",
      ]);
      expect(rows[0]?.v).not.toMatch(/^ZD/);
    }

    const owner = await get(ANA);
    expect(owner.status).toBe(200);
    const body = (await owner.json()) as {
      days: { date: string; entries: Record<string, unknown>[] }[];
    };
    expect(Value.Check(workAccessGet.responses[0]!.body!, body)).toBe(true);
    expect(body.days).toHaveLength(1);
    expect(Object.keys(body.days[0]!).sort()).toEqual(["date", "entries"]);
    expect(body.days[0]!.entries).toHaveLength(1);
    expect(body.days[0]!.entries[0]).toMatchObject({
      role: "teacher",
      surface: "process_summary",
      // institution.inc gives Vesna no name pair, so no stand-in either.
      reader: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/count|total|duration|visits/i);

    for (const response of [await get(VESNA), await get(DORA), await get(ANA, "doc-nepostojeci")]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "not_found" });
    }
    expect((await get(null)).status).toBe(401);
    expect((await get(ANA, "doc-a", "cross-site")).status).toBe(403);
  } finally {
    await server?.close();
    await db.close();
  }
});
