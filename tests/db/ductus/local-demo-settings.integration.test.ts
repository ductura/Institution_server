import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";

import { runLocalSql } from "./local-psql.ts";
import { expect, it } from "vitest";

import { createWithActor } from "../../../server/database/with-actor.ts";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_URL =
  process.env.APP_DATABASE_URL ??
  "postgres://ductus_app_local:ductus-app-local-only@127.0.0.1:54329/ductus";
const DEMO_SLUG = "demo-fakultet";
const OTHER_SLUG = "demo-bez-prijave";
const seed = readFileSync(new URL("../../../db/main/local/seed.sql", import.meta.url), "utf8");

function runSeed() {
  runLocalSql(ADMIN_URL, seed);
}

type Settings = {
  institution_id: string;
  display_name: string;
  enrollment_attempt_limit: number;
  enrollment_attempt_window: string;
  updated_at: Date;
};

it("seeds only the local demo settings and preserves configuration and enrollment state on rerun", async () => {
  runSeed();
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  const app = new pg.Pool({ connectionString: APP_URL });
  const withActor = createWithActor(app);
  const suffix = randomBytes(5).toString("hex");
  const users = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const tokens = users.map(() => randomBytes(32).toString("base64url"));
  let demoId = "";
  let otherId = "";
  let courseId = "";
  let original: Settings | undefined;
  try {
    // CI runs local:prepare first. Remove only this synthetic row to model a
    // freshly migrated stack, then restore its original value in finally.
    const institutions = await admin.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM identity.institution WHERE slug = ANY($1)",
      [[DEMO_SLUG, OTHER_SLUG]],
    );
    demoId = institutions.rows.find((row) => row.slug === DEMO_SLUG)?.id ?? "";
    otherId = institutions.rows.find((row) => row.slug === OTHER_SLUG)?.id ?? "";
    expect(demoId).toBeTruthy();
    expect(otherId).toBeTruthy();
    const existing = await admin.query<Settings>(
      "SELECT institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window::text, updated_at FROM institution.institution_settings WHERE institution_id = $1",
      [demoId],
    );
    original = existing.rows[0];
    await admin.query("DELETE FROM institution.institution_settings WHERE institution_id = $1", [
      demoId,
    ]);
    expect(
      (
        await admin.query(
          "SELECT 1 FROM institution.institution_settings WHERE institution_id = $1",
          [demoId],
        )
      ).rowCount,
    ).toBe(0);

    runSeed();
    const seeded = await admin.query<Settings>(
      "SELECT institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window::text, updated_at FROM institution.institution_settings WHERE institution_id = $1",
      [demoId],
    );
    expect(seeded.rows).toHaveLength(1);
    expect(seeded.rows[0]!.display_name).toBe("Demo fakultet (test)");
    expect(seeded.rows[0]!.enrollment_attempt_limit).toBe(5);
    expect(seeded.rows[0]!.enrollment_attempt_window).toBe("00:15:00");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM institution.institution_settings WHERE institution_id = $1",
          [otherId],
        )
      ).rows[0].n,
    ).toBe(0);

    for (let i = 0; i < users.length; i += 1) {
      await admin.query(
        `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          users[i],
          i === 4 ? otherId : demoId,
          `https://issuer-${suffix}.test`,
          `student-${i}`,
          `student-${i}@seed-${suffix}.test`,
        ],
      );
      await admin.query(
        `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
         VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
        [tokens[i], users[i], i === 4 ? otherId : demoId],
      );
    }
    // DAN-525: the administrator only through the operator procedure, on an invented request.
    await admin.query("SELECT institution.appoint_institution_admin($1, $2)", [
      users[0],
      `Zahtjev ${suffix}/2026`,
    ]);
    // DAN-304: the teacher right of the last login, as that login writes it.
    await admin.query(
      "INSERT INTO identity.teacher_eligibility (user_id, institution_id) VALUES ($1, $2)",
      [users[1], demoId],
    );
    await withActor(tokens[0], (tx) =>
      tx.query("SELECT institution.confirm_teacher_role($1)", [users[1]]),
    );
    courseId = await withActor(
      tokens[1],
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            "SELECT institution.create_course('Sinteticki kolegij', '2026/2027', 'prohibited') AS id",
          )
        ).rows[0]!.id,
    );
    const code = await withActor(
      tokens[1],
      async (tx) =>
        (
          await tx.query<{ code: string }>(
            "SELECT institution.create_enrollment_code($1, now() + interval '1 day') AS code",
            [courseId],
          )
        ).rows[0]!.code,
    );
    const wrong = await withActor(
      tokens[3],
      async (tx) =>
        (
          await tx.query<{ outcome: string }>(
            "SELECT outcome FROM institution.enroll_with_code('WRONGCODE')",
          )
        ).rows[0]!.outcome,
    );
    expect(wrong).toBe("refused");
    const attempt = (
      await admin.query<{ id: string }>(
        "SELECT id FROM institution.enrollment_attempt WHERE user_id = $1",
        [users[3]],
      )
    ).rows[0]!.id;

    await admin.query(
      `UPDATE institution.institution_settings SET display_name = 'Prilagodeni demo (test)',
         enrollment_attempt_limit = 7, enrollment_attempt_window = '20 minutes' WHERE institution_id = $1`,
      [demoId],
    );
    runSeed();
    const preserved = await admin.query<Settings>(
      "SELECT institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window::text, updated_at FROM institution.institution_settings WHERE institution_id = $1",
      [demoId],
    );
    expect(preserved.rows).toHaveLength(1);
    expect(preserved.rows[0]!.display_name).toBe("Prilagodeni demo (test)");
    expect(preserved.rows[0]!.enrollment_attempt_limit).toBe(7);
    expect(preserved.rows[0]!.enrollment_attempt_window).toBe("00:20:00");
    expect(
      (
        await admin.query("SELECT id FROM institution.enrollment_attempt WHERE user_id = $1", [
          users[3],
        ])
      ).rows[0].id,
    ).toBe(attempt);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM identity.user_account WHERE id = ANY($1)",
          [users],
        )
      ).rows[0].n,
    ).toBe(5);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM identity.session WHERE user_id = ANY($1)",
          [users],
        )
      ).rows[0].n,
    ).toBe(5);

    const enrolled = await withActor(
      tokens[2],
      async (tx) =>
        (
          await tx.query<{ outcome: string; enrolled_course_id: string }>(
            "SELECT outcome, enrolled_course_id FROM institution.enroll_with_code($1)",
            [code],
          )
        ).rows[0],
    );
    expect(enrolled).toEqual({ outcome: "enrolled", enrolled_course_id: courseId });
    await expect(
      withActor(tokens[4], (tx) =>
        tx.query("SELECT outcome FROM institution.enroll_with_code($1)", [code]),
      ),
    ).rejects.toMatchObject({ code: "ZD503" });
    runSeed();
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM institution.course_member WHERE course_id = $1 AND user_id = $2",
          [courseId, users[2]],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM institution.enrollment_attempt WHERE id = $1",
          [attempt],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM institution.institution_settings WHERE institution_id = $1",
          [demoId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM institution.institution_settings WHERE institution_id = $1",
          [otherId],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    if (courseId) {
      await admin.query("DELETE FROM institution.course_member WHERE course_id = $1", [courseId]);
      await admin.query("DELETE FROM institution.course_enrollment_code WHERE course_id = $1", [
        courseId,
      ]);
      await admin.query("DELETE FROM institution.course WHERE id = $1", [courseId]);
    }
    await admin.query("DELETE FROM institution.enrollment_attempt WHERE user_id = ANY($1)", [
      users,
    ]);
    // DAN-497: the confirmation above left an append-only audit row; only a replica session removes it.
    const cleaner = await admin.connect();
    try {
      await cleaner.query("BEGIN");
      await cleaner.query("SET LOCAL session_replication_role = replica");
      await cleaner.query("DELETE FROM audit.teacher_role_event WHERE teacher_id = ANY($1)", [
        users,
      ]);
      await cleaner.query("COMMIT");
    } finally {
      cleaner.release();
    }
    await admin.query("DELETE FROM institution.institution_role WHERE user_id = ANY($1)", [users]);
    await admin.query("DELETE FROM identity.session WHERE user_id = ANY($1)", [users]);
    await admin.query("DELETE FROM identity.teacher_eligibility WHERE user_id = ANY($1)", [users]);
    await admin.query("DELETE FROM identity.user_account WHERE id = ANY($1)", [users]);
    if (demoId) {
      await admin.query("DELETE FROM institution.institution_settings WHERE institution_id = $1", [
        demoId,
      ]);
      if (original) {
        await admin.query(
          `INSERT INTO institution.institution_settings
           (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window, updated_at)
           VALUES ($1, $2, $3, $4::interval, $5)`,
          [
            demoId,
            original.display_name,
            original.enrollment_attempt_limit,
            original.enrollment_attempt_window,
            original.updated_at,
          ],
        );
      }
    }
    await app.end();
    await admin.end();
  }
});
