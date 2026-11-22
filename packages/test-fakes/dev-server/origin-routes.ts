// The composition of a work by kind of origin on the dev fake server
// (work.origin-composition.get, SRV-0910): the owner and the readers of the
// work (readerOf) read the same invented shares, anyone else reads 404. The
// real rules are app.work_origin_composition; the fake records nothing.
import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

/** The invented shares the fake answers, in the order of the closed list. */
export const FAKE_ORIGIN_SHARES = [
  { kind: "typed", percent: 70 },
  { kind: "assistant_inserted", percent: 10 },
  { kind: "assistant_match", percent: 0 },
  { kind: "imported_file", percent: 10 },
  { kind: "pasted_known", percent: 5 },
  { kind: "pasted_unknown", percent: 5 },
] as const;

export const ORIGIN_HANDLERS: Handlers = {
  "work.origin-composition.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    return {
      status: 200,
      body: {
        parts: FAKE_ORIGIN_SHARES.map((share) => ({ ...share })),
      },
    };
  },
};
