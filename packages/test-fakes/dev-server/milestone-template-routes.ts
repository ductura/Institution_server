import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import { readerOf, type Account, type State, type WorkMilestone } from "./state.ts";

// SRV-1521: the template of milestones of the institution and the plan of one work on the
// dev fake server. Only the administrator reads or replaces the template, a version is only
// added; "the mentor" of a work is its teacher reader (the real server decides through the
// mentorship, C-23). What a milestone sends is kept beside the legacy milestone, which has no
// such field. The real rules are 20261213110000_milestone_template.sql.
type Submits = "topic_text" | "current_version";
type Item = { title: string; relativeDue?: number; submits: Submits };
type Version = {
  version: number;
  effectiveFrom: string;
  requireFinalStageApproval: boolean;
  milestones: Item[];
};

const versions = new WeakMap<State, Version[]>();
const submitsOf = new WeakMap<State, Map<string, Submits>>();
const isAdmin = (account: Account | null): boolean =>
  account?.roles.includes("institution_admin") ?? false;

function planOf(state: State, documentId: string) {
  const kinds = submitsOf.get(state);
  return {
    milestones: (state.milestones.get(documentId) ?? []).map((m, index) => ({
      id: m.id,
      position: index + 1,
      title: m.title,
      dueAt: m.dueAt,
      submits: kinds?.get(m.id) ?? ("current_version" as const),
    })),
  };
}

function add(state: State, documentId: string, milestone: WorkMilestone, submits: Submits) {
  const list = state.milestones.get(documentId) ?? [];
  list.push(milestone);
  state.milestones.set(documentId, list);
  const kinds = submitsOf.get(state) ?? new Map<string, Submits>();
  kinds.set(milestone.id, submits);
  submitsOf.set(state, kinds);
}

export const MILESTONE_TEMPLATE_HANDLERS: Handlers = {
  "institution.milestone-template.get": ({ state, account, query }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    const all = versions.get(state) ?? [];
    return { status: 200, body: { current: all.at(-1) ?? null, versions: all } };
  },
  "institution.milestone-template.put": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    const all = versions.get(state) ?? [];
    if (body.milestones.some((item) => item.title.trim() === "")) return { error: "invalid_input" };
    if (body.expectedVersion !== all.length) return { error: "conflict" };
    const made: Version = {
      version: all.length + 1,
      effectiveFrom: new Date(now).toISOString(),
      requireFinalStageApproval: body.requireFinalStageApproval,
      milestones: body.milestones,
    };
    versions.set(state, [...all, made]);
    return { status: 200, body: made };
  },
  "work.milestone-plan.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    if (readerOf(state, work, account) === null) return { error: "not_found" };
    return { status: 200, body: planOf(state, params.documentId) };
  },
  "work.milestone-plan.add.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    if (body.title.trim() === "") return { error: "invalid_input" };
    if (work.state === "submitted" || (state.milestones.get(work.documentId)?.length ?? 0) >= 100) {
      return { error: "conflict" };
    }
    add(
      state,
      work.documentId,
      {
        id: randomUUID(),
        title: body.title,
        description: "",
        dueAt: body.dueAt === undefined ? null : new Date(body.dueAt).toISOString(),
        state: "open",
      },
      body.submits,
    );
    return { status: 201, body: planOf(state, work.documentId) };
  },
  "work.milestone-plan.apply-template.post": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader !== "teacher") return { error: "forbidden" };
    const template = versions.get(state)?.at(-1);
    const sent = [...state.milestoneProgress.keys()].some((key) =>
      key.startsWith(`${work.documentId}/`),
    );
    if (template === undefined || sent || work.state === "submitted") return { error: "conflict" };
    state.milestones.set(work.documentId, []);
    for (const item of template.milestones) {
      add(
        state,
        work.documentId,
        {
          id: randomUUID(),
          title: item.title,
          description: "",
          dueAt:
            item.relativeDue === undefined
              ? null
              : new Date(now.getTime() + item.relativeDue * 86_400_000).toISOString(),
          state: "open",
        },
        item.submits,
      );
    }
    return { status: 200, body: planOf(state, work.documentId) };
  },
};
