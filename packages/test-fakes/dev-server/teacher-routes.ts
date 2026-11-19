// Teacher routes of the dev fake server: own courses, submissions, the fast
// path and mentorships. An assignment the caller does not teach reads as an
// empty list, as the contract says; the role alone opens no work (C-23).
import { createHash, randomUUID } from "node:crypto";

import type { Operations } from "../../contracts/index.ts";
import type { Handlers } from "./server.ts";
import {
  teachesCourse,
  type Account,
  type Assignment,
  type Mentorship,
  type State,
} from "./state.ts";
import { processSummary, textBlocks } from "./work.ts";

type FastPathStudent = Operations["teacher.fast-path.post"]["success"]["body"]["students"][number];

function taught(state: State, account: Account | null, assignmentId: string): Assignment | null {
  const assignment = state.assignments.find((a) => a.id === assignmentId.toLowerCase());
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  return assignment !== undefined &&
    course !== undefined &&
    account !== null &&
    teachesCourse(course, account.id)
    ? assignment
    : null;
}

function submissions(state: State, assignment: Assignment | null) {
  if (assignment === null) return [];
  const course = state.courses.find((c) => c.id === assignment.courseId);
  return [...(course?.studentIds ?? [])].sort().map((studentId) => {
    const work = state.works.find(
      (w) => w.assignmentId === assignment.id && w.studentId === studentId,
    );
    const documentId = work?.documentId ?? null;
    if (work?.submittedAt == null)
      return {
        studentId,
        documentId,
        submitted: false,
        revision: null,
        requestedMinute: null,
        afterDeadline: null,
      } as const;
    return {
      studentId,
      documentId,
      submitted: true,
      revision: work.revision,
      requestedMinute: `${work.submittedAt.slice(0, 16)}:00.000Z`,
      afterDeadline: work.submittedAt > assignment.content.dueAt,
    } as const;
  });
}

function mentorshipWork(state: State, m: Mentorship) {
  const student = state.accounts.find((a) => a.id === m.studentId);
  const base = {
    mentorshipId: m.id,
    assignmentId: m.assignmentId,
    student:
      student === undefined
        ? null
        : { givenName: student.givenName, familyName: student.familyName },
    title: m.title,
    workType: m.workType,
  };
  return m.documentId === null
    ? { ...base, documentId: null, workState: "not_started" as const }
    : { ...base, documentId: m.documentId, workState: "in_progress" as const };
}

export const TEACHER_HANDLERS: Handlers = {
  "teacher.access.get": ({ account }) => {
    if (account === null) return { error: "unauthorized" };
    const scope = createHash("sha256").update(account.id).digest("hex");
    return {
      status: 200,
      body: { access: account.roles.includes("teacher") ? "allowed" : "denied", scope },
    };
  },
  "teacher.courses.get": ({ state, account }) => {
    if (account === null || !account.roles.includes("teacher")) return { error: "forbidden" };
    const courses = state.courses
      .filter((c) => teachesCourse(c, account.id))
      .sort(
        (a, b) =>
          b.academicYear.localeCompare(a.academicYear) || a.name.localeCompare(b.name, "hr"),
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        academicYear: c.academicYear,
        aiPolicy: c.aiPolicy,
        assignments: state.assignments
          .filter((a) => a.courseId === c.id)
          .sort((a, b) => a.content.dueAt.localeCompare(b.content.dueAt))
          .map((a) => ({
            id: a.id,
            title: a.content.title,
            workType: a.content.workType,
            opensAt: a.content.opensAt,
            dueAt: a.content.dueAt,
            currentVersion: a.version,
            enrolledStudents: c.studentIds.length,
          })),
      }));
    return { status: 200, body: { courses } };
  },
  "teacher.submissions.get": ({ state, account, params }) => ({
    status: 200,
    body: { submissions: submissions(state, taught(state, account, params.assignmentId)) },
  }),
  "teacher.assignment-submissions.post": ({ state, account, body }) => {
    const ids = [...new Set(body.assignmentIds.map((id) => id.toLowerCase()))];
    const assignments = ids.map((assignmentId) => ({
      assignmentId,
      submissions: submissions(state, taught(state, account, assignmentId)),
    }));
    return { status: 200, body: { assignments } };
  },
  "teacher.fast-path.post": ({ state, account, body, now }) => {
    const assignment = taught(state, account, body.assignmentId);
    if (assignment === null || account === null)
      return { status: 200, body: { kind: "ok", students: [] } };
    const course = state.courses.find((c) => c.id === assignment.courseId);
    const students = (course?.studentIds ?? []).flatMap((id): FastPathStudent[] => {
      const student = state.accounts.find((a) => a.id === id);
      if (student === undefined) return [];
      const names = { id, givenName: student.givenName, surname: student.familyName };
      const work = state.works.find((w) => w.assignmentId === assignment.id && w.studentId === id);
      if (work === undefined)
        return [
          {
            ...names,
            documentId: null,
            work: "notice_pending",
            lastChangeAt: null,
            record: null,
          } as const,
        ];
      state.accessLog.push({
        id: randomUUID(),
        documentId: work.documentId,
        readerId: account.id,
        at: now.toISOString(),
        role: "teacher",
        surface: "fast_path",
      });
      return [
        {
          ...names,
          documentId: work.documentId,
          work: work.state === "submitted" ? "submitted" : "writing",
          lastChangeAt: work.lastChangeAt,
          record: { pastesWithoutSource: 0, blocks: textBlocks(), summary: processSummary(work) },
        } as const,
      ];
    });
    students.sort((a, b) => (a.surname ?? "").localeCompare(b.surname ?? "", "hr"));
    return { status: 200, body: { kind: "ok", students } };
  },
  "teacher.mentorships.get": ({ state, account }) => ({
    status: 200,
    body: {
      works: state.mentorships
        .filter((m) => m.mentorId === account?.id)
        .map((m) => mentorshipWork(state, m)),
    },
  }),
  "teacher.mentorship.get": ({ state, account, params }) => {
    const m = state.mentorships.find(
      (x) => x.id === params.mentorshipId && x.mentorId === account?.id,
    );
    return m === undefined
      ? { error: "not_found" }
      : { status: 200, body: { work: mentorshipWork(state, m) } };
  },
};
