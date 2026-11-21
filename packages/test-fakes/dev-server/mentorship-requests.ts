import type { Handlers } from "./server.ts";
import type { Account, MentorshipRequest, State } from "./state.ts";

// SRV-1407: the moves of one mentorship request, as the database makes them.
// Not allowed and unknown both read not_found. The fake records the
// mentorship id of an approval but opens no work for it, so the mentorship
// reads stay as they were; an approved request still blocks a new one of the
// kind, as the open mentorship does in the database.
function own(state: State, account: Account | null, id: string, as: "student" | "teacher") {
  const request = state.mentorshipRequests.find((r) => r.id === id.toLowerCase());
  if (account === null || request === undefined) return null;
  if (as === "teacher") {
    return request.teacherId === account.id && account.roles.includes("teacher") ? request : null;
  }
  return request.studentId === account.id ? request : null;
}

function end(request: MentorshipRequest, state: "declined" | "withdrawn", now: Date) {
  request.state = state;
  request.endedAt = now.toISOString();
}

export const MENTORSHIP_REQUEST_HANDLERS: Handlers = {
  "mentorship.requests.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const teacherId = body.teacherId.toLowerCase();
    const teacher = state.accounts.find((a) => a.id === teacherId);
    if (teacher === undefined || teacherId === account.id || !teacher.roles.includes("teacher"))
      return { error: "not_found" };
    const busy =
      state.mentorshipRequests.some(
        (r) =>
          r.studentId === account.id &&
          r.workType === body.workType &&
          (r.state === "requested" || r.state === "approved"),
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
      requestedAt: now.toISOString(),
      endedAt: null,
    };
    state.mentorshipRequests.push(request);
    return { status: 201, body: { requestId: request.id, state: "requested" } };
  },
  "mentorship.request-approve.post": ({ state, account, params, now }) => {
    const request = own(state, account, params.requestId, "teacher");
    if (request === null) return { error: "not_found" };
    if (request.state === "requested") {
      request.state = "approved";
      request.endedAt = now.toISOString();
      request.mentorshipId = `b1500000-0000-4000-8000-${request.id.slice(-12)}`;
    }
    if (request.state !== "approved" || request.mentorshipId === null) return { error: "conflict" };
    return {
      status: 200,
      body: { requestId: request.id, state: "approved", mentorshipId: request.mentorshipId },
    };
  },
  "mentorship.request-decline.post": ({ state, account, params, now }) => {
    const request = own(state, account, params.requestId, "teacher");
    if (request === null) return { error: "not_found" };
    if (request.state === "requested") end(request, "declined", now);
    if (request.state !== "declined") return { error: "conflict" };
    return { status: 200, body: { requestId: request.id, state: "declined" } };
  },
  "mentorship.request-withdraw.post": ({ state, account, params, now }) => {
    const request = own(state, account, params.requestId, "student");
    if (request === null) return { error: "not_found" };
    if (request.state === "requested") end(request, "withdrawn", now);
    if (request.state !== "withdrawn") return { error: "conflict" };
    return { status: 200, body: { requestId: request.id, state: "withdrawn" } };
  },
  // SRV-1414: the student's side. One institution in the fake; a caller with
  // the teacher role is refused, as app.student_mentorship_requests does.
  "mentorship.student-requests.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    if (account.roles.includes("teacher")) return { error: "forbidden" };
    const requests = state.mentorshipRequests
      .filter((r) => r.studentId === account.id)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || a.id.localeCompare(b.id))
      .map((r) => {
        const teacher = state.accounts.find((a) => a.id === r.teacherId);
        const base = {
          requestId: r.id,
          teacherId: r.teacherId,
          teacherName: teacher
            ? { givenName: teacher.givenName, familyName: teacher.familyName }
            : null,
          workType: r.workType,
          requestedAt: r.requestedAt,
        };
        const endedAt = r.endedAt ?? r.requestedAt;
        if (r.state === "requested")
          return { ...base, state: r.state, endedAt: null, mentorshipId: null };
        if (r.state === "approved" && r.mentorshipId !== null)
          return { ...base, state: r.state, endedAt, mentorshipId: r.mentorshipId };
        return { ...base, state: r.state as "declined" | "withdrawn", endedAt, mentorshipId: null };
      });
    return { status: 200, body: { requests } };
  },
  "mentorship.student-mentor-candidates.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    if (account.roles.includes("teacher")) return { error: "forbidden" };
    const candidates = state.accounts
      .filter((a) => a.id !== account.id && a.roles.includes("teacher"))
      .sort(
        (a, b) =>
          a.familyName.localeCompare(b.familyName, "hr") ||
          a.givenName.localeCompare(b.givenName, "hr") ||
          a.id.localeCompare(b.id),
      )
      .map((a) => ({
        teacherId: a.id,
        name: { givenName: a.givenName, familyName: a.familyName },
        department: null,
      }));
    return { status: 200, body: { candidates } };
  },
};
