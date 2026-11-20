import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createMyAccessLogReader, type WithActor } from "../../database/index.ts";
import {
  createDatabases,
  createLayers,
  createProcessSummaryDetailsRouteFor,
  startServer,
  type Running,
} from "../../http/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", FIXTURES), "utf8");
const evidence = readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
  /^\\ir institution\.inc\r?\n/mu,
  "",
);
const ORIGIN = "https://ductura.example.invalid";

it("enforces the course relationship and records only the allowed teacher opening in PostgreSQL", async () => {
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
      routes: [
        createProcessSummaryDetailsRouteFor(
          { withActor },
          {
            payloads: {
              readImmutable: async () => {
                throw new Error("empty package");
              },
            },
          },
          {},
        ),
      ],
    });
    const url = `http://127.0.0.1:${server.port}/api/v1/process-summary/details`;
    const post = (actor: string, documentId = "doc-a") =>
      fetch(url, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          cookie: `__Host-ductus_session=${actor.repeat(43)}`,
        },
        body: JSON.stringify({ documentId }),
      });
    const owner = await post("D");
    const teacher = await post("A");
    expect([owner.status, teacher.status]).toEqual([200, 200]);
    expect(await teacher.text()).toBe(await owner.text());
    for (const response of [
      await post("B"),
      await post("C"),
      await post("E"),
      await post("I"),
      await post("A", "demo-missing"),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "not_found" });
    }
    const log = await createMyAccessLogReader(withActor).read("D".repeat(43), "doc-a");
    expect(log.ok && log.value.entries.map(({ surface }) => surface)).toEqual(["process_summary"]);
  } finally {
    await server?.close();
    await db.close();
  }
});
