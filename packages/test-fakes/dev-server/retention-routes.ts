// SRV-1304 (plan M10.2, M10.7): the administrator's retention dry run in the
// dev fake. Only an institution administrator reads it; every other account
// gets 403. The classes and periods are those of server/domain/retention:
// only the sessions have a period (30 days, execute); every other class is a
// dry run with a null period; hashes and receipts are never counted. The fake
// has no sessions, live views, versions or access log of its own beyond the
// works, so it counts the submitted works' live views and nothing else.
import type { Handlers } from "./server.ts";

type DryRunKey = "live-state" | "versions" | "change-times" | "access-log" | "receipts";
// SRV-ADMIN-3: every null period waits for a decision, except the receipts,
// which are never deleted; no period is made up.
const dryRun = (key: DryRunKey, label: string, candidates: number | null) => ({
  key,
  label,
  retentionDays: null,
  mode: "dry-run" as const,
  candidates,
  lastRunAt: null,
  ...(key === "receipts"
    ? {
        periodStatus: "never_deleted" as const,
        periodStatusKey: "adminSettings.retentionPeriod.neverDeleted" as const,
      }
    : {
        periodStatus: "awaiting_decision" as const,
        periodStatusKey: "adminSettings.retentionPeriod.awaitingDecision" as const,
      }),
});

export const RETENTION_HANDLERS: Handlers = {
  "institution.retention.get": ({ state, account, header, query }) => {
    const site = header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return { error: "forbidden" };
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    const submitted = state.works.filter((work) => work.state === "submitted").length;
    return {
      status: 200,
      body: {
        classes: [
          {
            key: "sessions",
            label: "retention.sessions",
            retentionDays: 30,
            mode: "execute",
            candidates: 0,
            lastRunAt: null,
            periodStatus: "decided",
            periodStatusKey: "adminSettings.retentionPeriod.decided",
          },
          dryRun("live-state", "retention.liveState", submitted),
          dryRun("versions", "retention.versions", 0),
          dryRun("change-times", "retention.changeTimes", null),
          dryRun("access-log", "retention.accessLog", 0),
          dryRun("receipts", "retention.receipts", null),
        ],
      },
    };
  },
};
