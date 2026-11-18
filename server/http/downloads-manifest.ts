// GET /api/v1/downloads/manifest (DAN-932, S-1H.5-b; contract DAN-931,
// UGOVOR Ductus#2028 c.6968257133). The desktop packages a client may offer,
// before any login (D-300): the route never reads a session or a body. The
// manifest service (server/downloads) answers the release configuration
// whole or refuses it; a refusal is 503 unavailable, logged by its code,
// never by a value of the configuration. server/server.ts mounts it over the
// release configuration built into the server.
import { ROUTES } from "../contracts/index.ts";
import { createDownloadsService } from "../downloads/index.ts";

import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "downloads.manifest.get");
  if (found === undefined) throw new Error("no contract downloads.manifest.get");
  return found;
})();

/** The manifest route over a reader of the release configuration (the built-in one by default). */
export function createDownloadsManifestRoute(releases?: () => unknown): Route {
  const service = createDownloadsService(releases === undefined ? {} : { releases });
  return {
    contract: CONTRACT,
    async handle(_request, response) {
      const manifest = service.manifest();
      if (manifest.ok) return sendJson(response, 200, manifest.value);
      try {
        console.error(
          JSON.stringify({
            event: "downloads_manifest_refused",
            route: CONTRACT.id,
            code: manifest.error.code,
            requestId: requestIdOf(response),
          }),
        );
      } catch {
        // A broken stderr must not turn the 503 into a crash.
      }
      sendProblem(response, 503, "unavailable");
    },
  };
}
