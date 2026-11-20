import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import type { WithActor } from "../database/index.ts";

import { createStudentNotes } from "./student-notes-route.ts";

const INSTITUTION_FIXTURE = new URL(
  "../../db/main/tests/fixtures/institution.inc",
  import.meta.url,
);
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const FOREIGN_ASSIGNMENT = "00000000-0000-4000-8000-0000000000a3";
const ANA = "D".repeat(43);
const DORA = "E".repeat(43);
const TEXT = "🌱".repeat(600);

it("appends a note and rereads it only as its author", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(INSTITUTION_FIXTURE, "utf8"));
    const withActor: WithActor = async (token, run) => {
      // Isolate each call while keeping all fixture data in the rollback-only test transaction.
      await db.exec("SAVEPOINT note_call");
      try {
        await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
        await db.exec("SET LOCAL ROLE ductus_app");
        const result = await run({
          async query<Row>(text: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(text, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
        await db.exec("RESET ROLE; RELEASE SAVEPOINT note_call");
        return result;
      } catch (error) {
        await db.exec("ROLLBACK TO SAVEPOINT note_call; RELEASE SAVEPOINT note_call");
        throw error;
      }
    };
    const notes = createStudentNotes(withActor);
    expect(await notes.read(ANA, ASSIGNMENT)).toEqual({ status: "read", notes: [] });
    const added = await notes.add(ANA, { assignmentId: ASSIGNMENT, text: TEXT });
    expect(added).toMatchObject({ status: "added", note: { text: TEXT } });
    if (added.status !== "added") throw new Error("the fixture note was not added");

    expect(await notes.add(ANA, { assignmentId: ASSIGNMENT, text: `${TEXT}a` })).toEqual({
      status: "invalid_input",
    });
    expect(await notes.read(ANA, FOREIGN_ASSIGNMENT)).toEqual({ status: "not_found" });
    expect(await notes.add(ANA, { assignmentId: FOREIGN_ASSIGNMENT, text: TEXT })).toEqual({
      status: "not_found",
    });
    expect(await notes.read(DORA, ASSIGNMENT)).toEqual({ status: "read", notes: [] });
    expect(await notes.read(ANA, ASSIGNMENT)).toEqual({ status: "read", notes: [added.note] });
  } finally {
    await db.close();
  }
});
