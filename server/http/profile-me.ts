// GET /api/v1/me (contract Ductus#2028 c.6993786629 §3.3): the front of the
// institution reads the signed-in account after the AAI@EduHr login; on 401 it
// sends the browser to /api/v1/auth/login. The account comes from the session
// token inside app.my_account(), never from a parameter. As the interface
// language GET: one well-formed live session cookie, and Sec-Fetch-Site, when
// sent, must be same-origin (the pipeline checks only state-changing methods).
import { ROUTES } from "../contracts/index.ts";
import { createMyAccountReader, type MyAccountReader } from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const CONTRACT = (() => {
  const found = ROUTES.find((route) => route.id === "profile.me.get");
  if (found === undefined) throw new Error("no contract profile.me.get");
  return found;
})();

export function createMeRoute(read: MyAccountReader): Route {
  return {
    contract: CONTRACT,
    async handle(request, response) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      try {
        const account = await read(token);
        if (!account.ok) return sendProblem(response, 401, "unauthorized");
        sendJson(response, 200, account.value);
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The route over main's application withActor. */
export function createMeRouteFor(main: Pick<Databases["main"], "withActor">): Route {
  return createMeRoute(createMyAccountReader(main.withActor));
}
