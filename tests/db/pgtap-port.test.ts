import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// S-0.15 (DAN-728): the pgTAP matrix of Ductus db/tests at
// d52a92c3a108f3f0ec9c3639188a2ea669bba582 is ported verbatim to db/main/tests.
// Against the same migrated database both give Files=100, Tests=8242, PASS.
// This guards the port: no ported file disappears or is skipped, every \ir
// include resolves, and git checks out LF on every platform. Paths on disk are
// built with node:path and never compared with "/", so it runs on Windows too.
const ROOT = resolve(import.meta.dirname, "../..");
const TESTS = "db/main/tests";
const DIRECTORY = join(ROOT, ...TESTS.split("/"));

const PORTED = [
  "000-harness.sql",
  "010-roles-and-privileges.sql",
  "011-migration-ledger-access.sql",
  "012-catalogue-guards.sql",
  "020-identity-session.sql",
  "021-open-session.sql",
  "022-open-session-realm.sql",
  "023-institution-issuer.sql",
  "024-session-idle.sql",
  "024-teacher-eligibility.sql",
  "025-session-institution-change.sql",
  "026-teacher-affiliation-flag.sql",
  "027-teacher-candidates.sql",
  "030-institution-access-matrix.sql",
  "031-institution-functions.sql",
  "032-institution-assignments.sql",
  "033-institution-key.sql",
  "034-institution-assignment-idempotency.sql",
  "035-institution-assignment-word-range.sql",
  "036-institution-teacher-courses.sql",
  "037-institution-mentorship.sql",
  "038-mentorship-evidence-path.sql",
  "040-evidence-schema.sql",
  "041-evidence-immutability.sql",
  "042-evidence-descriptor-v2.sql",
  "043-evidence-acceptance-smoke.sql",
  "044-evidence-acceptance-authz.sql",
  "045-evidence-acceptance-atomicity.sql",
  "046-evidence-open-work.sql",
  "047-evidence-acceptance-signature.sql",
  "048-evidence-commit-context-state.sql",
  "049-work-document-in-assignment.sql",
  "050-collaboration-comment.sql",
  "051-collaboration-live-state.sql",
  "052-assignment-works.sql",
  "060-submission-request.sql",
  "061-submission.sql",
  "062-submission-record.sql",
  "063-submission-receipt-issuance.sql",
  "064-submission-closes-package.sql",
  "065-work-submitted.sql",
  "066-live-state-after-submission.sql",
  "067-submission-receipt.sql",
  "070-process-summary-source.sql",
  "071-process-summary-submitted-revision.sql",
  "080-audit-access-log.sql",
  "081-audit-access-log-write.sql",
  "082-audit-enrollment-code-event.sql",
  "083-audit-course-member-event.sql",
  "084-person-name.sql",
  "085-fast-path-works.sql",
  "086-assignment-submissions.sql",
  "087-submitted-read-access.sql",
  "088-evidence-segment-v3.sql",
  "089-replay-source.sql",
  "090-teacher-rosters.sql",
  "091-student-workspace.sql",
  "092-evidence-worker-signature.sql",
  "096-notification-assignment-events.sql",
  "096-notification-store.sql",
  "097-course-team-groups.sql",
  "097-institution-overview.sql",
  "098-access-can.sql",
  "099-audit-teacher-role-event.sql",
  "099-group-scope.sql",
  "100-group-scope-earlier-work.sql",
  "100-group-scope-student.sql",
  "101-team-recipients.sql",
  "102-work-grant.sql",
  "103-m2-actor-matrix.sql",
  "104-mentorship-request.sql",
  "105-faculty-rule-version.sql",
  "105-notice-fingerprint.sql",
  "106-institution-admin-appointment.sql",
  "106-pgboss-queue.sql",
  "107-worker-pending-backlog.sql",
  "108-teacher-roles.sql",
  "109-backchannel-logout.sql",
  "110-collaboration-revision-request.sql",
  "111-notice-binding.sql",
  "112-collaboration-revision-transitions.sql",
  "113-institution-courses.sql",
  "114-institution-slug.sql",
  "115-read-my-access-log.sql",
  "115-worker-receipt-object.sql",
  "116-work-language.sql",
  "117-work-accommodation.sql",
  "118-actor-scope-initplan.sql",
  "119-collaboration-revision-rereview.sql",
  "119-session-limit.sql",
  "120-assignment-purpose-catalog-version.sql",
  "121-collaboration-comment-delete.sql",
  "122-access-log-reader-roles.sql",
  "122-problem-report.sql",
  "123-course-handover.sql",
  "123-worker-package-checkpoints.sql",
  "127-work-grant-binding.sql",
  "128-interface-locale.sql",
  "128-ops-alarm.sql",
  "129-course-team-earlier-work.sql",
] as const;
const FIXTURES = [
  "evidence-acceptance.inc",
  "institution.inc",
  "mentorship.inc",
  "work-reach.inc",
] as const;

