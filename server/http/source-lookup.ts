import { Value } from "@sinclair/typebox/value";

import { sourceLookupPost } from "../contracts/index.ts";
import { createMyAccountReader } from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";
import { createSourceLookup, parseSourceIdentifier } from "../source-lookup/index.ts";

import type { Databases } from "./databases.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const BODY_TIMEOUT_MS = 5000;
const CONTACT = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u;

export function createSourceLookupRouteFor(
  main: Pick<Databases["main"], "withActor">,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): Route {
  // D-201, D-232: only the local fake identity can use these catalogues until DPIA.
  const contact = env.SOURCE_LOOKUP_CONTACT;
  const enabled =
    env.NODE_ENV === "development" &&
    env.DUCTUS_AUTH_PROVIDER === "fake-oidc" &&
    contact !== undefined &&
    contact.length <= 254 &&
    CONTACT.test(contact);
  const lookup = enabled ? createSourceLookup(contact, { fetcher }) : undefined;
  const readAccount = createMyAccountReader(main.withActor);
  return {
    contract: sourceLookupPost,
    async handle(request, response) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const media = request.headersDistinct["content-type"];
      if (
        media?.length !== 1 ||
        media[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const { body, maxBodyBytes } = sourceLookupPost.request;
      const raw = await readBodyWithLimit(request, maxBodyBytes, BODY_TIMEOUT_MS);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const parsed = parseJson(raw.bytes);
      if (!parsed.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(body, parsed.value)) return sendProblem(response, 422, "invalid_input");
      const identifier = parseSourceIdentifier(parsed.value.kind, parsed.value.identifier);
      if (identifier === null) return sendProblem(response, 422, "invalid_input");

      const account = await readAccount(token).catch(() => null);
      if (account === null) return sendProblem(response, 503, "unavailable");
      if (!account.ok) return sendProblem(response, 401, "unauthorized");
      if (lookup === undefined) return sendProblem(response, 503, "unavailable");
      if (
        account.value.institution.slug !== "demo-fakultet" ||
        !account.value.roles.includes("student")
      ) {
        return sendProblem(response, 403, "forbidden");
      }

      const result = await lookup(identifier);
      switch (result.kind) {
        case "found":
          return sendJson(response, 200, { source: result.source });
        case "missing":
          return sendJson(response, 200, { source: null });
        case "limited":
          response.setHeader("Retry-After", String(result.retryAfter));
          return sendProblem(response, 429, "too_many_requests");
        case "timeout":
          return sendProblem(response, 503, "timeout");
        case "unavailable":
          return sendProblem(response, 503, "unavailable");
      }
    },
  };
}
