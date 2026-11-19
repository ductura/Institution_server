// Student routes of the dev fake server: own courses and assignments, the
// state of own works and who opened them (PRODUCT §5 rule 17). Only the
// caller's own memberships and works are ever read.
import type { Handlers } from "./server.ts";
import type { Account, Assignment, State } from "./state.ts";

/** Assignments of the courses the account is a student in. */
export function studentAssignments(state: State, account: Account): Assignment[] {
  const courses = new Set(
    state.courses.filter((c) => c.studentIds.includes(account.id)).map((c) => c.id),
  );
  return state.assignments.filter((a) => courses.has(a.courseId));
}

export const STUDENT_HANDLERS: Handlers = {
  "student.assignments.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const own = studentAssignments(state, account);
    const courses = state.courses
      .filter((c) => c.studentIds.includes(account.id))
      .sort((a, b) => a.name.localeCompare(b.name, "hr") || a.id.localeCompare(b.id))
      .map((course) => ({
        id: course.id,
        name: course.name,
        assignments: own
          .filter((a) => a.courseId === course.id)
          .sort(
            (a, b) => a.content.dueAt.localeCompare(b.content.dueAt) || a.id.localeCompare(b.id),
          )
          .map((a) => ({
            id: a.id,
            title: a.content.title,
            dueAt: a.content.dueAt,
            noticeFirst: a.acknowledged.get(account.id)?.version !== a.version,
          })),
      }));
    return { status: 200, body: { courses } };
  },
  "student.assignment-work.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const assignments = studentAssignments(state, account)
      .map((a) => {
        const work = state.works.find((w) => w.assignmentId === a.id && w.studentId === account.id);
        const workState =
          work === undefined
            ? "not_started"
            : work.state === "submitted"
              ? "submitted"
              : "in_progress";
        return { assignmentId: a.id, workState } as const;
      })
      .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
    return { status: 200, body: { assignments } };
  },
  "student.access-log.get": ({ state, account, params, query }) => {
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (account === null || work === undefined || work.studentId !== account.id)
      return { error: "not_found" };
    const beforeAt = typeof query?.beforeAt === "string" ? query.beforeAt : null;
    const beforeId = typeof query?.beforeId === "string" ? query.beforeId : null;
    const continued = beforeAt !== null && beforeId !== null && !Number.isNaN(Date.parse(beforeAt));
    const entries = state.accessLog
      .filter((e) => e.documentId === work.documentId && (!continued || e.at < (beforeAt ?? "")))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .map((e) => {
        const reader = state.accounts.find((a) => a.id === e.readerId);
        return {
          id: e.id,
          at: e.at,
          role: e.role,
          surface: e.surface,
          reader:
            reader === undefined
              ? null
              : { givenName: reader.givenName, familyName: reader.familyName },
        };
      });
    return { status: 200, body: { entries, next: null, continued } };
  },
};
