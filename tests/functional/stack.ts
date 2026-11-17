// S-1H.3 (DAN-1003): the running VS-1 stack (scripts/stack) as the functional
// tests see it, so S-1H.2 can reuse it. Local stack and CI only (D-09). Every
// person, course and text is invented; session tokens are random.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  commandLine,
  INSTITUTION_SLUG,
  listensOn,
  readState,
  sha256File,
  type StackState,
} from "../../scripts/stack/index.ts";

/** A course of demo-fakultet with its own teacher and one open assignment. */
export type Course = { readonly id: string; readonly assignmentId: string };
/** An invented student of demo-fakultet with a live session. */
export type Student = { readonly id: string; readonly token: string };

/**
 * The stack in `stackDir`, once its server is the recorded process, listens
 * on the server port and runs the dist/server.js of `root`, with the line
 * that names the revision.
 */
export function runningStack(stackDir: string, root: string): { state: StackState; run: string } {
  const state = readState(join(stackDir, "state.json"));
  if (state === null || state === "unreadable") throw new Error("the stack is not up");
  const server = state.processes.server;
  if (
    server === undefined ||
    commandLine(server.pid) !== server.marker ||
    !listensOn(server.pid, state.ports.server)
  ) {
    throw new Error("the stack's server port is not served by the recorded process");
  }
  const build = sha256File(join(root, "dist", "server.js"));
  if (build !== state.serverBuildSha256) throw new Error("dist/server.js is not the running build");
  const { sha, dirty } = state.repos.server;
  return { state, run: `ductura/server ${sha}${dirty ? " (dirty)" : ""}, dist/server.js ${build}` };
}

/** A course whose teacher is invented with it, and its one assignment, open for 30 days. */
export function seedCourse(stackDir: string, port: number): Course {
  const ids = { teacher: randomUUID(), course: randomUUID(), assignment: randomUUID() };
  psql(
    stackDir,
    port,
    { ...ids, tag: randomBytes(4).toString("hex") },
    `
SELECT id AS inst FROM identity.institution WHERE slug = :'slug' \\gset
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
VALUES (:'teacher', :'inst', 'https://issuer.test', 'sub-teacher-' || :'tag', 'teacher-' || :'tag' || '@fak.invalid');
INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
VALUES (:'course', :'inst', 'Kolegij (test)', '2026/2027', 'partially_allowed', :'teacher');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (:'course', :'inst', :'teacher', 'teacher');
INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
VALUES (:'assignment', :'course', :'inst', 1, :'teacher');
INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
  opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
VALUES (:'assignment', 1, 'Zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', now(),
  now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, :'teacher');
`,
  );
  return { id: ids.course, assignmentId: ids.assignment };
}

/** A student with a session as a sign-in leaves it, a member of every course in `courses`. */
export function seedStudent(stackDir: string, port: number, courses: readonly Course[]): Student {
  const student = { id: randomUUID(), token: randomBytes(32).toString("base64url") };
  psql(
    stackDir,
    port,
    { ...student, tag: randomBytes(4).toString("hex") },
    `
SELECT id AS inst FROM identity.institution WHERE slug = :'slug' \\gset
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
VALUES (:'id', :'inst', 'https://issuer.test', 'sub-student-' || :'tag', 'student-' || :'tag' || '@fak.invalid');
INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
VALUES (sha256(convert_to(:'token', 'UTF8')), :'id', :'inst', now() + interval '1 hour');
`,
  );
  for (const course of courses) {
    psql(
      stackDir,
      port,
      { student: student.id, course: course.id },
      `
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
SELECT :'course', id, :'student', 'student' FROM identity.institution WHERE slug = :'slug';
`,
    );
    acknowledgeNotice(stackDir, port, student, course);
  }
  return student;
}

/**
 * `student` acknowledges the notice of the assignment of `course`; for a
 * course not theirs, membership is then the only thing they lack.
 */
export function acknowledgeNotice(
  stackDir: string,
  port: number,
  student: Student,
  course: Course,
): void {
  psql(
    stackDir,
    port,
    { student: student.id, assignment: course.assignmentId },
    `
INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
SELECT :'assignment', 1, :'student', id FROM identity.institution WHERE slug = :'slug';
`,
  );
}

/**
 * One transaction as the cluster's `ductus` over the stack's own socket.
 * Values are psql variables and reach it through stdin, never argv: a session
 * token is a live secret.
 */
function psql(socket: string, port: number, vars: Record<string, string>, sql: string): void {
  const sets = Object.entries({ slug: INSTITUTION_SLUG, ...vars })
    .map(([name, value]) => `\\set ${name} '${value}'`)
    .join("\n");
  execFileSync(
    "psql",
    ["-h", socket, "-p", String(port), "-U", "ductus", "-d", "ductus", "-X", "-q"],
    {
      input: `${sets}\n\\set ON_ERROR_STOP on\nBEGIN;${sql}COMMIT;\n`,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "ignore", "inherit"],
    },
  );
}
