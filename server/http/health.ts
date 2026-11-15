// Liveness (port of Ductus app/api/health/route.ts at d52a92c3, DAN-299): the
// process answers. It reads no database, no session and no environment, and
// says nothing about the build or the host, so it is safe without a login.
// Readiness is a separate route (S-1M-a).
import { ROUTES } from "../contracts/index.ts";
import { type Route, sendJson } from "./router.ts";

const HEALTH_ID = "platform.health.get";
const contract = ROUTES.find((route) => route.id === HEALTH_ID);
if (contract === undefined) throw new Error(`no contract ${HEALTH_ID}`);

export const HEALTH_ROUTE: Route = {
  contract,
  handle: async (_request, response) => sendJson(response, 200, { status: "ok" }),
};
