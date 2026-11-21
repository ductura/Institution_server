import type { Handlers } from "./server.ts";
import type { Account, MentorshipRequest, State } from "./state.ts";

// SRV-1407: the moves of one mentorship request, as the database makes them.
// Not allowed and unknown both read not_found. The fake records the
// mentorship id of an approval but opens no work for it.
function own(state: State, account: Account | null, id: string, as: "student" | "teacher") {
  const request = state.mentorshipRequests.find((r) => r.id === id.toLowerCase());
  if (account === null || request === undefined) return null;
  if (as === "teacher") {
    return request.teacherId === account.id && account.roles.includes("teacher") ? request : null;
  }
  return request.studentId === account.id ? request : null;
}

export const MENTORSHIP_REQUEST_HANDLERS: Handlers = {
  "mentorship.requests.post": ({ state, account, body }) => {
    if (account === null) return { error: "unauthorized" };
    const teacherId = body.teacherId.toLowerCase();
    const teacher = state.accounts.find((a) => a.id === teacherId);
    if (teacher === undefined || teacherId === account.id || !teacher.roles.includes("teacher"))
      return { error: "not_found" };
    const busy =
      state.mentorshipRequests.some(
        (r) =>
          r.studentId === account.id && r.workType === body.workType && r.state === "requested",
      ) ||
      state.mentorships.some((m) => m.studentId === account.id && m.workType === body.workType);
    if (busy) return { error: "conflict" };
    const request: MentorshipRequest = {
      id: `b1400000-0000-4000-8000-${String(state.mentorshipRequests.length + 1).padStart(12, "0")}`,
      studentId: account.id,
      teacherId,
      workType: body.workType,
      state: "requested",
      mentorshipId: null,
    };
    state.mentorshipRequests.push(request);
    return { status: 201, body: { requestId: request.id, state: "requested" } };
  },
  "mentorship.request-approve.post": ({ state, account, params }) => {
    const request = own(state, account, params.requestId, "teacher");
    if (request === null) return { error: "not_found" };
    if (request.state === "requested") {
      request.state = "approved";
      request.mentorshipId = `b1500000-0000-4000-8000-${request.id.slice(-12)}`;
    }
    if (request.state !== "approved" || request.mentorshipId === null) return { error: "conflict" };
    return {
      status: 200,
      body: { requestId: request.id, state: "approved", mentorshipId: request.mentorshipId },
    };
  },
  "mentorship.request-decline.post": ({ state, account, params }) => {
    const request = own(state, account, params.requestId, "teacher");
    if (request === null) return { error: "not_found" };
    if (request.state === "requested") request.state = "declined";
    if (request.state !== "declined") return { error: "conflict" };
    return { status: 200, body: { requestId: request.id, state: "declined" } };
  },
  "mentorship.request-withdraw.post": ({ state, account, params }) => {
    const request = own(state, account, params.requestId, "student");
    if (request === null) return { error: "not_found" };
    if (request.state === "requested") request.state = "withdrawn";
    if (request.state !== "withdrawn") return { error: "conflict" };
    return { status: 200, body: { requestId: request.id, state: "withdrawn" } };
  },
};
