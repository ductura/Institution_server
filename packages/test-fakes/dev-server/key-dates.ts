import type { Operations } from "../../../server/contracts/generated/index.ts";

import type { Handlers } from "./server.ts";

type Dates = Operations["mentorship.key-dates.get"]["success"]["body"]["dates"];

export const KEY_DATES_HANDLERS: Handlers = {
  "mentorship.key-dates.get": ({ account, state, params }) => {
    if (account === null) return { error: "unauthorized" };
    const mentorship = state.mentorships.find((item) => item.id === params.id.toLowerCase());
    if (
      mentorship === undefined ||
      (mentorship.studentId !== account.id &&
        (mentorship.mentorId !== account.id || !account.roles.includes("teacher")))
    ) {
      return { error: "not_found" };
    }
    const { assignmentId, studentId, documentId } = mentorship;
    const dueAt = state.deadlineExtensions.reduce((current, extension) => {
      if (extension.assignmentId !== assignmentId) return current;
      if (extension.studentId !== null && extension.studentId !== studentId) return current;
      return extension.dueAt > current ? extension.dueAt : current;
    }, mentorship.dueAt);
    const dates: Dates = [{ kind: "deadline", id: assignmentId, at: dueAt }];
    if (documentId !== null) {
      for (const { id, dueAt, title } of state.milestones.get(documentId) ?? []) {
        if (dueAt !== null) dates.push({ kind: "milestone", id, at: dueAt, title });
      }
      for (const { documentId: slotDocument, slot } of state.consultationSlots) {
        if (slotDocument === documentId) {
          dates.push({ kind: "consultation", id: slot.id, at: slot.startsAt, state: slot.state });
        }
      }
    }
    dates.sort(
      (a, b) =>
        a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
    );
    return { status: 200, body: { dates } };
  },
};
