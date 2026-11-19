// Institution routes of the dev fake server: courses, enrolment codes,
// enrolment, the notice acknowledgment, assignment versions, teacher roles and
// work language. Access comes from relations in the state (teacher of the
// course, student in it), never from a role alone (C-23).
import { randomBytes, randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import {
  teachesCourse,
  type Account,
  type AssignmentContent,
  type Assignment,
  type Course,
  type State,
} from "./state.ts";

/** Refused guesses after which enrolment answers too_many_attempts. */
export const MAX_ENROLLMENT_GUESSES = 5;

function taughtCourse(state: State, account: Account | null, courseId: string): Course | null {
  const course = state.courses.find((c) => c.id === courseId);
  return course !== undefined && account !== null && teachesCourse(course, account.id)
    ? course
    : null;
}

function taughtAssignment(state: State, account: Account | null, id: string): Assignment | null {
  const assignment = state.assignments.find((a) => a.id === id);
  if (assignment === undefined) return null;
  return taughtCourse(state, account, assignment.courseId) === null ? null : assignment;
}

const isAdmin = (account: Account | null): boolean =>
  account?.roles.includes("institution_admin") ?? false;

function newCode(): string {
  const hex = randomBytes(8).toString("hex").toUpperCase();
  return hex.match(/.{4}/g)?.join("-") ?? hex;
}

export const INSTITUTION_HANDLERS: Handlers = {
  "institution.courses.post": ({ state, account, body }) => {
    if (account === null || !account.roles.includes("teacher")) return { error: "forbidden" };
    const same = state.courses.find(
      (c) =>
        c.createdBy === account.id && c.name === body.name && c.academicYear === body.academicYear,
    );
    if (same !== undefined) return { status: 200, body: { id: same.id } };
    const id = randomUUID();
    state.courses.push({
      id,
      name: body.name,
      academicYear: body.academicYear,
      aiPolicy: body.aiPolicy,
      holderId: account.id,
      createdBy: account.id,
      studentIds: [],
      groups: [],
      codes: [],
      removed: [],
    });
    return { status: 200, body: { id } };
  },
  "institution.enrollment-code.post": ({ state, account, params, body }) => {
    const course = taughtCourse(state, account, params.courseId);
    if (course === null) return { error: "forbidden" };
    for (const code of course.codes) code.active = false;
    const code = newCode();
    course.codes.push({ code, validUntil: new Date(body.validUntil).toISOString(), active: true });
    return { status: 200, body: { code } };
  },
  "institution.enrollment-code-revocation.post": ({ state, account, params }) => {
    const course = taughtCourse(state, account, params.courseId);
    if (course === null) return { error: "forbidden" };
    const active = course.codes.filter((c) => c.active);
    for (const code of active) code.active = false;
    return { status: 200, body: { revoked: active.length > 0 } };
  },
  "institution.enrollments.post": ({ state, account, body, now }) => {
    if (account === null || !account.roles.includes("student")) return { error: "forbidden" };
    const guesses = state.enrollmentGuesses.get(account.id) ?? 0;
    if (guesses >= MAX_ENROLLMENT_GUESSES) return { error: "too_many_attempts" };
    const course = state.courses.find((c) =>
      c.codes.some(
        (k) => k.active && k.code === body.code && Date.parse(k.validUntil) > now.getTime(),
      ),
    );
    if (course === undefined || course.removed.includes(account.id)) {
      state.enrollmentGuesses.set(account.id, guesses + 1);
      return { error: "refused" };
    }
    if (!course.studentIds.includes(account.id)) course.studentIds.push(account.id);
    return { status: 200, body: { courseId: course.id } };
  },
  "institution.acknowledgment.post": ({ state, account, params, body, now }) => {
    const assignment = state.assignments.find((a) => a.id === params.assignmentId);
    const course = state.courses.find((c) => c.id === assignment?.courseId);
    if (assignment === undefined || account === null || !course?.studentIds.includes(account.id))
      return { error: "forbidden" };
    if (body.versionNo !== assignment.version) return { error: "conflict" };
    const at = now.toISOString();
    assignment.acknowledged.set(account.id, { version: assignment.version, at });
    return { status: 200, body: { acknowledgedAt: at } };
  },
  "institution.assignment-versions.post": ({ state, account, params, body }) => {
    const assignment = taughtAssignment(state, account, params.assignmentId);
    if (assignment === null) return { error: "forbidden" };
    if (body.expectedVersion !== assignment.version) return { error: "version_conflict" };
    const content: AssignmentContent = {
      title: body.title,
      instructions: body.instructions,
      workType: body.workType,
      opensAt: body.opensAt,
      dueAt: body.dueAt,
      aiPolicy: body.aiPolicy,
      aiPurposes: body.aiPurposes,
      evidenceProfile: body.evidenceProfile,
      importAllowed: body.importAllowed,
      wordMin: body.wordMin,
      wordMax: body.wordMax,
    };
    if (content.wordMin !== null && content.wordMax !== null && content.wordMin > content.wordMax)
      return { error: "invalid_input" };
    if (content.aiPolicy === "prohibited" && content.aiPurposes.length > 0)
      return { error: "invalid_input" };
    assignment.version += 1;
    assignment.content = content;
    return { status: 201, body: { assignmentId: assignment.id, versionNo: assignment.version } };
  },
  "institution.student-removal.post": ({ state, account, params }) => {
    const course = taughtCourse(state, account, params.courseId);
    if (course === null) return { error: "forbidden" };
    const was = course.studentIds.includes(params.studentId);
    course.studentIds = course.studentIds.filter((id) => id !== params.studentId);
    for (const group of course.groups)
      group.studentIds = group.studentIds.filter((id) => id !== params.studentId);
    if (was && !course.removed.includes(params.studentId)) course.removed.push(params.studentId);
    return { status: 200, body: { removed: was } };
  },
  "institution.student-return.post": ({ state, account, params }) => {
    const course = taughtCourse(state, account, params.courseId);
    if (course === null) return { error: "forbidden" };
    const blocked = course.removed.includes(params.studentId);
    course.removed = course.removed.filter((id) => id !== params.studentId);
    return { status: 200, body: { allowed: blocked } };
  },
  "institution.role-confirmation.post": ({ state, account, params }) => {
    if (!isAdmin(account)) return { error: "forbidden" };
    const teacher = state.accounts.find((a) => a.id === params.teacherId);
    if (teacher === undefined) return { error: "not_found" };
    if (!teacher.roles.includes("teacher")) teacher.roles.push("teacher");
    return { status: 200, body: { confirmed: true } };
  },
  "institution.role-revocation.post": ({ state, account, params }) => {
    if (!isAdmin(account)) return { error: "forbidden" };
    const teacher = state.accounts.find((a) => a.id === params.teacherId);
    const had = teacher?.roles.includes("teacher") ?? false;
    if (teacher !== undefined) teacher.roles = teacher.roles.filter((r) => r !== "teacher");
    return { status: 200, body: { revoked: had } };
  },
  "institution.work-language.post": ({ state, account, params, body }) => {
    const assignment = taughtAssignment(state, account, params.assignmentId);
    if (assignment === null) return { error: "forbidden" };
    if (body.expectedVersion !== assignment.version) return { error: "conflict" };
    if (state.works.some((w) => w.assignmentId === assignment.id && w.state === "submitted"))
      return { error: "conflict" };
    assignment.language = body.language;
    assignment.version += 1;
    return { status: 200, body: { version: assignment.version } };
  },
  "institution.student-work-language.post": ({ state, account, params, body }) => {
    const assignment = taughtAssignment(state, account, params.assignmentId);
    if (assignment === null) return { error: "forbidden" };
    if (body.language === null) assignment.studentLanguage.delete(params.studentId);
    else assignment.studentLanguage.set(params.studentId, body.language);
    return { status: 200, body: { language: body.language ?? assignment.language } };
  },
  "institution.work-work-language.post": ({ state, account, params, body }) => {
    const assignment = taughtAssignment(state, account, params.assignmentId);
    const work = state.works.find(
      (w) => w.documentId === params.documentId && w.assignmentId === assignment?.id,
    );
    if (assignment === null || work === undefined) return { error: "forbidden" };
    work.language = body.language;
    return { status: 200, body: { language: body.language ?? assignment.language } };
  },
};
