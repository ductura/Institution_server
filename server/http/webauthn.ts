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
  verifyRegistration,
} from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

type Contract = (typeof ROUTES)[number];
/** A route's contract with its body schema and limit, read once. */
function routeOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  const schema = contract?.request.body;
  const maxBytes = contract?.request.maxBodyBytes;
  if (contract === undefined || schema === undefined || maxBytes === undefined)
    throw new Error(`no contract body for ${id}`);
  return { contract: contract as Contract, schema, maxBytes };
}
const CHALLENGE = routeOf("auth.webauthn-challenge.post");
const REGISTRATION = routeOf("auth.webauthn-registration.post");

export const WEBAUTHN_CHALLENGE_MAX_BYTES = CHALLENGE.maxBytes;
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
  /** Session activity after a registered key (session/recordActivity over the app withActor). */
  readonly recordActivity: (token: string) => Promise<unknown>;
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

/** The refusals of credentials.add that are the caller's (contract errors of the registration route). */
const REGISTRATION_REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["forbidden", [403, "forbidden"]],
  ["conflict", [409, "conflict"]],
]);

/** Content-Type exactly once, media type application/json. */
function isJson(values: readonly string[] | undefined): boolean {
  return (
    values?.length === 1 && values[0]?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

/**
 * Strict base64url: only the canonical spelling (no length of 1 mod 4, no
 * stray trailing bits), so two texts never give the same bytes. The schema
 * checks the alphabet and at least one character; "A" alone decodes to
 * nothing and is refused here.
 */
export function decodeBase64url(text: string): Buffer | null {
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

type Response = Parameters<Route["handle"]>[1];
type Intro = { token: string; body: Record<string, string> };

/** The WebAuthn routes: challenge and registration; assertion follows in 3e. */
export function createWebAuthnRoutes(options: WebAuthnRouteOptions): Route[] {
  const { credentials, challenges, origin, timeoutMs } = options;
  const random = options.randomBytes ?? nodeRandomBytes;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? WEBAUTHN_BODY_TIMEOUT_MS;
  const rpId = webauthnRpId(origin);
  const unavailable = (response: Response, id: string, error: unknown) => {
    reportServerError("route", error, requestIdOf(response), id);
    sendProblem(response, 503, "unavailable");
  };

  /** Token, media type, body, strict JSON and the route's closed schema; null when answered. */
  async function intro(
    request: Parameters<Route["handle"]>[0],
    response: Response,
    route: typeof CHALLENGE,
  ): Promise<Intro | null> {
    // Refusals before the whole body was read close the connection (refuse).
    const token = liveSessionTokenFromCookie(request.headers.cookie);
    if (token === undefined) return (refuse(response, 401, "unauthorized"), null);
    if (!isJson(request.headersDistinct["content-type"])) {
      return (refuse(response, 415, "unsupported_media_type"), null);
    }
    const body = await readBodyWithLimit(request, route.maxBytes, bodyTimeoutMs);
    if (!body.ok) return (refuse(response, body.status, body.reason), null);
    const parsed = parseJson(body.bytes);
    if (!parsed.ok) return (sendProblem(response, 400, "invalid_json"), null);
    if (!Value.Check(route.schema, parsed.value)) {
      return (sendProblem(response, 422, "invalid_input"), null);
    }
    return { token, body: parsed.value as Record<string, string> };
  }

  const challengeRoute: Route = {
    contract: CHALLENGE.contract,
    async handle(request, response) {
      const read = await intro(request, response, CHALLENGE);
      if (read === null) return;
      const { token } = read;
      const fail = (error: unknown) => unavailable(response, CHALLENGE.contract.id, error);
      const purpose = read.body.purpose as ChallengePurpose;
      // Defensive: without APP_ORIGIN pipeline step 7 already answers 403.
      if (rpId === null) return fail(new Error("webauthn: no rpId"));
      let listed: Awaited<ReturnType<WebAuthnCredentials["list"]>>;
      try {
        listed = await credentials.list(token);
      } catch (error) {
        return fail(error);
      }
      if (listed.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
      if (listed.status !== "listed") return fail(new Error(listed.reason));
      // For a registration the list only proves a live session.
      if (purpose === "assertion" && listed.credentials.length > MAX_CREDENTIALS) {
        return fail(new Error("too_many_credentials"));
      }
      const issued = challenges.issue(challengeSessionKey(token), purpose);
      if (issued === null) return fail(new Error("clock"));
      const common = { purpose, challenge: issued.challenge, rpId, timeoutMs };
      if (purpose === "registration") {
        const userHandle = Buffer.from(random(USER_HANDLE_BYTES)).toString("base64url");
        return sendJson(response, 200, { ...common, userHandle });
      }
      const allowCredentials = listed.credentials.map((c) => c.credentialId.toString("base64url"));
      sendJson(response, 200, { ...common, allowCredentials });
    },
  };

  const registrationRoute: Route = {
    contract: REGISTRATION.contract,
    async handle(request, response) {
      const read = await intro(request, response, REGISTRATION);
      if (read === null) return;
      const { token, body } = read;
      const fail = (error: unknown) => unavailable(response, REGISTRATION.contract.id, error);
      const clientDataJSON = decodeBase64url(body.clientDataJSON ?? "");
      const authenticatorData = decodeBase64url(body.authenticatorData ?? "");
      const credentialId = decodeBase64url(body.credentialId ?? "");
      if (clientDataJSON === null || authenticatorData === null || credentialId === null) {
        return sendProblem(response, 422, "invalid_input");
      }
      // Defensive, as in the challenge route; the challenge is not taken.
      if (rpId === null || origin === null) return fail(new Error("webauthn: no rpId"));
      const key = challengeSessionKey(token);
      // 2c takes the challenge exactly once, before it reads the client data.
      const checked = verifyRegistration(
        { clientDataJSON, authenticatorData, credentialId },
        { origin, rpId },
        (challenge) => challenges.take(key, "registration", challenge),
      );
      if (!checked.ok) return sendProblem(response, 400, checked.code);
      let added: Awaited<ReturnType<WebAuthnCredentials["add"]>>;
      try {
        const { credentialId: id, publicKey, signCount } = checked;
        added = await credentials.add(token, { credentialId: id, publicKey, signCount });
      } catch (error) {
        return fail(error);
      }
      if (added.status === "added") {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        // Only a registered key counts; a failure costs only the touch, thrown or rejected.
        try {
          await options.recordActivity(token);
        } catch {
          // Activity is best effort.
        }
        return;
      }
      const refused = REGISTRATION_REFUSALS.get(added.status);
      if (refused !== undefined) return sendProblem(response, ...refused);
      // invalid after a passed 2c check means 2c and the table disagree: a fault, not a bad request.
      fail(new Error(added.status === "unavailable" ? added.reason : "add_invalid"));
    },
  };

  return [challengeRoute, registrationRoute];
}
