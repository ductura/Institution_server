// ISTR-7: the routes the Schemathesis probe may call, and the guards that keep
// a run to exactly those routes (scripts/schemathesis/README.md).

/** The Schemathesis release the probe was written against; run.ts refuses another. */
export const SCHEMATHESIS_VERSION = "4.34.2";

/**
 * GET routes a signed-in demo student may read without writing anything
 * beyond the session itself. Each was checked against its handler and SQL
 * function. Left out on purpose:
 * - /api/v1/notifications: its first page may materialize a deadline reminder;
 * - /api/v1/me/self-note-key: issues key material;
 * - auth/*, downloads/*, exports and every route with a path parameter.
 * A route that writes is added only with a separate stack for the probe.
 */
export const STUDENT_READS: readonly string[] = Object.freeze([
  "/api/v1/health",
  "/api/v1/ready",
  "/api/v1/status",
  "/api/v1/me",
  "/api/v1/profile/interface-locale",
  "/api/v1/analysis/catalogue",
  "/api/v1/settings/catalogue",
  "/api/v1/settings/values",
  "/api/v1/student/works",
  "/api/v1/student/assignments",
  "/api/v1/student/assignment-work",
  "/api/v1/student/assignment-submissions",
  "/api/v1/student/mentorships",
  "/api/v1/student/mentorship-requests",
  "/api/v1/student/mentor-candidates",
  "/api/v1/student/mentored-assignments",
  "/api/v1/notifications/returned-for-revision",
  "/api/v1/notifications/mentorship-opened",
]);

type Spec = { readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>> };

/** Why `paths` cannot be probed against `spec`; empty when every path is a GET of the spec without path parameters. */
export function allowlistProblems(spec: Spec, paths: readonly string[]): string[] {
  const problems: string[] = [];
  if (paths.length === 0) problems.push("the allowlist is empty");
  if (new Set(paths).size !== paths.length) problems.push("the allowlist repeats a route");
  for (const path of paths) {
    if (!path.startsWith("/api/v1/")) problems.push(`${path}: not under /api/v1/`);
    if (path.includes("{")) problems.push(`${path}: has a path parameter`);
    const operations = spec.paths?.[path];
    if (operations === undefined) problems.push(`${path}: not in the spec`);
    else if (operations["get"] === undefined) problems.push(`${path}: no GET in the spec`);
  }
  return problems;
}
