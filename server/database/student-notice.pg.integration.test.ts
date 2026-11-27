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
const GROUP = "00000000-0000-4000-8000-0000000000e1";
const notFound = { ok: false, error: STUDENT_NOTICE_NOT_FOUND };

// A recorded name of a fixture person, written as the owner would.
async function nameOf(db: TestDatabase, who: string, given: string, family: string) {
  await db.query(
    `INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
     SELECT p.id, p.institution_id, $2::text, $3::text FROM person p WHERE p.name = $1`,
    [who, given, family],
  );
}

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
      // F4-STU-R11-SRV: a first version has no previous one.
      expect(mentored.ok && mentored.value.previousVersion).toBeNull();
      // Boris, student of ms3: zm3, not acknowledged.
      expect(await reader.read(TOKEN.boris, ZM3)).toMatchObject({
        ok: true,
        value: { assignmentId: ZM3, acknowledgedAt: null },
      });
      // The course path is unchanged: Ana reads z1 of K1 at its current version 2.
      // F4-STU-R11-SRV: the student also reads version 1 as previousVersion.
      expect(await reader.read(TOKEN.ana, Z1)).toMatchObject({
        ok: true,
        value: {
          assignmentId: Z1,
          versionNo: 2,
          previousVersion: { versionNo: 1, aiPurposes: ["formatting", "proofreading"] },
        },
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

  it("names the course and the mentor, null where there is none (F4-STU-R08-SRV)", () =>
    withFixtures(async (db) => {
      const reader = createStudentNoticeReader(actorOver(db));
      // Ana in K1 has no seminar group, so no mentor of the course.
      expect(await reader.read(TOKEN.ana, Z1)).toMatchObject({
        ok: true,
        value: { courseName: "K1", mentorName: null },
      });
      // A mentored work has no course; Marko has no recorded name yet.
      expect(await reader.read(TOKEN.ana, ZM1)).toMatchObject({
        ok: true,
        value: { courseName: null, mentorName: null },
      });
      // Written as the owner would; the names are invented.
      await nameOf(db, "marko", "Izmišljeni", "Mentor");
      await nameOf(db, "nina", "Izmišljena", "Nepotvrđena");
      expect(await reader.read(TOKEN.ana, ZM1)).toMatchObject({
        ok: true,
        value: { courseName: null, mentorName: "Izmišljeni Mentor" },
      });
      // Nina has a recorded name, but her teacher role is not confirmed: the
      // name comes only through the student's own readers, so Boris reads zm3
      // without a mentor.
      expect(await reader.read(TOKEN.boris, ZM3)).toMatchObject({
        ok: true,
        value: { courseName: null, mentorName: null },
      });
      // A student of neither keeps the same 404, names or not (C-23).
      expect(await reader.read(TOKEN.dora, ZM1)).toEqual(notFound);
      expect(await reader.read(TOKEN.tomo, Z1)).toEqual(notFound);
    }));

  it("joins the teachers of the student's group sorted by name, confirmed ones only (F4-STU-R08-SRV)", () =>
    withFixtures(async (db) => {
      const reader = createStudentNoticeReader(actorOver(db));
      // Ana's group in K1 has Vesna, Marko and Nina as teachers. By id Vesna
      // comes first; by name she comes last. Nina's role is not confirmed.
      await nameOf(db, "vesna", "Zrinka", "Izmišljena");
      await nameOf(db, "marko", "Bruno", "Izmišljeni");
      await nameOf(db, "nina", "Ema", "Izmišljena");
      await db.query(
        `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
         SELECT pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id(n), 'teacher'
           FROM unnest(ARRAY['marko', 'nina']) AS n`,
      );
      await db.query(
        `INSERT INTO institution.seminar_group (id, course_id, institution_id, name, created_by)
         VALUES ($1, pg_temp.id('k1'), pg_temp.id('fak_a'), 'Grupa A', pg_temp.id('vesna'))`,
        [GROUP],
      );
      await db.query(
        `INSERT INTO institution.seminar_group_member (group_id, course_id, institution_id, user_id, assigned_by)
         VALUES ($1, pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('ana'), pg_temp.id('vesna'))`,
        [GROUP],
      );
      await db.query(
        `INSERT INTO institution.seminar_group_teacher (group_id, course_id, institution_id, user_id, assigned_by)
         SELECT $1, pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id(n), pg_temp.id('vesna')
           FROM unnest(ARRAY['vesna', 'marko', 'nina']) AS n`,
        [GROUP],
      );
      expect(await reader.read(TOKEN.ana, Z1)).toMatchObject({
        ok: true,
        value: { courseName: "K1", mentorName: "Bruno Izmišljeni, Zrinka Izmišljena" },
      });
      // Dora is in K1 but not in the group: no mentor for her.
      expect(await reader.read(TOKEN.dora, Z1)).toMatchObject({
        ok: true,
        value: { courseName: "K1", mentorName: null },
      });
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
