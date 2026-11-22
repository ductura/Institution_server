// SRV-1315 over the real functions: the student who owns the work adds, the
// teacher of its course reads and cannot add (403), another student and
// another institution read a missing work (404), and the process summary
// source of the work is the same before and after a record is added.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";

import { createEventDisputeRoutesFor } from "./index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
const DOCUMENT = "doc-a";
const STUDENT = "D".repeat(43);
const TEACHER = "A".repeat(43);
const OTHER_STUDENT = "E".repeat(43);
const OTHER_TENANT = "I".repeat(43);
const BODY = { kind: "dispute", eventId: "pastes/0", text: "Lijepljenje je iz mojih bilješki." };

it("the student adds, the teacher reads and cannot add, and the summary source is unchanged", async () => {
  const db = await createTestDatabase("main", { authority: true });
  let close: (() => Promise<void>) | undefined;
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    await db.exec(
      readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
        /^\\ir institution\.inc\r?\n/mu,
        "",
      ),
    );
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(sql: string, args?: readonly unknown[]) {
            const { rows } = await db.query<Row>(sql, [...(args ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const running = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: createEventDisputeRoutesFor({ withActor }),
    });
    close = () => running.close();
    const url = (work: string) =>
      `http://127.0.0.1:${running.port}/api/v1/works/${work}/event-disputes`;
    const get = (token: string, work = DOCUMENT) =>
      fetch(url(work), { headers: { cookie: `__Host-ductus_session=${token}` } });
    const post = (token: string, work = DOCUMENT, body: unknown = BODY) =>
      fetch(url(work), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          cookie: `__Host-ductus_session=${token}`,
        },
        body: JSON.stringify(body),
      });
    const summarySource = () =>
      withActor(TEACHER, async (tx) => {
        const { rows } = await tx.query<Record<string, unknown>>(
          "SELECT outcome, institution_id, evidence_package_id, segment_hashes FROM app.read_process_summary_source($1)",
          [DOCUMENT],
        );
        return JSON.stringify(rows);
      });

    const before = await summarySource();
    expect(await (await get(STUDENT)).json()).toEqual({ disputes: [] });

    const added = await post(STUDENT);
    expect(added.status).toBe(201);
    const created = (await added.json()) as { disputeId: string; createdAt: string };
    expect(Object.keys(created).sort()).toEqual(["createdAt", "disputeId"]);

    const [asStudent, asTeacher] = await Promise.all([get(STUDENT), get(TEACHER)]);
    expect(asTeacher.status).toBe(200);
    const list = await asStudent.json();
    expect(await asTeacher.json()).toEqual(list);
    expect(list).toEqual({
      disputes: [{ ...BODY, disputeId: created.disputeId, createdAt: created.createdAt }],
    });

    // The teacher reads but does not write; another's work is a missing one.
    expect((await post(TEACHER)).status).toBe(403);
    for (const token of [OTHER_STUDENT, OTHER_TENANT]) {
      expect((await get(token)).status).toBe(404);
      expect((await post(token)).status).toBe(404);
    }
    expect((await get(STUDENT, "doc-nema")).status).toBe(404);
    expect((await post(STUDENT, "doc-nema")).status).toBe(404);
    expect((await post(STUDENT, DOCUMENT, { ...BODY, kind: "note" })).status).toBe(422);
    expect(((await (await get(TEACHER)).json()) as { disputes: unknown[] }).disputes).toHaveLength(
      1,
    );

    expect(await summarySource()).toBe(before);
  } finally {
    await close?.();
    await db.close();
  }
});
