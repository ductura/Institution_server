// The thresholds of a faculty on the dev fake server
// (institution.origin-thresholds.get, institution.origin-threshold.put and .delete,
// work.origin-thresholds.get,
// SRV-1111). Only the administrator reads or replaces the thresholds; there are
// none until one is written (no defaults), and the set lives per fake state.
// The comparison is answered to the owner and the readers of a work alike, from
// the invented shares of origin-routes. The real rules are
// app.origin_thresholds_put and app.work_origin_threshold_status.
import { FAKE_ORIGIN_SHARES } from "./origin-routes.ts";
import type { Handlers } from "./server.ts";
import { readerOf, type Account, type State } from "./state.ts";

type Threshold = {
  origin: (typeof FAKE_ORIGIN_SHARES)[number]["kind"];
  thresholdPercent: number;
  strictness: "hard" | "soft";
};

const kept = new WeakMap<State, Threshold[]>();
const isAdmin = (account: Account | null): boolean =>
  account?.roles.includes("institution_admin") ?? false;
const ORDER = FAKE_ORIGIN_SHARES.map((share) => share.kind);

export const FACULTY_THRESHOLD_HANDLERS: Handlers = {
  "institution.origin-thresholds.get": ({ state, account, query }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    return { status: 200, body: { thresholds: kept.get(state) ?? [] } };
  },
  "institution.origin-threshold.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    const origin = ORDER.find((kind) => kind === params.origin);
    if (origin === undefined) return { error: "invalid_input" };
    const next: Threshold = {
      origin,
      thresholdPercent: body.thresholdPercent,
      strictness: body.strictness,
    };
    const before = kept.get(state) ?? [];
    const was = before.find((threshold) => threshold.origin === origin);
    const changed =
      was?.thresholdPercent !== next.thresholdPercent || was?.strictness !== next.strictness;
    kept.set(
      state,
      [...before.filter((threshold) => threshold.origin !== origin), next].sort(
        (a, b) => ORDER.indexOf(a.origin) - ORDER.indexOf(b.origin),
      ),
    );
    return { status: 200, body: { changed } };
  },
  "institution.origin-threshold.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (!isAdmin(account)) return { error: "forbidden" };
    if (!ORDER.some((kind) => kind === params.origin)) return { error: "invalid_input" };
    kept.set(
      state,
      (kept.get(state) ?? []).filter((threshold) => threshold.origin !== params.origin),
    );
    return { status: 204 };
  },
  "work.origin-thresholds.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    const comparison = (kept.get(state) ?? []).map((threshold) => {
      const share = FAKE_ORIGIN_SHARES.find((part) => part.kind === threshold.origin)!.percent;
      const exceeded = share > threshold.thresholdPercent;
      const answer: "in_line" | "for_review" | "exceeded" = !exceeded
        ? "in_line"
        : threshold.strictness === "hard"
          ? "exceeded"
          : "for_review";
      return { origin: threshold.origin, state: answer };
    });
    return { status: 200, body: { comparison } };
  },
};
