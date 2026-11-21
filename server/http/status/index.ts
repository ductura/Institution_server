import { ROUTES } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";

import { type ReadyReport, type Route, sendBareRefusal, sendJson, singleFlight } from "../index.ts";

const found = ROUTES.find((route) => route.id === "platform.status.get");
if (found === undefined) throw new Error("no contract platform.status.get");
const contract = found;

const STATUS_TTL_MS = 15_000;
const MAINTENANCE_TIMEOUT_MS = 1_000;
type Window = { startsAt: Date; endsAt: Date };
type Options = {
  check: () => Promise<ReadyReport>;
  draining: () => boolean;
  readWindows: () => Promise<readonly Window[]>;
};

function availability(...states: ReadyReport["capabilities"]["database"][]) {
  if (states.some((state) => state !== "ok" && state !== "nije_konfigurirano")) return "ne_radi";
  return states.includes("nije_konfigurirano") ? "nije_ukljuceno" : "radi";
}

export function createStatusRoute({ check, draining, readWindows }: Options): Route {
  // A read that outlives the HTTP deadline retains its slot until it settles.
  const read = singleFlight(async () =>
    (await readWindows()).map(({ startsAt, endsAt }) => ({
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    })),
  );
  const refresh = async () => {
    const checkedAt = new Date().toISOString();
    const { database, storage, signing } = (await check()).capabilities;
    const body = {
      checkedAt,
      components: {
        writing: availability(database, storage, signing),
        submission: availability(database, storage, signing),
        mentorView: availability(database, storage),
      },
    };
    if (database !== "ok" || draining()) return body;

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, MAINTENANCE_TIMEOUT_MS, undefined);
      timer.unref();
    });
    try {
      const maintenanceWindows = await Promise.race([read(), deadline]);
      return maintenanceWindows === undefined ? body : { ...body, maintenanceWindows };
    } catch {
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
  let cached: { body: Awaited<ReturnType<typeof refresh>>; until: number } | undefined;
  const load = singleFlight(async () => {
    const body = await refresh();
    cached = { body, until: performance.now() + STATUS_TTL_MS };
    return body;
  });

  return {
    contract,
    async handle(_request, response) {
      try {
        if (!draining()) {
          const body = cached && cached.until > performance.now() ? cached.body : await load();
          if (!draining()) return sendJson(response, 200, body);
        }
      } catch {
        // A failed readiness check has no public diagnostics.
      }
      sendBareRefusal(response, contract, 503);
    },
  };
}

export function createStatusRouteFor(
  { withActor }: { withActor: WithActor },
  check: Options["check"],
  draining: Options["draining"],
): Route {
  return createStatusRoute({
    check,
    draining,
    readWindows: () =>
      withActor(null, async (tx) => {
        await tx.query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [
          `${MAINTENANCE_TIMEOUT_MS}ms`,
        ]);
        const { rows } = await tx.query<Window>(
          `SELECT starts_at AS "startsAt", ends_at AS "endsAt"
           FROM identity.public_maintenance_windows() ORDER BY starts_at, ends_at`,
        );
        return rows;
      }),
  });
}
