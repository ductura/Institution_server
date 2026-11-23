// The administrator's import of a course's students in the dev fake server
// (SRV-ADMIN-2, NF-7 OA-10): a preview that enrols nobody, then a
// confirmation that enrols the preview's new rows once. The file is read by
// the server's own parser; the accounts are matched by an invented AAI@EduHr
// identifier per account key, in the form of the local stack
// (demo-student@demo.ductus.test). Only the administrator of the one
// institution, as the real RPCs. Every person and identifier is invented.
import { randomUUID } from "node:crypto";

import { parseRosterCsv } from "../../../server/institution/index.ts";

import type { Operations } from "../../contracts/index.ts";

import type { Handlers } from "./server.ts";
import type { Account, AccountKey, State } from "./state.ts";

/** The invented identifier of each account of the fake. */
export const FAKE_AAI_IDENTIFIERS: Readonly<Record<AccountKey, string>> = {
  student: "demo-student@demo.ductus.test",
  "student-2": "demo-student-2@demo.ductus.test",
  nastavnik: "demo-teacher@demo.ductus.test",
  "nastavnik-2": "demo-teacher-2@demo.ductus.test",
  administrator: "demo-admin@demo.ductus.test",
  "bez-uloge": "demo-bez-uloge@demo.ductus.test",
};
const VALID_FOR_MS = 30 * 60 * 1000;

type RosterImport = {
  readonly courseId: string;
  readonly expiresAt: Date;
  readonly userIds: readonly string[];
  result: { enrolled: number; alreadyEnrolled: number; skipped: number } | null;
};
const imports = new WeakMap<State, Map<string, RosterImport>>();
const importsOf = (state: State) => {
  let found = imports.get(state);
  if (found === undefined) imports.set(state, (found = new Map()));
  return found;
};
const isAdmin = (account: Account | null): account is Account =>
  account?.roles.includes("institution_admin") ?? false;
type PreviewRow = Operations["institution.roster-imports.post"]["success"]["body"]["rows"][number];
const key = (name: string) => name.trim().replace(/\s+/gu, " ").toLowerCase();

/** For tests: an unconfirmed import of these accounts, valid until expiresAt. */
export function plantRosterImport(
  state: State,
  importId: string,
  courseId: string,
  userIds: readonly string[],
  expiresAt: Date,
): void {
  importsOf(state).set(importId, { courseId, expiresAt, userIds, result: null });
}

export const ROSTER_IMPORT_HANDLERS: Handlers = {
  "institution.roster-imports.post": ({ state, account, params, body, now }) => {
    if (!isAdmin(account)) return { error: "forbidden" };
    const course = state.courses.find((c) => c.id === params.courseId.toLowerCase());
    if (course === undefined) return { error: "not_found" };
    const parsed = parseRosterCsv(body.csv);
    if (!parsed.ok) return { error: parsed.error };
    const userIds: string[] = [];
    const rows = parsed.rows.map((row): PreviewRow => {
      const cells = {
        line: row.line,
        identifier: row.identifier,
        givenName: row.givenName,
        familyName: row.familyName,
      };
      if (row.problem !== null) {
        return { ...cells, status: "unsuitable" as const, reason: row.problem };
      }
      const found = state.accounts.find((a) => FAKE_AAI_IDENTIFIERS[a.key] === row.identifier);
      const reason =
        found === undefined
          ? "unknown_account"
          : found.id === course.holderId ||
              course.groups.some((g) => g.teacherIds.includes(found.id))
            ? "course_teacher"
            : course.studentIds.includes(found.id)
              ? null
              : course.removed.includes(found.id)
                ? "removed"
                : key(found.givenName) !== key(row.givenName) ||
                    key(found.familyName) !== key(row.familyName)
                  ? "name_mismatch"
                  : null;
      if (found !== undefined && reason === null && !course.studentIds.includes(found.id)) {
        userIds.push(found.id);
        return { ...cells, status: "new" as const, reason: null };
      }
      if (reason === null) return { ...cells, status: "already_enrolled" as const, reason: null };
      return { ...cells, status: "unsuitable" as const, reason };
    });
    const importId = randomUUID();
    const expiresAt = new Date(now.getTime() + VALID_FOR_MS);
    importsOf(state).set(importId, { courseId: course.id, expiresAt, userIds, result: null });
    const count = (status: string) => rows.filter((row) => row.status === status).length;
    return {
      status: 200,
      body: {
        importId,
        source: body.source,
        expiresAt: expiresAt.toISOString(),
        counts: {
          new: count("new"),
          alreadyEnrolled: count("already_enrolled"),
          unsuitable: count("unsuitable"),
        },
        rows,
      },
    };
  },
  "institution.roster-import-confirm.post": ({ state, account, params, now }) => {
    if (!isAdmin(account)) return { error: "forbidden" };
    const found = importsOf(state).get(params.importId.toLowerCase());
    if (found === undefined) return { error: "not_found" };
    if (found.result !== null)
      return { status: 200, body: { ...found.result, alreadyConfirmed: true } };
    if (now >= found.expiresAt) return { error: "import_expired" };
    const course = state.courses.find((c) => c.id === found.courseId)!;
    const result = { enrolled: 0, alreadyEnrolled: 0, skipped: 0 };
    for (const id of found.userIds) {
      if (course.studentIds.includes(id)) result.alreadyEnrolled += 1;
      else if (course.removed.includes(id)) result.skipped += 1;
      else {
        course.studentIds.push(id);
        result.enrolled += 1;
      }
    }
    found.result = result;
    return { status: 200, body: { ...result, alreadyConfirmed: false } };
  },
};
