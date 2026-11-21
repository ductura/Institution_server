import { describe, expect, it } from "vitest";

import {
  FINAL_REQUEST_STATES,
  REQUEST_STATES,
  TRANSITIONS,
  type TransitionActor,
  isRequestState,
  transitionRequest,
} from "./request-states.ts";

const ACTORS: readonly TransitionActor[] = [
  "begin_request",
  "mark_sent",
  "complete_request",
  "fail_request",
  "mark_outcome_unknown",
  "sweep",
];

// The table of ai-request-v1.md "Stanja", written out again here so a change
// to TRANSITIONS has to change this list too.
const ALLOWED = new Set([
  "∅>rejected:begin_request",
  "∅>reserved:begin_request",
  "reserved>sent:mark_sent",
  "reserved>rejected:mark_sent",
  "reserved>rejected:sweep",
  "sent>completed:complete_request",
  "sent>provider_failed:fail_request",
  "sent>outcome_unknown:mark_outcome_unknown",
  "sent>outcome_unknown:sweep",
  "outcome_unknown>settled:sweep",
]);

describe("request states (R1)", () => {
  it("is the closed set of the contract", () => {
    expect(REQUEST_STATES).toEqual([
      "reserved",
      "sent",
      "completed",
      "provider_failed",
      "outcome_unknown",
      "settled",
      "rejected",
    ]);
    expect(Object.isFrozen(REQUEST_STATES)).toBe(true);
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    for (const row of TRANSITIONS)
      expect(Object.isFrozen(row) && Object.isFrozen(row.by)).toBe(true);
  });

  it("allows exactly the pairs in the table and refuses every other (from, to, actor)", () => {
    const froms = [null, ...REQUEST_STATES];
    let checked = 0;
    for (const from of froms)
      for (const to of REQUEST_STATES)
        for (const by of ACTORS) {
          const key = `${from ?? "∅"}>${to}:${by}`;
          const result = transitionRequest(from, to, by);
          expect(result.ok, key).toBe(ALLOWED.has(key));
          if (!result.ok) expect(result.reason, key).toBe("not_allowed");
          checked += 1;
        }
    expect(checked).toBe(8 * 7 * 6);
  });

  it("leaves no final state, and no state returns to itself", () => {
    expect(FINAL_REQUEST_STATES).toEqual(["rejected", "completed", "provider_failed", "settled"]);
    for (const from of FINAL_REQUEST_STATES)
      expect(TRANSITIONS.filter((t) => t.from === from)).toEqual([]);
    for (const t of TRANSITIONS) expect(t.from).not.toBe(t.to);
  });

  it("a late answer after outcome_unknown cannot complete the request (R7)", () => {
    expect(transitionRequest("outcome_unknown", "completed", "complete_request")).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(transitionRequest("outcome_unknown", "provider_failed", "fail_request").ok).toBe(false);
  });

  it("refuses unknown states without throwing", () => {
    for (const [from, to] of [
      ["received", "reserved"],
      ["reserved", "done"],
      [undefined, "reserved"],
      ["RESERVED", "sent"],
      [1, "sent"],
    ] as const)
      expect(transitionRequest(from, to, "mark_sent")).toEqual({
        ok: false,
        reason: "unknown_state",
      });
    expect(isRequestState("sent")).toBe(true);
    expect(isRequestState("constructor")).toBe(false);
  });
});
