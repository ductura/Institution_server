import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

// M2.12-P01b: the migration that binds assignment versions to a faculty rule
// version runs over assignments and rules that already exist. pgTAP sees only
// the finished schema; here a database of its own is migrated up to the one
// before, given rules, versions and assignments, and then the up section runs
// in one transaction, as dbmate runs it. A rule without a version, or one
// that differs from its latest version, becomes the next version of the
// operator; every existing assignment version names the latest version of its
// institution and kind, or none; the down section drops the column. Rows are
// written as the compose superuser; every identifier is random and invented.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
requireLoopbackDatabaseUrl(ADMIN_URL, "The migration test runs only against a loopback database.");
const MIGRATIONS = fileURLToPath(new URL("../../db/main/migrations/", import.meta.url));
const TARGET = "20261220620000_assignment_faculty_rule_version.sql";

function section(file: string, which: "up" | "down") {
  const text = readFileSync(`${MIGRATIONS}${file}`, "utf8");
  const up = text.indexOf("-- migrate:up");
  const down = text.indexOf("-- migrate:down");
  if (up < 0 || down < 0) throw new Error(`${file} is not a dbmate migration`);
  return which === "up" ? text.slice(0, down) : text.slice(down);
}

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
const name = `ductus_rulebind_${randomBytes(6).toString("hex")}`;
const clients: pg.Client[] = [];

// The migrator connects with the role as a connection option, as dbmate does,
// so the RESET ROLE of a migration returns to it.
async function connect(options?: string): Promise<pg.Client> {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.href, options });
  await client.connect();
  clients.push(client);
  return client;
}

async function run(client: pg.Client, sql: string) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

