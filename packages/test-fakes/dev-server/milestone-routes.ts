import type { Handlers } from "./server.ts";
import { readerOf, type MilestoneProgress, type State, type WorkMilestone } from "./state.ts";

// SRV-1520: the dev server has no mentorship of a work, so "the mentor" is the
// teacher reader of the work; the server decides through the mentorship (C-23).
function stateOf(state: State, documentId: string, milestone: WorkMilestone) {
  const progress: MilestoneProgress | undefined = state.milestoneProgress.get(
    `${documentId}/${milestone.id}`,
  );
  const revising = progress?.state === "revision_requested";
  return {
    id: milestone.id,
    title: milestone.title,
    description: milestone.description,
    dueAt: milestone.dueAt,
    state: progress?.state ?? ("not_submitted" as const),
    everSubmitted: progress !== undefined,
    submittedRevisionId: progress?.submittedRevisionId ?? null,
    submittedAt: progress?.submittedAt ?? null,
    revisionComment: revising ? progress.revisionComment : null,
    revisionDueAt: revising ? progress.revisionDueAt : null,
    revisionRequestedAt: revising ? progress.revisionRequestedAt : null,
    approvedAt: progress?.approvedAt ?? null,
    approvalMessage: progress?.approvalMessage ?? null,
  };
}

export const MILESTONE_HANDLERS: Handlers = {
  "work.milestones.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    if (readerOf(state, work, account) === null) return { error: "not_found" };
    return { status: 200, body: { milestones: state.milestones.get(params.documentId) ?? [] } };
  },
  "work.milestones.patch": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    const milestone = state.milestones
      .get(work.documentId)
      ?.find((entry) => entry.id === params.milestoneId.toLowerCase());
    if (milestone === undefined) return { error: "not_found" };
    if (work.state === "submitted") return { error: "conflict" };
    const date = new Date(body.dueAt);
    const year = date.getUTCFullYear();
    const calendarDay = body.dueAt.slice(0, 10);
    const midnight = new Date(`${calendarDay}T00:00:00Z`);
    if (
      !(year >= 1 && year <= 9999) ||
      !Number.isFinite(midnight.getTime()) ||
      midnight.toISOString().slice(0, 10) !== calendarDay
    ) {
      return { error: "invalid_input" };
    }
    milestone.dueAt = date.toISOString();
    return { status: 200, body: milestone };
  },
  "work.milestone-states.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    if (readerOf(state, work, account) === null) return { error: "not_found" };
    const list = state.milestones.get(params.documentId) ?? [];
    return {
      status: 200,
      body: { milestones: list.map((m) => stateOf(state, params.documentId, m)) },
    };
  },
  "work.milestones.submit.post": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "owner") return { error: "forbidden" };
    const milestone = state.milestones
      .get(work.documentId)
      ?.find((entry) => entry.id === params.milestoneId.toLowerCase());
    if (milestone === undefined) return { error: "not_found" };
    const key = `${work.documentId}/${milestone.id}`;
    const current = state.milestoneProgress.get(key);
    if (current !== undefined && current.state !== "revision_requested")
      return { error: "conflict" };
    state.milestoneProgress.set(key, {
      state: "submitted",
      submittedRevisionId: work.revision,
      submittedAt: new Date().toISOString(),
      revisionComment: null,
      revisionDueAt: null,
      revisionRequestedAt: null,
      approvedAt: null,
      approvalMessage: null,
    });
    return { status: 200, body: stateOf(state, work.documentId, milestone) };
  },
  "work.milestones.request-revision.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    const milestone = state.milestones
      .get(work.documentId)
      ?.find((entry) => entry.id === params.milestoneId.toLowerCase());
    if (milestone === undefined) return { error: "not_found" };
    if (body.comment.trim() === "") return { error: "invalid_input" };
    const progress = state.milestoneProgress.get(`${work.documentId}/${milestone.id}`);
    if (progress?.state !== "submitted") return { error: "conflict" };
    progress.state = "revision_requested";
    progress.revisionComment = body.comment;
    progress.revisionDueAt = body.revisionDueAt ?? null;
    progress.revisionRequestedAt = new Date().toISOString();
    return { status: 200, body: stateOf(state, work.documentId, milestone) };
  },
  "work.milestones.approve.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    const milestone = state.milestones
      .get(work.documentId)
      ?.find((entry) => entry.id === params.milestoneId.toLowerCase());
    if (milestone === undefined) return { error: "not_found" };
    const progress = state.milestoneProgress.get(`${work.documentId}/${milestone.id}`);
    if (progress?.state !== "submitted") return { error: "conflict" };
    progress.state = "approved";
    progress.approvedAt = new Date().toISOString();
    progress.approvalMessage = body.message ?? null;
    return { status: 200, body: stateOf(state, work.documentId, milestone) };
  },
  "work.milestones.details.patch": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    const milestone = state.milestones
      .get(work.documentId)
      ?.find((entry) => entry.id === params.milestoneId.toLowerCase());
    if (milestone === undefined) return { error: "not_found" };
    if (body.title === undefined && body.dueAt === undefined) return { error: "invalid_input" };
    if (body.dueAt !== undefined && work.state === "submitted") return { error: "conflict" };
    if (body.title !== undefined) milestone.title = body.title;
    if (body.dueAt !== undefined) milestone.dueAt = new Date(body.dueAt).toISOString();
    return { status: 200, body: stateOf(state, work.documentId, milestone) };
  },
  "work.milestones.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    const list = state.milestones.get(work.documentId) ?? [];
    const at = list.findIndex((entry) => entry.id === params.milestoneId.toLowerCase());
    if (at < 0) return { error: "not_found" };
    if (state.milestoneProgress.has(`${work.documentId}/${list[at]!.id}`)) {
      return { error: "conflict" };
    }
    list.splice(at, 1);
    return { status: 204 };
  },
};
