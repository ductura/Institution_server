// SRV-1412: the student starts the own work and reads the own works, on the
// dev fake server. One work per student and assignment; the fake holds no
// institution config, so rulesVersion is always null.
import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import { EMPTY_DOCUMENT } from "./state.ts";
import { studentAssignments } from "./student-routes.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const STUDENT_WORK_HANDLERS: Handlers = {
  "student-work.start.post": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const id = params.assignmentId.toLowerCase();
    const assignment = UUID.test(id)
      ? studentAssignments(state, account).find((a) => a.id === id)
      : undefined;
    if (assignment === undefined) return { error: "not_found" };
    let work = state.works.find((w) => w.assignmentId === id && w.studentId === account.id);
    if (work === undefined) {
      // PRODUCT §5: the notice comes before the work, and nothing opens before opensAt.
      if (
        assignment.acknowledged.get(account.id)?.version !== assignment.version ||
        assignment.content.opensAt > now.toISOString()
      )
        return { error: "conflict" };
      work = {
        documentId: randomUUID(),
        assignmentId: id,
        studentId: account.id,
        state: "in_progress",
        revision: 0,
        lastChangeAt: now.toISOString(),
        submittedAt: null,
        submissionReceipt: null,
        submittedDocument: null,
        document: EMPTY_DOCUMENT,
        versionSnapshots: new Map(),
        segments: [],
        lastSequenceTo: 0,
        transactions: new Map(),
        live: null,
      };
      state.works.push(work);
    }
    const language = assignment.studentLanguage.get(account.id) ?? assignment.language;
    return { status: 200, body: { workId: work.documentId, rulesVersion: null, language } };
  },
  "student-work.works.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const works = studentAssignments(state, account).flatMap((assignment) => {
      const work = state.works.find(
        (w) => w.assignmentId === assignment.id && w.studentId === account.id,
      );
      const course = state.courses.find((c) => c.id === assignment.courseId);
      if (work === undefined || course === undefined) return [];
      const extension = state.deadlineExtensions
        .filter((e) => e.assignmentId === assignment.id && e.studentId === account.id)
        .at(-1);
      return [
        {
          workId: work.documentId,
          assignmentId: assignment.id,
          assignmentTitle: assignment.content.title,
          courseId: course.id,
          courseName: course.name,
          academicYear: course.academicYear,
          dueAt: extension?.dueAt ?? assignment.content.dueAt,
          state: work.state,
          revision: work.revision,
          submittedAt: work.submittedAt,
          language: assignment.studentLanguage.get(account.id) ?? assignment.language,
        },
      ];
    });
    works.sort(
      (a, b) =>
        a.dueAt.localeCompare(b.dueAt) ||
        a.assignmentId.localeCompare(b.assignmentId) ||
        a.workId.localeCompare(b.workId),
    );
    return { status: 200, body: { works } };
  },
};
