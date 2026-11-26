// SRV-F4-PM2-R15 on the dev fake server: the plan of a work behind the panel
// "Struktura" (work.plan.get, work.plan.put). Invented data only. The real rules
// are the RPCs of 20261220210000: the plan is the owner's alone (anyone else,
// the mentor and the teachers included, reads 404), it is written whole, a block
// id and a term (case aside) appear once (422 otherwise), and a plan with no
// question, no purpose and no term is not kept.
import type { Handlers } from "./server.ts";
import { owned } from "./mentorship-follow-routes.ts";
import type { State } from "./state.ts";

type Plan = {
  question: string | null;
  purposes: { nodeId: string; purpose: string }[];
  terms: { term: string; definition: string; kind: "term" | "abbreviation" }[];
  updatedAt: string;
};

/** What each fake state keeps, by work. */
const PLANS = new WeakMap<State, Map<string, Plan>>();

function plansOf(state: State): Map<string, Plan> {
  let all = PLANS.get(state);
  if (all === undefined) PLANS.set(state, (all = new Map()));
  return all;
}

const NONE = { question: null, purposes: [], terms: [], updatedAt: null };

function repeated(values: readonly string[]): boolean {
  return new Set(values.map((v) => v.toLowerCase())).size !== values.length;
}

export const WORK_PLAN_HANDLERS: Handlers = {
  "work.plan.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    return { status: 200, body: plansOf(state).get(params.documentId) ?? NONE };
  },
  "work.plan.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    const plan = body as Omit<Plan, "updatedAt">;
    if (repeated(plan.purposes.map((p) => p.nodeId)) || repeated(plan.terms.map((t) => t.term))) {
      return { error: "invalid_input" };
    }
    if (plan.question === null && plan.purposes.length === 0 && plan.terms.length === 0) {
      plansOf(state).delete(params.documentId);
      return { status: 200, body: NONE };
    }
    const kept: Plan = { ...plan, updatedAt: now.toISOString() };
    plansOf(state).set(params.documentId, kept);
    return { status: 200, body: kept };
  },
};
