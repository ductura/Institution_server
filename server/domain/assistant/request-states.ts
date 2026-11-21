/**
 * States of an AI assistant request and the closed table of transitions
 * (Ductus docs/contracts/ai-request-v1.md, "Stanja"; plan #1662 R1).
 *
 * The "received" phase is the route check before the transaction and makes
 * no row, so it is not a state here. A row starts as `reserved` or
 * `rejected`; every pair outside TRANSITIONS is refused and the row stays as
 * it was. Pure data: the database enforces the same table in step 3.
 */

export const REQUEST_STATES = Object.freeze([
  "reserved",
  "sent",
  "completed",
  "provider_failed",
  "outcome_unknown",
  "settled",
  "rejected",
] as const);
export type RequestState = (typeof REQUEST_STATES)[number];

/** Who moves a request: the RPC that writes it, or the worker's sweep. */
export type TransitionActor =
  | "begin_request"
  | "mark_sent"
  | "complete_request"
  | "fail_request"
  | "mark_outcome_unknown"
  | "sweep";

export type Transition = {
  readonly from: RequestState | null;
  readonly to: RequestState;
  readonly by: readonly TransitionActor[];
};

/** The whole table; `from: null` is the row that does not exist yet. */
export const TRANSITIONS: readonly Transition[] = Object.freeze(
  [
    { from: null, to: "rejected", by: ["begin_request"] },
    { from: null, to: "reserved", by: ["begin_request"] },
    { from: "reserved", to: "sent", by: ["mark_sent"] },
    { from: "reserved", to: "rejected", by: ["mark_sent", "sweep"] },
    { from: "sent", to: "completed", by: ["complete_request"] },
    { from: "sent", to: "provider_failed", by: ["fail_request"] },
    { from: "sent", to: "outcome_unknown", by: ["mark_outcome_unknown", "sweep"] },
    { from: "outcome_unknown", to: "settled", by: ["sweep"] },
  ].map((row) => Object.freeze({ ...row, by: Object.freeze(row.by) }) as Transition),
);

/** States no transition leaves. */
export const FINAL_REQUEST_STATES: readonly RequestState[] = Object.freeze([
  "rejected",
  "completed",
  "provider_failed",
  "settled",
]);

export function isRequestState(value: unknown): value is RequestState {
  return typeof value === "string" && (REQUEST_STATES as readonly string[]).includes(value);
}

export type RequestTransitionResult =
  | { readonly ok: true; readonly from: RequestState | null; readonly to: RequestState }
  | { readonly ok: false; readonly reason: "unknown_state" | "not_allowed" };

/**
 * Whether `by` may move a request from `from` to `to`. Unknown states, a
 * missing actor and every pair outside the table are refused.
 */
export function transitionRequest(
  from: unknown,
  to: unknown,
  by: TransitionActor,
): RequestTransitionResult {
  if ((from !== null && !isRequestState(from)) || !isRequestState(to)) {
    return { ok: false, reason: "unknown_state" };
  }
  const row = TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (row === undefined || !row.by.includes(by)) return { ok: false, reason: "not_allowed" };
  return { ok: true, from, to };
}