const sqlFiles = (): string[] => readdirSync(DIRECTORY).filter((name) => name.endsWith(".sql"));
const fixtureFiles = (): string[] =>
  readdirSync(join(DIRECTORY, "fixtures")).filter((name) => name.endsWith(".inc"));
const read = (name: string): string => readFileSync(join(DIRECTORY, name), "utf8");

describe("db/main/tests (pgTAP port of Ductus db/tests)", () => {
  it("keeps every ported test file and fixture", () => {
    expect(new Set(PORTED).size).toBe(100);
    const files = new Set(sqlFiles());
    expect(PORTED.filter((name) => !files.has(name))).toStrictEqual([]);
    const fixtures = new Set(fixtureFiles());
    expect(FIXTURES.filter((name) => !fixtures.has(name))).toStrictEqual([]);
  });

  it("skips nothing: every file has a plan and finish(), none uses skip or todo", () => {
    const wrong: string[] = [];
    for (const name of sqlFiles()) {
      const text = read(name);
      if (!/\bplan\(\d+\)|\bno_plan\(\)/.test(text)) wrong.push(`${name}: no plan`);
      if (!/\bfinish\(\)/.test(text)) wrong.push(`${name}: no finish()`);
      if (/\b(?:skip|todo|todo_start)\s*\(/i.test(text)) wrong.push(`${name}: skip or todo`);
    }
    expect(wrong).toStrictEqual([]);
  });

  it("resolves every \\ir include relative to the including file", () => {
    const missing: string[] = [];
    for (const name of sqlFiles()) {
      for (const match of read(name).matchAll(/^\\ir\s+(\S+)\s*$/gm)) {
        const target = join(DIRECTORY, ...match[1]!.split("/"));
        if (!existsSync(target)) missing.push(`${name}: ${match[1]}`);
      }
    }
    expect(missing).toStrictEqual([]);
  });

  it("git checks out every test and fixture with LF on every platform", () => {
    const paths = [
      ...sqlFiles().map((name) => `${TESTS}/${name}`),
      ...fixtureFiles().map((name) => `${TESTS}/fixtures/${name}`),
    ];
    const output = execFileSync("git", ["check-attr", "text", "eol", "--", ...paths], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const lines = output.trimEnd().split(/\r?\n/);
    expect(lines).toHaveLength(paths.length * 2);
    const wrong = lines.filter((line) => !/: text: set$/.test(line) && !/: eol: lf$/.test(line));
    expect(wrong).toStrictEqual([]);
  });

  it("has no carriage return in this checkout", () => {
    const withCr = [
      ...sqlFiles().map((name) => join(DIRECTORY, name)),
      ...fixtureFiles().map((name) => join(DIRECTORY, "fixtures", name)),
    ].filter((path) => readFileSync(path).includes(0x0d));
    expect(withCr).toStrictEqual([]);
  });

  it("runs from pnpm test:db, pnpm test:db:native and the CI database job", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    // compose mounts db/main/tests at /db/tests; native-db.ts runs TESTS_DIR.
    expect(pkg.scripts["test:db"]).toContain(
      "pg_prove -U ductus -d ductus --recurse --ext .sql /db/tests",
    );
    expect(readFileSync(join(ROOT, "compose.yaml"), "utf8")).toContain(
      "- ./db/main/tests:/db/tests:ro",
    );
    expect(pkg.scripts["test:db:native"]).toBe("node scripts/db/native-db.ts test");
    expect(readFileSync(join(ROOT, "scripts", "db", "native-db.ts"), "utf8")).toContain(
      `export const TESTS_DIR = "${TESTS}";`,
    );
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const database = ci.slice(ci.indexOf("\n  database:\n"), ci.indexOf("\n  ci-ok:\n"));
    // In the existing database job, after the native main database is up.
    const up = database.lastIndexOf('PATH="$PGBIN:$PATH" pnpm db:up:native');
    const matrix = database.indexOf('run: PATH="$PGBIN:$PATH" pnpm test:db:native');
    expect(up).toBeGreaterThan(0);
    expect(matrix).toBeGreaterThan(up);
    // The environment smoke test runs before the migrations, so the old
    // db/**/tests glob would pull the matrix in on an empty database.
    expect(database).not.toContain("db/**/tests");
    expect(database).toContain("files=(db/tests/*.sql)");
  });
});
