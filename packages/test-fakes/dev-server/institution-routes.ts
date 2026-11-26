// Institution routes of the dev fake server: courses, enrolment codes,
// enrolment, the notice acknowledgment, assignment versions, teacher roles and
// work language. Access comes from relations in the state (teacher of the
// course, student in it), never from a role alone (C-23).
import { randomBytes, randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import {
  normalizeCode,
  parseInstant,
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
  return course !== undefined && account !== null && teachesCourse(course, account) ? course : null;
}

function taughtAssignment(state: State, account: Account | null, id: string): Assignment | null {
  const assignment = state.assignments.find((a) => a.id === id);
  if (assignment === undefined) return null;
  return taughtCourse(state, account, assignment.courseId) === null ? null : assignment;
}

/** institution.ai_policy_rank: later in the list is more permissive. */
const AI_POLICIES = ["prohibited", "partially_allowed", "encouraged"] as const;

/**
 * Whether a new version changes the rules in a way institution.publish_assignment_version
 * refuses (422): a more permissive AI policy, a purpose that was not allowed, extended
 * evidence after basic, import after none, or a word bound added or tightened (rule 14).
 */
function tightens(current: AssignmentContent, next: AssignmentContent): boolean {
  return (
    AI_POLICIES.indexOf(next.aiPolicy) > AI_POLICIES.indexOf(current.aiPolicy) ||
    next.aiPurposes.some((p) => !current.aiPurposes.includes(p)) ||
    (next.evidenceProfile === "extended" && current.evidenceProfile === "basic") ||
    (next.importAllowed && !current.importAllowed) ||
    (next.wordMin !== null && (current.wordMin === null || next.wordMin > current.wordMin)) ||
    (next.wordMax !== null && (current.wordMax === null || next.wordMax < current.wordMax))
  );
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
  // UGOVORI-API (wweb18): whether the course has a code; never the code itself (A-8).
  "institution.enrollment-code-state.get": ({ state, account, params }) => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(params.courseId))
      return { error: "invalid_input" };
    const course = taughtCourse(state, account, params.courseId.toLowerCase());
    if (course === null) return { error: "not_found" };
    const current = course.codes.find((code) => code.active);
    return {
      status: 200,
      body: { current: current === undefined ? null : { validUntil: current.validUntil } },
    };
  },
  "institution.enrollment-code.post": ({ state, account, params, body }) => {
    const course = taughtCourse(state, account, params.courseId);
    if (course === null) return { error: "forbidden" };
    const validUntil = parseInstant(body.validUntil);
    // An impossible date passes the pattern; the contract answers it 422, with nothing changed.
    if (validUntil === null) return { error: "invalid_input" };
    for (const code of course.codes) code.active = false;
    const code = newCode();
    course.codes.push({ code, validUntil, active: true });
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
    const code = normalizeCode(body.code);
    const course = state.courses.find((c) =>
      c.codes.some(
        (k) =>
          k.active && normalizeCode(k.code) === code && Date.parse(k.validUntil) > now.getTime(),
      ),
    );
    if (course === undefined || course.removed.includes(account.id)) {
      state.enrollmentGuesses.set(account.id, guesses + 1);
      return { error: "refused" };
    }
    if (!course.studentIds.includes(account.id)) course.studentIds.push(account.id);
    return { status: 200, body: { courseId: course.id } };
  },
  // SRV-02 (A-2): enrolment with every outcome told apart.
  "student.enrollments.post": ({ state, account, body, now }) => {
    if (account === null || !account.roles.includes("student")) return { error: "forbidden" };
    const guesses = state.enrollmentGuesses.get(account.id) ?? 0;
    if (guesses >= MAX_ENROLLMENT_GUESSES) return { error: "too_many_attempts" };
    const code = normalizeCode(body.code);
    const course = /^[0-9A-Z]{8,32}$/u.test(code)
      ? state.courses.find((c) => c.codes.some((k) => normalizeCode(k.code) === code))
      : undefined;
    if (course === undefined || course.removed.includes(account.id)) {
      state.enrollmentGuesses.set(account.id, guesses + 1);
      return { error: "invalid_code" };
    }
    if (course.studentIds.includes(account.id))
      return { status: 200, body: { outcome: "already_enrolled", courseId: course.id } };
    const valid = course.codes.some(
      (k) => k.active && normalizeCode(k.code) === code && Date.parse(k.validUntil) > now.getTime(),
    );
    if (!valid) {
      state.enrollmentGuesses.set(account.id, guesses + 1);
      return { error: "expired_code" };
    }
    course.studentIds.push(account.id);
    const outcome = state.assignments.some((a) => a.courseId === course.id)
      ? "enrolled"
      : "enrolled_no_assignment";
    return { status: 200, body: { outcome, courseId: course.id } };
  },
  // SRV-02 (PO-7): the notice of the current version was read; the first time is kept.
  "student.notice-read.post": ({ state, account, params, body, now }) => {
    const assignment = state.assignments.find((a) => a.id === params.assignmentId);
    const course = state.courses.find((c) => c.id === assignment?.courseId);
    if (assignment === undefined || account === null || !course?.studentIds.includes(account.id))
      return { error: "not_found" };
    if (body.versionNo !== assignment.version) return { error: "conflict" };
    const key = `${account.id}:${assignment.version}`;
    const readAt = assignment.read.get(key) ?? now.toISOString();
    assignment.read.set(key, readAt);
    return { status: 200, body: { readAt } };
  },
  // UGOVORI-API (SRV-NG): the notice of the current version, as E-6 shows it.
  "student.notice.get": ({ state, account, params }) => {
    const assignment = state.assignments.find((a) => a.id === params.assignmentId);
    const course = state.courses.find((c) => c.id === assignment?.courseId);
    if (assignment === undefined || account === null || !course?.studentIds.includes(account.id))
      return { error: "not_found" };
    const c = assignment.content;
    const acknowledged = assignment.acknowledged.get(account.id);
    return {
      status: 200,
      body: {
        assignmentId: assignment.id,
        versionNo: assignment.version,
        templateVersion: 1,
        ...{ title: c.title, instructions: c.instructions, workType: c.workType },
        ...{ opensAt: c.opensAt, dueAt: c.dueAt, aiPolicy: c.aiPolicy },
        aiPurposes: c.aiPolicy === "prohibited" ? [] : c.aiPurposes,
        ...{ evidenceProfile: c.evidenceProfile, wordMin: c.wordMin, wordMax: c.wordMax },
        readAt: assignment.read.get(`${account.id}:${assignment.version}`) ?? null,
        acknowledgedAt: acknowledged?.version === assignment.version ? acknowledged.at : null,
        purposeCatalogVersion: 1,
        aiSummaryOnly: c.aiSummaryOnly === true,
      },
    };
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
    const opensAt = parseInstant(body.opensAt);
    const dueAt = parseInstant(body.dueAt);
    if (opensAt === null || dueAt === null) return { error: "invalid_input" };
    const content: AssignmentContent = {
      title: body.title,
      instructions: body.instructions,
      workType: body.workType,
      opensAt,
      dueAt,
      aiPolicy: body.aiPolicy,
      aiPurposes: body.aiPurposes,
      evidenceProfile: body.evidenceProfile,
      importAllowed: body.importAllowed,
      wordMin: body.wordMin,
      wordMax: body.wordMax,
    };
    // UGOVORI-API: the creation's groups, outside tools and summary-only mode stay with the assignment.
    for (const key of ["groupIds", "externalToolsAllowed", "aiSummaryOnly", "isPractice"] as const)
      if (assignment.content[key] !== undefined)
        Object.assign(content, { [key]: assignment.content[key] });
    if (content.wordMin !== null && content.wordMax !== null && content.wordMin > content.wordMax)
      return { error: "invalid_input" };
    if (content.aiPolicy === "prohibited" && content.aiPurposes.length > 0)
      return { error: "invalid_input" };
    if (tightens(assignment.content, content)) return { error: "invalid_input" };
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
    // As institution.confirm_teacher_role: the administrator themself, a missing
    // person and a student (whose login gives no teacher right, D-171) are one 404.
    const teacher = state.accounts.find((a) => a.id === params.teacherId);
    if (teacher === undefined || teacher.id === account?.id || teacher.roles.includes("student"))
      return { error: "not_found" };
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
  "institution.work-work-language.get": ({ state, account, params }) => {
    const assignment = taughtAssignment(state, account, params.assignmentId);
    const work = state.works.find(
      (w) => w.documentId === params.documentId && w.assignmentId === assignment?.id,
    );
    if (assignment === null || work === undefined) return { error: "forbidden" };
    return {
      status: 200,
      body: {
        title: assignment.content.title,
        assignmentLanguage: assignment.language,
        exception: assignment.studentLanguage.get(work.studentId) ?? null,
      },
    };
  },
  "institution.work-work-language.post": ({ state, account, params, body }) => {
    const assignment = taughtAssignment(state, account, params.assignmentId);
    const work = state.works.find(
      (w) => w.documentId === params.documentId && w.assignmentId === assignment?.id,
    );
    if (assignment === null || work === undefined) return { error: "forbidden" };
    // The same exception as the student-keyed route: one override per student's work.
    if (body.language === null) assignment.studentLanguage.delete(work.studentId);
    else assignment.studentLanguage.set(work.studentId, body.language);
    return { status: 200, body: { language: body.language ?? assignment.language } };
  },
};
