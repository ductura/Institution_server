// SRV-MENTOR-NOTICE (Ductus#2055, INT-30 M3d0) over real PostgreSQL with RLS
// as ductus_app: the student reads the notice of an assignment they reach
// through a course or through their open mentorship, and nobody else does.
// A student of neither the course nor the mentorship, a student of an ended
// mentorship, the mentor and a student of another faculty all read NOT_FOUND
// alike (C-23). Fixtures db/main/tests/fixtures/institution.inc and
// mentorship.inc; every person, work and text in them is invented.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test-support/database/index.ts";

import { createStudentNoticeReader, STUDENT_NOTICE_NOT_FOUND } from "./student-notice.ts";
import type { WithActor } from "./with-actor.ts";

const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", FIXTURES), "utf8");
const mentorship = readFileSync(new URL("mentorship.inc", FIXTURES), "utf8");

// Tokens of institution.inc: one letter per person, in the order of their ids.
const TOKEN = {
  vesna: "A".repeat(43),
  marko: "B".repeat(43),
  ana: "D".repeat(43),
  dora: "E".repeat(43),
  boris: "F".repeat(43),
  tomo: "J".repeat(43),
};
const Z1 = "00000000-0000-4000-8000-0000000000a1";
const ZM1 = "00000000-0000-4000-8000-0000000000b1";
const ZM2 = "00000000-0000-4000-8000-0000000000b2";
const ZM3 = "00000000-0000-4000-8000-0000000000b3";
const notFound = { ok: false, error: STUDENT_NOTICE_NOT_FOUND };

// Fixture writes and reads share the rollback-only test transaction.
function actorOver(db: TestDatabase): WithActor {
  return async (token, run) => {
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
}

async function withFixtures(test: (db: TestDatabase) => Promise<void>): Promise<void> {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(institution);
    await db.exec(mentorship);
    await test(db);
  } finally {
    await db.close();
  }
}

describe("student.notice.get over PostgreSQL", () => {
  it("opens the notice by course or by open mentorship, and to nobody else", () =>
    withFixtures(async (db) => {
      const reader = createStudentNoticeReader(actorOver(db));

      // Ana, student of Marko's open mentorship ms1: zm1 at version 1, acknowledged.
      const mentored = await reader.read(TOKEN.ana, ZM1);
      expect(mentored).toMatchObject({
        ok: true,
        value: {
          assignmentId: ZM1,
          versionNo: 1,
          title: "ZM1",
          workType: "master_thesis",
          aiPolicy: "partially_allowed",
          aiPurposes: ["proofreading"],
          evidenceProfile: "extended",
          readAt: null,
        },
      });
      expect(mentored.ok && typeof mentored.value.acknowledgedAt).toBe("string");
      // Boris, student of ms3: zm3, not acknowledged.
      expect(await reader.read(TOKEN.boris, ZM3)).toMatchObject({
        ok: true,
        value: { assignmentId: ZM3, acknowledgedAt: null },
      });
      // The course path is unchanged: Ana reads z1 of K1 at its current version 2.
      expect(await reader.read(TOKEN.ana, Z1)).toMatchObject({
        ok: true,
        value: { assignmentId: Z1, versionNo: 2 },
      });

      // Dora: student of K1, but not of ms1; her own mentorship ms2 has ended.
      expect(await reader.read(TOKEN.dora, ZM1)).toEqual(notFound);
      expect(await reader.read(TOKEN.dora, ZM2)).toEqual(notFound);
      // Boris is in no course: z1 stays closed though he has a mentorship.
      expect(await reader.read(TOKEN.boris, Z1)).toEqual(notFound);
      expect(await reader.read(TOKEN.boris, ZM1)).toEqual(notFound);
      // The mentor and a course teacher are no students of the work.
      expect(await reader.read(TOKEN.marko, ZM1)).toEqual(notFound);
      expect(await reader.read(TOKEN.vesna, Z1)).toEqual(notFound);
      // Another faculty.
      expect(await reader.read(TOKEN.tomo, ZM1)).toEqual(notFound);
    }));

  it("readAt of a mentorship's notice is the caller's own", () =>
    withFixtures(async (db) => {
      const reader = createStudentNoticeReader(actorOver(db));
      // Written as the owner would; Dora's row is not Ana's (and Dora still cannot read zm1).
      await db.query(
        `INSERT INTO institution.notice_read (assignment_id, student_id, institution_id)
         SELECT a.id, p.id, a.institution_id FROM institution.assignment a JOIN person p ON p.name = 'dora'
          WHERE a.id = $1::uuid`,
        [ZM1],
      );
      expect(await reader.read(TOKEN.ana, ZM1)).toMatchObject({
        ok: true,
        value: { readAt: null },
      });
      expect(await reader.read(TOKEN.dora, ZM1)).toEqual(notFound);
      await db.query(
        `INSERT INTO institution.notice_read (assignment_id, student_id, institution_id)
         SELECT a.id, p.id, a.institution_id FROM institution.assignment a JOIN person p ON p.name = 'ana'
          WHERE a.id = $1::uuid`,
        [ZM1],
      );
      const read = await reader.read(TOKEN.ana, ZM1);
      expect(read.ok && typeof read.value.readAt).toBe("string");
    }));
});
