// SRV-1906 (plan P-D6): the operator's pilot numbers in the dev fake. The fake
// has no operator list and no second factor (step 8 of the real server), so
// the administrator account stands in for the operator; every other account
// gets 403. Counts come from the invented works and keep the real rule: a
// count from 1 to 4, or one derivable from the published ones, is null, and a
// shown count is rounded down to a multiple of five.
import type { Handlers } from "./server.ts";

const MIN_GROUP = 5;
const shown = (count: number): 0 | number | null =>
  count > 0 && count < MIN_GROUP ? null : count - (count % MIN_GROUP);

export const OPS_HANDLERS: Handlers = {
  "ops.pilot-metrics.get": ({ state, account, header, query, now }) => {
    const site = header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return { error: "forbidden" };
    if (account === null) return { error: "unauthenticated" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    const recorded = state.works.filter(
      (work) =>
        work.state === "submitted" &&
        work.submittedAt !== null &&
        new Date(work.submittedAt) < midnight,
    ).length;
    return {
      status: 200,
      body: {
        asOf: midnight.toISOString(),
        minimumGroup: MIN_GROUP,
        submissions: { recorded: shown(recorded), notRecorded: 0 },
        // The fake signs every receipt at once: none is pending.
        receipts: { issued: shown(recorded), pending: 0 },
        helpRequests: { total: 0, saveProblems: 0 },
        receiptTime:
          recorded >= MIN_GROUP ? { p50Ms: 1200, p95Ms: 2500 } : { p50Ms: null, p95Ms: null },
      },
    };
  },
};