afterAll(async () => {
  for (const client of clients) await client.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

describe("the assignment rule binding migration over data from before it", () => {
  it("binds every existing version to the latest rule version and its down section drops the column", async () => {
    await admin.query(`CREATE DATABASE ${name} OWNER ductus_migrator`);
    const migrator = await connect("-c role=ductus_migrator");
    const db = await connect();
    const earlier = readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith(".sql") && file < TARGET)
      .sort();
    for (const file of earlier) await run(migrator, section(file, "up"));

    const institution = randomUUID();
    const teacher = randomUUID();
    const course = randomUUID();
    const works = {
      essay: randomUUID(),
      master: randomUUID(),
      seminar: randomUUID(),
      bachelor: randomUUID(),
    };
    await db.query("BEGIN");
    await db.query("SET CONSTRAINTS ALL DEFERRED");
    await db.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
      institution,
      `it-${institution.slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, 'https://issuer.invalid', $3, $4)`,
      [teacher, institution, `sub-${teacher}`, `nastavnik-${teacher.slice(0, 8)}@fakultet.invalid`],
    );
    await db.query(
      `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_at)
       VALUES ($1, $2, 'teacher', now())`,
      [institution, teacher],
    );
    await db.query(
      `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
       VALUES ($1, $2, 'Izmišljeni kolegij', '2026/2027', 'partially_allowed', $3)`,
      [course, institution, teacher],
    );
    await db.query(
      `INSERT INTO institution.course_member (course_id, institution_id, user_id, role) VALUES ($1, $2, $3, 'teacher')`,
      [course, institution, teacher],
    );
    // Essay: two versions, the projection is the second. Master thesis: a
    // rule with no version. Bachelor thesis: the projection differs from its
    // only version. Seminar paper: no rule at all.
    await db.query(
      `INSERT INTO institution.faculty_rule_version
         (institution_id, work_type, version_no, ai_policy, ai_purposes, evidence_profile, import_allowed, origin)
       VALUES ($1, 'essay', 1, 'encouraged', '{}', 'extended', true, 'operator'),
              ($1, 'essay', 2, 'partially_allowed', ARRAY['proofreading'], 'basic', false, 'operator'),
              ($1, 'bachelor_thesis', 1, 'prohibited', '{}', 'basic', false, 'operator')`,
      [institution],
    );
    await db.query(
      `INSERT INTO institution.faculty_work_rule
         (institution_id, work_type, ai_policy, ai_purposes, evidence_profile, import_allowed)
       VALUES ($1, 'essay', 'partially_allowed', ARRAY['proofreading'], 'basic', false),
              ($1, 'master_thesis', 'partially_allowed', ARRAY['literature_search'], 'extended', false),
              ($1, 'bachelor_thesis', 'partially_allowed', ARRAY['proofreading'], 'basic', false)`,
      [institution],
    );
    await db.query(
      `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
       VALUES ($1, $5, $6, 2, $7), ($2, $5, $6, 1, $7), ($3, $5, $6, 1, $7), ($4, $5, $6, 1, $7)`,
      [works.essay, works.master, works.seminar, works.bachelor, course, institution, teacher],
    );
    await db.query(
      `INSERT INTO institution.assignment_version
         (assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
          evidence_profile, import_allowed, created_by)
       SELECT v.assignment_id, v.version_no, 'Izmišljeni zadatak', 'Upute.', v.work_type, now(),
              now() + interval '30 days', 'prohibited', '{}', 'basic', false, $5
       FROM (VALUES ($1::uuid, 1, 'essay'), ($1::uuid, 2, 'essay'), ($2::uuid, 1, 'master_thesis'),
                    ($3::uuid, 1, 'seminar_paper'), ($4::uuid, 1, 'bachelor_thesis'))
            AS v (assignment_id, version_no, work_type)`,
      [works.essay, works.master, works.seminar, works.bachelor, teacher],
    );
    await db.query("COMMIT");

    await run(migrator, section(TARGET, "up"));

    const chain = await db.query<{ work_type: string; version_no: number; ai_purposes: string[] }>(
      `SELECT work_type, version_no, ai_purposes FROM institution.faculty_rule_version
       WHERE origin = 'operator' AND published_by IS NULL ORDER BY work_type, version_no`,
    );
    expect(chain.rows).toStrictEqual([
      { work_type: "bachelor_thesis", version_no: 1, ai_purposes: [] },
      { work_type: "bachelor_thesis", version_no: 2, ai_purposes: ["proofreading"] },
      { work_type: "essay", version_no: 1, ai_purposes: [] },
      { work_type: "essay", version_no: 2, ai_purposes: ["proofreading"] },
      { work_type: "master_thesis", version_no: 1, ai_purposes: ["literature_search"] },
    ]);

    const bound = async () =>
      (
        await db.query<{ assignment_id: string; version_no: number; rule: number | null }>(
          `SELECT assignment_id::text, version_no, faculty_rule_version AS rule
           FROM institution.assignment_version WHERE institution_id = $1 ORDER BY assignment_id, version_no`,
          [institution],
        )
      ).rows;
    const expected = [
      { assignment_id: works.essay, version_no: 1, rule: 2 },
      { assignment_id: works.essay, version_no: 2, rule: 2 },
      { assignment_id: works.master, version_no: 1, rule: 1 },
      { assignment_id: works.seminar, version_no: 1, rule: null },
      { assignment_id: works.bachelor, version_no: 1, rule: 2 },
    ].sort((a, b) =>
      a.assignment_id === b.assignment_id
        ? a.version_no - b.version_no
        : a.assignment_id.localeCompare(b.assignment_id),
    );
    expect(await bound()).toStrictEqual(expected);

    // A version written after the migration takes the binding of the one
    // before it, whatever it names.
    await db.query(
      `INSERT INTO institution.assignment_version
         (assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy, ai_purposes,
          evidence_profile, import_allowed, faculty_rule_version, created_by)
       VALUES ($1, 3, 'Izmišljeni zadatak', 'Upute.', 'essay', now(), now() + interval '30 days',
               'prohibited', '{}', 'basic', false, 1, $2)`,
      [works.essay, teacher],
    );
    const third = await db.query<{ rule: number }>(
      `SELECT faculty_rule_version AS rule FROM institution.assignment_version
       WHERE assignment_id = $1 AND version_no = 3`,
      [works.essay],
    );
    expect(third.rows).toStrictEqual([{ rule: 2 }]);

    await run(migrator, section(TARGET, "down"));
    const left = await db.query<{ hasColumn: boolean; link: boolean; readsProjection: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_attribute
                       WHERE attrelid = 'institution.assignment_version'::regclass
                         AND attname = 'faculty_rule_version' AND NOT attisdropped) AS "hasColumn",
              EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'link_assignment_rule_version') AS link,
              (SELECT prosrc LIKE '%faculty_work_rule%' FROM pg_proc
                WHERE oid = 'institution.check_mentorship_version()'::regprocedure) AS "readsProjection"`,
    );
    expect(left.rows[0]).toStrictEqual({ hasColumn: false, link: false, readsProjection: true });
  });
});
