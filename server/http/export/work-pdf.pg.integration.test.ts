import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createLiveStates, type WithActor } from "../../database/index.ts";

import { readPdfSource } from "./read-source.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const WRONG_ASSIGNMENT = "00000000-0000-4000-8000-0000000000a2";
const DOC = "doc-a";
const OWNER = "D".repeat(43);
const COURSE_TEACHER = "A".repeat(43);
const MENTOR = "B".repeat(43);
const BODY =
  '{"nodes":[{"children":[{"marks":[],"text":"Izmišljeni tekst rada.","type":"text"}],"id":"00000000-0000-4000-8000-000000000001","type":"paragraph"}],"schemaVersion":1}';

it("binds export to the real document owner or current mentor through the database", async () => {
  const db = await createTestDatabase("main", { authority: true });
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
    expect(await createLiveStates(withActor).publish(OWNER, DOC, null, BODY)).toMatchObject({
      status: "accepted",
    });
    const read = readPdfSource(withActor);
    expect(await read(OWNER, ASSIGNMENT, DOC)).toMatchObject({
      status: "found",
      kind: "saved",
      body: BODY,
    });
    for (const token of [COURSE_TEACHER, MENTOR, "E".repeat(43), "I".repeat(43)]) {
      expect(await read(token, ASSIGNMENT, DOC)).toEqual({ status: "not_found" });
    }
    expect(await read(OWNER, WRONG_ASSIGNMENT, DOC)).toEqual({ status: "not_found" });
    expect(await read("Z".repeat(43), ASSIGNMENT, DOC)).toEqual({ status: "unauthorized" });

    await db.exec(`SET LOCAL ROLE ductus_identity;
      INSERT INTO institution.mentorship (id, institution_id, mentor_id, student_id, work_type)
      VALUES ('00000000-0000-4000-8000-0000000000aa', pg_temp.id('fak_a'), pg_temp.id('marko'), pg_temp.id('ana'), 'bachelor_thesis');
      UPDATE institution.assignment SET course_id = NULL, mentorship_id = '00000000-0000-4000-8000-0000000000aa'
      WHERE id = pg_temp.id('z1');
      RESET ROLE;`);
    expect(await read(MENTOR, ASSIGNMENT, DOC)).toEqual(await read(OWNER, ASSIGNMENT, DOC));
    expect(await read(MENTOR, ASSIGNMENT, DOC)).toMatchObject({ status: "found", body: BODY });
    expect(await read(MENTOR, ASSIGNMENT, "doc-b")).toEqual({ status: "not_found" });
    await db.exec(
      "SET LOCAL ROLE ductus_identity; UPDATE institution.mentorship SET ended_at = now(); RESET ROLE;",
    );
    expect(await read(MENTOR, ASSIGNMENT, DOC)).toEqual({ status: "not_found" });
  } finally {
    await db.close();
  }
});
