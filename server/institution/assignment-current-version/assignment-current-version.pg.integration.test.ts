import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";

import { readAssignmentCurrentVersion } from "./index.ts";

const FIXTURE = readFileSync(
  new URL("../../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);
const ASSIGNMENT_ID = "00000000-0000-4000-8000-0000000000a1";
const MISSING_ID = "00000000-0000-4000-8000-00000000dead";

it("reads the current version only as a teacher of the assignment under PostgreSQL RLS", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(FIXTURE);
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
    const teacher = "A".repeat(43);
    const otherTeacher = "B".repeat(43);
    const student = "D".repeat(43);
    expect(await readAssignmentCurrentVersion(withActor, teacher, ASSIGNMENT_ID)).toEqual({
      kind: "found",
      body: {
        assignmentId: ASSIGNMENT_ID,
        courseId: "00000000-0000-4000-8000-0000000000c1",
        versionNo: 2,
        isPractice: false,
        externalToolsAllowed: false,
        aiSummaryOnly: false,
        title: "Z1",
        instructions: "Upute za izmišljeni zadatak.",
        workType: "essay",
        opensAt: expect.any(String),
        dueAt: expect.any(String),
        aiPolicy: "partially_allowed",
        aiPurposes: ["proofreading"],
        evidenceProfile: "extended",
        importAllowed: true,
        wordMin: null,
        wordMax: null,
      },
    });
    // The creation flags are fixed once set (assignment_setup_immutable), so
    // the fixture row is switched with the guard off, as the owner of the table.
    await db.exec(`
      ALTER TABLE institution.assignment DISABLE TRIGGER assignment_setup_immutable;
      UPDATE institution.assignment SET external_tools_allowed = true, ai_summary_only = true
       WHERE id = '${ASSIGNMENT_ID}';
      ALTER TABLE institution.assignment ENABLE TRIGGER assignment_setup_immutable;
    `);
    expect(await readAssignmentCurrentVersion(withActor, teacher, ASSIGNMENT_ID)).toMatchObject({
      kind: "found",
      body: { externalToolsAllowed: true, aiSummaryOnly: true },
    });
    for (const [token, id] of [
      [otherTeacher, ASSIGNMENT_ID],
      [student, ASSIGNMENT_ID],
      [teacher, MISSING_ID],
    ] as const) {
      expect(await readAssignmentCurrentVersion(withActor, token, id)).toEqual({
        kind: "not_found",
      });
    }
    expect(await readAssignmentCurrentVersion(withActor, "Z".repeat(43), ASSIGNMENT_ID)).toEqual({
      kind: "unauthorized",
    });
  } finally {
    await db.close();
  }
});
