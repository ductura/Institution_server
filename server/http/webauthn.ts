// POST /api/v1/auth/webauthn/challenge (S-1E-g, DAN-840-3c; contract
// Ductus#1836 c.6940962622). The handler of the challenge route over the
// WebAuthn credential port (840-3b) and the challenge store (840-2a): token
// before media type, as profile-interface-locale.ts; the body under the
// contract's limit, strict JSON and the contract's closed schema; then the
// port, which is also the check that the session is alive. The registration
// (3d) and assertion (3e) routes join this factory; mounting, the store of the
// process and its TTL follow in 3f. Origin is pipeline step 7.
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { isIP } from "node:net";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import type { WebAuthnCredentials } from "../database/index.ts";
import {
  type ChallengePurpose,
  type ChallengeStore,
  challengeSessionKey,
  liveSessionTokenFromCookie,
} from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const CHALLENGE_ID = "auth.webauthn-challenge.post";
const found = ROUTES.find((route) => route.id === CHALLENGE_ID);
if (found === undefined) throw new Error(`no contract ${CHALLENGE_ID}`);
const challengeContract = found;
function bodySchemaOf(schema: (typeof ROUTES)[number]["request"]["body"]) {
  if (schema === undefined) throw new Error(`no body schema in ${CHALLENGE_ID}`);
  return schema;
}
const challengeBody = bodySchemaOf(found.request.body);

export const WEBAUTHN_CHALLENGE_MAX_BYTES = challengeContract.request.maxBodyBytes ?? 256;
export const WEBAUTHN_BODY_TIMEOUT_MS = 5_000;
/** maxItems of allowCredentials in the contract. */
const MAX_CREDENTIALS = 16;
const USER_HANDLE_BYTES = 16;

export type WebAuthnRouteOptions = {
  readonly credentials: WebAuthnCredentials;
  readonly challenges: ChallengeStore;
  /** appOrigin(): the exact origin of the client data, and the source of rpId. */
  readonly origin: string | null;
  /** What the browser is told; the store's TTL (3f) must be longer. */
  readonly timeoutMs: number;
  /** For tests: fixed bytes of userHandle. */
  readonly randomBytes?: (size: number) => Uint8Array;
  /** For tests: a shorter body deadline. */
  readonly bodyTimeoutMs?: number;
};

/**
 * The rpId of an origin: its host without the port, for https, and for http
 * only on localhost. An IP address is no rpId for a browser, so it is null.
 */
export function webauthnRpId(origin: string | null): string | null {
  if (origin === null) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (host === "" || host.startsWith("[") || isIP(host) !== 0) return null;
  if (url.protocol === "https:") return host;
  return url.protocol === "http:" && host === "localhost" ? host : null;
}

/** Content-Type exactly once, media type application/json. */
function isJson(values: readonly string[] | undefined): boolean {
  return (
    values?.length === 1 && values[0]?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

/** The WebAuthn routes; for now the challenge route only. */
export function createWebAuthnRoutes(options: WebAuthnRouteOptions): Route[] {
  const { credentials, challenges, origin, timeoutMs } = options;
  const random = options.randomBytes ?? nodeRandomBytes;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? WEBAUTHN_BODY_TIMEOUT_MS;
  const rpId = webauthnRpId(origin);
  const unavailable = (response: Parameters<Route["handle"]>[1], error: unknown) => {
    reportServerError("route", error, requestIdOf(response), CHALLENGE_ID);
    sendProblem(response, 503, "unavailable");
  };

  const challengeRoute: Route = {
    contract: challengeContract,
    async handle(request, response) {
      // Refusals before the whole body was read close the connection (refuse).
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      if (!isJson(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const body = await readBodyWithLimit(request, WEBAUTHN_CHALLENGE_MAX_BYTES, bodyTimeoutMs);
      if (!body.ok) return refuse(response, body.status, body.reason);
      const parsed = parseJson(body.bytes);
      if (!parsed.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(challengeBody, parsed.value)) {
        return sendProblem(response, 422, "invalid_input");
      }
      const purpose = (parsed.value as { purpose: ChallengePurpose }).purpose;
      // Defensive: without APP_ORIGIN pipeline step 7 already answers 403.
      if (rpId === null) return unavailable(response, new Error("webauthn: no rpId"));
      let listed: Awaited<ReturnType<WebAuthnCredentials["list"]>>;
      try {
        listed = await credentials.list(token);
      } catch (error) {
        return unavailable(response, error);
      }
      if (listed.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
      if (listed.status !== "listed") return unavailable(response, new Error(listed.reason));
      // For a registration the list only proves a live session.
      if (purpose === "assertion" && listed.credentials.length > MAX_CREDENTIALS) {
        return unavailable(response, new Error("too_many_credentials"));
      }
      const issued = challenges.issue(challengeSessionKey(token), purpose);
      if (issued === null) return unavailable(response, new Error("clock"));
      const common = { purpose, challenge: issued.challenge, rpId, timeoutMs };
      if (purpose === "registration") {
        const userHandle = Buffer.from(random(USER_HANDLE_BYTES)).toString("base64url");
        return sendJson(response, 200, { ...common, userHandle });
      }
      const allowCredentials = listed.credentials.map((c) => c.credentialId.toString("base64url"));
      sendJson(response, 200, { ...common, allowCredentials });
    },
  };

  return [challengeRoute];
}
