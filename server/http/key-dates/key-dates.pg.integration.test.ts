import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";

import { readKeyDates } from "./read.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const MENTORSHIP = "00000000-0000-4000-8000-0000000000d1";
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000b1";
const MILESTONE = "00000000-0000-4000-8000-000000001701";
const SLOT = "00000000-0000-4000-8000-000000001702";

it("reads the same dates for the mentor and student through the live database roles", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    for (const fixture of ["institution.inc", "mentorship.inc"]) {
      await db.exec(readFileSync(new URL(fixture, FIXTURES), "utf8"));
    }
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
    const read = (actor: string, id = MENTORSHIP) => readKeyDates(withActor, actor.repeat(43), id);
    const initial = await read("D");
    expect(initial).toEqual(await read("B"));
    expect(initial).toMatchObject({
      status: "ok",
      body: { dates: [{ kind: "deadline", id: ASSIGNMENT }] },
    });

    await db.exec(`SET LOCAL ROLE ductus_evidence;
      INSERT INTO evidence.domain (id, institution_id, region)
      VALUES (gen_random_uuid(), pg_temp.id('fak_a'), 'eu-central-1');
      RESET ROLE;`);
    const opened = await db.query<{ id: string }>(`
      SELECT pg_temp.ask('ana', $$ SELECT document_id FROM app.open_student_work({zm1}, true) $$) AS id`);
    const documentId = opened.rows[0]?.id;
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/u);
    await db.query(
      `INSERT INTO institution.work_milestone (id, institution_id, assignment_id, position, title, due_at)
        VALUES ($1, pg_temp.id('fak_a'), pg_temp.id('zm1'), 1, 'Izmišljena etapa', now() + interval '20 days'),
               (gen_random_uuid(), pg_temp.id('fak_a'), pg_temp.id('zm1'), 2, 'Etapa bez datuma', NULL)`,
      [MILESTONE],
    );
    await db.query(
      `INSERT INTO institution.work_milestone_deadline (institution_id, document_id, milestone_id, due_at)
        VALUES (pg_temp.id('fak_a'), $1, $2, now() + interval '15 days')`,
      [documentId, MILESTONE],
    );
    await db.query(
      `INSERT INTO institution.consultation_slot (id, institution_id, document_id, assignment_id, student_id, starts_at, state)
        VALUES ($1, pg_temp.id('fak_a'), $2, pg_temp.id('zm1'), pg_temp.id('ana'), now() + interval '10 days', 'confirmed')`,
      [SLOT, documentId],
    );
    const extended = await db.query<{ due: string; common: string; milestone: Date; slot: Date }>(`
      SELECT pg_temp.ask('marko', $$ SELECT due_at FROM institution.extend_assignment_deadline(
                  {zm1}, {ana}, now() + interval '420 days', 'justified') $$) AS due,
             pg_temp.ask('marko', $$ SELECT due_at FROM institution.extend_assignment_deadline(
                  {zm1}, NULL, now() + interval '400 days', 'all') $$) AS common,
             now() + interval '15 days' AS milestone,
             now() + interval '10 days' AS slot`);
    const [expected] = extended.rows;
    if (expected === undefined) throw new Error("missing dates fixture");
    expect(Date.parse(expected.due)).toBeGreaterThan(Date.parse(expected.common));
    const dates = {
      status: "ok",
      body: {
        dates: [
          { kind: "consultation", id: SLOT, at: expected.slot.toISOString(), state: "confirmed" },
          {
            kind: "milestone",
            id: MILESTONE,
            at: expected.milestone.toISOString(),
            title: "Izmišljena etapa",
          },
          { kind: "deadline", id: ASSIGNMENT, at: new Date(expected.due).toISOString() },
        ],
      },
    };
    expect(await read("B")).toEqual(dates);
    expect(await read("D")).toEqual(dates);
    for (const actor of ["A", "C", "E", "I"]) {
      expect(await read(actor)).toEqual({ status: "not_found" });
    }
    expect(await read("D", "00000000-0000-4000-8000-00000000dead")).toEqual({
      status: "not_found",
    });
    expect(await read("E", "00000000-0000-4000-8000-0000000000d2")).toEqual({
      status: "not_found",
    });
    expect(await read("G", "00000000-0000-4000-8000-0000000000d3")).toEqual({
      status: "not_found",
    });
    expect(await read("X")).toEqual({ status: "unauthorized" });

    await db.exec(
      `UPDATE institution.mentorship SET ended_at = now() WHERE id = pg_temp.id('ms1')`,
    );
    expect(await read("B")).toEqual({ status: "not_found" });
    expect(await read("D")).toEqual({ status: "not_found" });
  } finally {
    await db.close();
  }
});
