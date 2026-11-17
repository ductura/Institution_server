// GET and POST /api/v1/profile/interface-locale (DAN-851-1d1; contract
// Ductus#1836 c.6938624974). Port of the HTTP edge of Ductus
// handleInterfaceLocaleGet/Post (src/server/profile/interface-locale-route.ts)
// and app/api/profile/interface-locale/route.ts at 51a062e, over the profile
// service (server/profile). The token is Ductus liveSessionToken: one
// well-formed session cookie, and a session this browser ended reads as none.
// GET checks Sec-Fetch-Site itself (the pipeline skips safe methods); POST's
// Origin is pipeline step 7. The token comes before the media type, as in
// Ductus. An accepted save counts as session activity (Ductus counted(post)).
// Mounting and the production port follow in 851-1d2.
import { ROUTES } from "../contracts/index.ts";
import type { InterfaceLocaleStore } from "../database/index.ts";
import { createProfileService } from "../profile/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

function contractOf(id: string) {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
}
const GET_CONTRACT = contractOf("profile.interface-locale.get");
const POST_CONTRACT = contractOf("profile.interface-locale.post");

export const INTERFACE_LOCALE_MAX_BYTES = POST_CONTRACT.request.maxBodyBytes ?? 256;
export const INTERFACE_LOCALE_TIMEOUT_MS = 5_000;

export type InterfaceLocaleRouteOptions = {
  readonly store: InterfaceLocaleStore;
  /** Session activity for an accepted save (session/recordActivity over the app withActor). */
  readonly recordActivity: (token: string) => Promise<unknown>;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** The contract error of each closed code; any other code is 503 unavailable. */
const ERRORS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["INTERFACE_LOCALE_INVALID_JSON", [400, "invalid_json"]],
  ["INTERFACE_LOCALE_INVALID_BODY", [422, "invalid_input"]],
  ["INTERFACE_LOCALE_INVALID", [422, "invalid_input"]],
  ["INTERFACE_LOCALE_UNAUTHENTICATED", [401, "unauthorized"]],
]);

/** Content-Type exactly once, media type application/json. */
function isJson(values: readonly string[] | undefined): boolean {
  return (
    values?.length === 1 && values[0]?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

/** GET and POST of the interface language over the profile service. */
export function createInterfaceLocaleRoutes(options: InterfaceLocaleRouteOptions): Route[] {
  const service = createProfileService({ store: options.store });
  const timeoutMs = options.timeoutMs ?? INTERFACE_LOCALE_TIMEOUT_MS;
  const answerError = (response: Parameters<Route["handle"]>[1], code: string) => {
    const [status, contract] = ERRORS.get(code) ?? [503, "unavailable"];
    sendProblem(response, status, contract);
  };

  const getRoute: Route = {
    contract: GET_CONTRACT,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const read = await service.readInterfaceLocale(token);
        if (!read.ok) return answerError(response, read.error.code);
        sendJson(response, 200, { locale: read.value });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), GET_CONTRACT.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };

  const postRoute: Route = {
    contract: POST_CONTRACT,
    async handle(request, response) {
      // Refusals before the whole body was read close the connection (refuse).
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      if (!isJson(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const body = await readBodyWithLimit(request, INTERFACE_LOCALE_MAX_BYTES, timeoutMs);
      if (!body.ok) return refuse(response, body.status, body.reason);
      try {
        const saved = await service.saveInterfaceLocale(token, body.bytes);
        if (!saved.ok) return answerError(response, saved.error.code);
        sendJson(response, 200, { locale: saved.value });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), POST_CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
      // Only an accepted save counts, once its answer is written; a failure costs only the touch.
      await options.recordActivity(token).catch(() => undefined);
    },
  };

  return [getRoute, postRoute];
}
