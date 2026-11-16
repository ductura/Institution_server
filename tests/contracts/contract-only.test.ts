// "Ugovoreno, nije implementirano" (DAN-803, Ductus#1836 c.6905207008 t. 0.1):
// a route in CONTRACT_ONLY has a contract that clients build against on the
// fake server, and no handler on this server. A handler mounted for it while
// it is still listed fails here, so the list cannot claim a route is unserved
// when it is served. A cross-area test (docs/server-map.md §2), as
// tests/contracts/evidence-domain.test.ts; outside server/http on purpose.
import { describe, expect, it } from "vitest";

import { CONTRACT_ONLY, ROUTES } from "../../server/contracts/index.ts";
import { AREA_NAMES, routesOf } from "../../server/http/index.ts";

// The operations of DAN-803 (c.6905207008, tables of PR1 to PR6), frozen: the
// task may add only these to CONTRACT_ONLY, and each of them that has a
// contract and no handler must be there. After the task the list only shrinks.
// (`submission.submit.post`: the table's `submission.post` has no name part,
// which checkRoute refuses.)
export const DAN_803: readonly string[] = [
  "student.assignments.get",
  "support.problem-report.post",
  ...["live.document.get", "live.document.put", "collaboration.comments.post"],
  ...["collaboration.revision-requests.post", "projection.process-summary.post"],
  ...["institution.enrollments.post", "institution.acknowledgment.post"],
  ...["institution.work-language.post", "institution.student-work-language.post"],
  "institution.work-work-language.post",
  ...["teacher.courses.get", "teacher.submissions.get", "teacher.mentorships.get"],
  ...["teacher.mentorship.get", "teacher.fast-path.post", "institution.courses.post"],
  ...["institution.course-assignments.post", "institution.enrollment-code.post"],
  ...["institution.enrollment-code-revocation.post", "institution.student-removal.post"],
  ...["institution.student-return.post", "institution.assignment-versions.post"],
  ...["institution.role-confirmation.post", "institution.role-revocation.post"],
  "submission.submit.post",
];

// The operations of DAN-806 (settings, Ductus#1836 c.6906291102), frozen the
// same way: contract now, handlers in S-1J-g.
export const DAN_806: readonly string[] = [
  "settings.catalogue.get",
  "settings.values.get",
  "settings.values.put",
];

/** Every route a task has put on the list; nothing else may be there. */
const FROZEN: readonly string[] = [...DAN_803, ...DAN_806];

const mounted = (): string[] => routesOf(AREA_NAMES).map((route) => route.contract.id);

/** Every problem of a CONTRACT_ONLY list against the routes and the mounted ids. */
export function contractOnlyProblems(
  list: readonly string[],
  routeIds: readonly string[],
  mountedIds: readonly string[],
): string[] {
  const problems: string[] = [];
  if (new Set(list).size !== list.length) problems.push("duplicate id");
  for (const id of list) {
    if (!FROZEN.includes(id)) problems.push(`${id}: not a contract-only route of a task`);
    if (!routeIds.includes(id)) problems.push(`${id}: no contract`);
    if (mountedIds.includes(id)) problems.push(`${id}: mounted`);
  }
  for (const id of FROZEN)
    if (routeIds.includes(id) && !mountedIds.includes(id) && !list.includes(id))
      problems.push(`${id}: contract without a handler, not in CONTRACT_ONLY`);
  return problems;
}

describe("CONTRACT_ONLY", () => {
  const ids = ROUTES.map((route) => route.id);

  it("is exactly the DAN-803 and DAN-806 routes with a contract and no handler", () => {
    expect(new Set(DAN_803).size).toBe(27);
    expect(new Set(DAN_806).size).toBe(3);
    expect(DAN_806.filter((id) => DAN_803.includes(id))).toEqual([]);
    expect(contractOnlyProblems(CONTRACT_ONLY, ids, mounted())).toEqual([]);
  });

  // Fixed inputs, not the live ROUTES, so these stay true as DAN-803 adds routes.
  const routeIds = ["auth.login.get", "student.assignments.get", "teacher.courses.get"];

  it("refuses a route outside both tasks, a route without contract, a duplicate and a mounted one", () => {
    expect(
      contractOnlyProblems(
        ["teacher.courses.get", "auth.login.get", "live.document.get", "teacher.courses.get"],
        routeIds,
        ["teacher.courses.get", "student.assignments.get"],
      ),
    ).toEqual([
      "duplicate id",
      "teacher.courses.get: mounted",
      "auth.login.get: not a contract-only route of a task",
      "live.document.get: no contract",
      "teacher.courses.get: mounted",
    ]);
  });

  it("refuses a DAN-803 or DAN-806 contract left out of the list", () => {
    expect(contractOnlyProblems([], [...routeIds, "settings.values.put"], [])).toEqual([
      "student.assignments.get: contract without a handler, not in CONTRACT_ONLY",
      "teacher.courses.get: contract without a handler, not in CONTRACT_ONLY",
      "settings.values.put: contract without a handler, not in CONTRACT_ONLY",
    ]);
    expect(
      contractOnlyProblems(["student.assignments.get", "teacher.courses.get"], routeIds, []),
    ).toEqual([]);
    const withoutSettings = CONTRACT_ONLY.filter((id) => !DAN_806.includes(id));
    expect(contractOnlyProblems(withoutSettings, ids, [])).toEqual(
      DAN_806.map((id) => `${id}: contract without a handler, not in CONTRACT_ONLY`),
    );
  });

  it("refuses a DAN-806 route that is mounted", () => {
    expect(contractOnlyProblems(CONTRACT_ONLY, ids, ["settings.values.put"])).toEqual([
      "settings.values.put: mounted",
    ]);
  });
});
