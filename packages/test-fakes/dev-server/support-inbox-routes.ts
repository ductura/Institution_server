// SRV-ADMIN-1 (NF-7 OA-7, OA-3) in the dev fake: the problem reports routed by
// kind, their state, and the administrator's log of actions. The fake has no
// network engineer account, so the administrator stands in for the operator
// (as for the pilot numbers in ops-routes.ts) and also receives the technical
// reports; a teacher of a course receives the reports about it; a student or
// an account without a role gets 403. No answer names who sent a report. All
// values are invented.
import { teachesCourse, type Account, type FakeProblemReport, type State } from "./state.ts";
import type { Handlers } from "./server.ts";

type RoutedTo = "network_engineer" | "course_teacher" | "institution_admin";

const REFERENCE = /^PR-[0-9A-F]{10}$/u;

function isReader(account: Account): boolean {
  return account.roles.includes("institution_admin") || account.roles.includes("teacher");
}

function routedTo(state: State, account: Account, report: FakeProblemReport): RoutedTo | null {
  const admin = account.roles.includes("institution_admin");
  if (report.category === "technical") return admin ? "network_engineer" : null;
  if (report.category === "account") return admin ? "institution_admin" : null;
  if (report.courseId === null) return admin ? "institution_admin" : null;
  const course = state.courses.find((c) => c.id === report.courseId);
  return course !== undefined && teachesCourse(course, account) ? "course_teacher" : null;
}

export const SUPPORT_INBOX_HANDLERS: Handlers = {
  "support.problem-reports.get": ({ state, account, header, query }) => {
    const site = header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return { error: "forbidden" };
    if (account === null) return { error: "unauthorized" };
    if (!isReader(account)) return { error: "forbidden" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    const reports = [...state.problemReports].reverse().flatMap((report) => {
      const to = routedTo(state, account, report);
      if (to === null) return [];
      // Field by field: the reporter never leaves the fake.
      return [
        {
          reference: report.reference,
          category: report.category,
          routedTo: to,
          courseId: report.courseId,
          description: report.description,
          route: report.route,
          appVersion: report.appVersion,
          browser: { ...report.browser },
          syncState: report.syncState,
          createdAt: report.createdAt,
          status: report.status,
          statusChangedAt: report.statusChangedAt,
          statusChangedByRole: report.statusChangedByRole,
          statusChangedByMe: report.statusChangedById === account.id,
        },
      ];
    });
    return {
      status: 200,
      body: { reports: reports.slice(0, 500), truncated: reports.length > 500 },
    };
  },
  "support.problem-report-status.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isReader(account)) return { error: "forbidden" };
    if (!REFERENCE.test(params.reference)) return { error: "invalid_input" };
    const report = state.problemReports.find((r) => r.reference === params.reference);
    const to = report === undefined ? null : routedTo(state, account, report);
    if (report === undefined || to === null) return { error: "not_found" };
    if (report.status !== body.status) {
      report.status = body.status;
      report.statusChangedAt = now.toISOString();
      report.statusChangedByRole = to;
      report.statusChangedById = account.id;
    }
    return {
      status: 200,
      body: {
        reference: report.reference,
        status: report.status,
        statusChangedAt: report.statusChangedAt,
      },
    };
  },
  "institution.admin-actions.get": ({ state, account, header, query }) => {
    const site = header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return { error: "forbidden" };
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    const entries = [...state.adminActions].reverse().map((entry) => ({ ...entry }));
    return {
      status: 200,
      body: { entries: entries.slice(0, 500), truncated: entries.length > 500 },
    };
  },
};
