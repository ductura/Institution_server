// Provisioning of an institution instance (contract Ductus#2028 c.6993786629
// §2, slot w1111a): Aplication_server sends an institution to this server,
// server to server; the browser never does (the edge proxy forwards only
// /api/v1/* here).
//
//   POST /internal/v1/institutions          201 created, 200 the same data again,
//                                           409 {greska}, 400 {greska, polje}, 401
//   GET  /internal/v1/institutions/{slug}   200 the instance, 404, 401
//
// Authorization: Bearer DUCTURA_PROVISIONING_TOKEN, a shared secret of at
// least 32 characters from the environment, never from the repository. Both
// sides are hashed and compared with timingSafeEqual, so neither the content
// nor the length of a wrong token changes the time of the comparison. Without
// a valid token in the environment both routes answer 404, as an unknown path.
//
// The routes are not in ROUTES (server/contracts): they are not part of the
// public /api/v1 contract and never reach its OpenAPI or client. Their
// contracts below serve the router and the refusal writer only. The pipeline
// lets them through without Origin (originLayer, INTERNAL_PATH_PREFIX): no
// cookie is read, the bearer token is the proof.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Type } from "@sinclair/typebox";

import { FALLBACK, type ErrorSpec, type RouteContract } from "../contracts/index.ts";
import {
  institutionProvisioning,
  type InstitutionProvisioning,
  type InstitutionProvisionInput,
  type InstitutionSeats,
  type ProvisionedInstitution,
} from "../database/index.ts";
import { accountIssuer } from "../external/srce-auth/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { INTERNAL_PATH_PREFIX, readBodyWithLimit } from "./mutation-request.ts";
import { sendInternalRefusal, sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";

export { INTERNAL_PATH_PREFIX };
export const PROVISIONING_TOKEN_VARIABLE = "DUCTURA_PROVISIONING_TOKEN";
export const PROVISIONING_TOKEN_MIN_LENGTH = 32;
/** §2: the body is at most 4 KB. */
export const PROVISIONING_MAX_BODY_BYTES = 4096;
export const PROVISIONING_BODY_TIMEOUT_MS = 5_000;
/** The column rule of identity.institution_seat.seats. */
export const MAX_SEATS = 1_000_000;

const SEAT_ROLES = ["student", "teacher", "network_engineer", "institution_admin"] as const;
const FIELDS = ["slug", "displayName", "aaiHomeOrg", "oidcIssuer", "seats"] as const;
/** The `identity.institution.slug` CHECK, matched exactly. */
const SLUG_RE = /^[a-z0-9-]{2,32}$/u;
/** The `identity.institution.aai_home_org` CHECK: a lower-case DNS name with a dot. */
const HOME_ORG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u;
/** The `identity.institution_issuer.oidc_issuer` CHECK. */
const ISSUER_RE = /^https?:\/\/[!-~]+$/u;
/** A C0 or C1 control; the database's is_plain_label refuses more (ZD422). */
const hasControl = (text: string): boolean =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

const Seats = Type.Object(
  Object.fromEntries(SEAT_ROLES.map((role) => [role, Type.Integer()])) as Record<
    (typeof SEAT_ROLES)[number],
    ReturnType<typeof Type.Integer>
  >,
  { additionalProperties: false },
);
const Created = Type.Object(
  { institutionId: Type.String(), slug: Type.String(), status: Type.Literal("aktivna") },
  { additionalProperties: false },
);
const refusal = (status: number, code: string, polje = false): ErrorSpec => ({
  status,
  code,
  key: "",
  body: Type.Object(
    polje ? { greska: Type.Literal(code), polje: Type.String() } : { greska: Type.Literal(code) },
    { additionalProperties: false },
  ),
});
const bare = (status: number, code: string): ErrorSpec => ({ status, code, key: "", body: "none" });

export const INTERNAL_INSTITUTIONS_POST: RouteContract = {
  id: "internal.institutions.post",
  method: "POST",
  path: "/internal/v1/institutions",
  inventory: "Ductus#2028 c.6993786629 §2",
  access: "anyone",
  summary: "Aplication_server provisions an institution instance (bearer token, server to server).",
  request: { contentType: "application/json", maxBodyBytes: PROVISIONING_MAX_BODY_BYTES },
  responses: [
    { status: 201, description: "created", body: Created },
    { status: 200, description: "the same data again", body: Created },
  ],
  errors: [
    refusal(400, "neispravan_unos", true),
    bare(401, "unauthorized"),
    refusal(409, "slug_zauzet"),
    refusal(409, "domena_zauzeta"),
    bare(503, "unavailable"),
  ],
};

export const INTERNAL_INSTITUTION_GET: RouteContract = {
  id: "internal.institution.get",
  method: "GET",
  path: "/internal/v1/institutions/{slug}",
  inventory: "Ductus#2028 c.6993786629 §2",
  access: "anyone",
  summary: "The provisioned institution of a slug (bearer token, server to server).",
  request: { params: Type.Object({ slug: Type.String() }, { additionalProperties: false }) },
  responses: [
    {
      status: 200,
      description: "the instance",
      body: Type.Object(
        {
          institutionId: Type.String(),
          slug: Type.String(),
          displayName: Type.String(),
          aaiHomeOrg: Type.String(),
          oidcIssuer: Type.String(),
          seats: Seats,
          status: Type.Literal("aktivna"),
        },
        { additionalProperties: false },
      ),
    },
  ],
  errors: [bare(401, "unauthorized"), bare(404, "not_found"), bare(503, "unavailable")],
};

/** The token of the environment, or null when provisioning is off (unset or too short). */
export function provisioningToken(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const value = env[PROVISIONING_TOKEN_VARIABLE];
  return value !== undefined && value.length >= PROVISIONING_TOKEN_MIN_LENGTH ? value : null;
}

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** True when the request carries exactly one `Authorization: Bearer <token>` equal to `expected`. */
export function bearerMatches(request: IncomingMessage, expected: Buffer): boolean {
  const values = request.headersDistinct.authorization;
  const sent = values?.length === 1 ? /^Bearer ([!-~]+)$/u.exec(values[0] ?? "")?.[1] : undefined;
  // Hashed either way, so a missing header costs the same comparison.
  return timingSafeEqual(digest(sent ?? ""), expected) && sent !== undefined;
}

type Field = (typeof FIELDS)[number] | "tijelo" | `seats.${(typeof SEAT_ROLES)[number]}`;
type Checked = { ok: true; value: InstitutionProvisionInput } | { ok: false; polje: Field };

/** The own data value of `key` of a plain object, or undefined for a getter or a missing key. */
function own(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}
const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The body of §2, checked field by field in the order of the contract. An
 * unknown field is refused by its own name; a missing or wrong one by its
 * name; a body that is not one JSON object as `tijelo`.
 */
export function checkProvisionBody(parsed: unknown): Checked {
  if (!isObject(parsed)) return { ok: false, polje: "tijelo" };
  for (const key of Reflect.ownKeys(parsed)) {
    if (typeof key !== "string" || !(FIELDS as readonly string[]).includes(key)) {
      return { ok: false, polje: typeof key === "string" ? (key as Field) : "tijelo" };
    }
  }
  const slug = own(parsed, "slug");
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return { ok: false, polje: "slug" };
  const displayName = own(parsed, "displayName");
  if (
    typeof displayName !== "string" ||
    displayName.trim() === "" ||
    [...displayName].length > 200 ||
    hasControl(displayName)
  ) {
    return { ok: false, polje: "displayName" };
  }
  const aaiHomeOrg = own(parsed, "aaiHomeOrg");
  if (typeof aaiHomeOrg !== "string" || aaiHomeOrg.length > 253 || !HOME_ORG_RE.test(aaiHomeOrg)) {
    return { ok: false, polje: "aaiHomeOrg" };
  }
  const oidcIssuer = own(parsed, "oidcIssuer");
  // One spelling, the one the login stores (accountIssuer), so open_session
  // compares equal strings.
  if (
    typeof oidcIssuer !== "string" ||
    oidcIssuer.length > 255 ||
    !ISSUER_RE.test(oidcIssuer) ||
    !URL.canParse(oidcIssuer) ||
    accountIssuer(new URL(oidcIssuer)) !== oidcIssuer
  ) {
    return { ok: false, polje: "oidcIssuer" };
  }
  const seats = own(parsed, "seats");
  if (!isObject(seats)) return { ok: false, polje: "seats" };
  const keys = Reflect.ownKeys(seats);
  for (const key of keys) {
    if (typeof key !== "string" || !(SEAT_ROLES as readonly string[]).includes(key)) {
      return { ok: false, polje: "seats" };
    }
  }
  const counts: Partial<Record<(typeof SEAT_ROLES)[number], number>> = {};
  for (const role of SEAT_ROLES) {
    const count = own(seats, role);
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > MAX_SEATS) {
      return { ok: false, polje: `seats.${role}` };
    }
    counts[role] = count as number;
  }
  return {
    ok: true,
    value: { slug, displayName, aaiHomeOrg, oidcIssuer, seats: counts as InstitutionSeats },
  };
}

/** Content-Type exactly once, media type application/json. */
function isJson(values: readonly string[] | undefined): boolean {
  return (
    values?.length === 1 && values[0]?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

function instanceOf(found: ProvisionedInstitution) {
  return { ...found, status: "aktivna" as const };
}

export type InternalInstitutionRouteOptions = {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** For tests: the port over a login of their own. Default: the ductus_auth pool. */
  readonly provisioning?: InstitutionProvisioning;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** POST and GET of an institution instance; both 404 while provisioning is off. */
export function createInternalInstitutionRoutes(options: InternalInstitutionRouteOptions): Route[] {
  const token = provisioningToken(options.env);
  const expected = token === null ? null : digest(token);
  const port = options.provisioning ?? institutionProvisioning;
  const timeoutMs = options.timeoutMs ?? PROVISIONING_BODY_TIMEOUT_MS;

  /** False when the route has answered: off (404) or without the token (401). */
  const admitted = (
    request: IncomingMessage,
    response: ServerResponse,
    contract: RouteContract,
  ) => {
    if (expected === null) {
      sendProblem(response, FALLBACK.error.status, FALLBACK.error.code);
      return false;
    }
    if (!bearerMatches(request, expected)) {
      sendInternalRefusal(response, contract, 401);
      return false;
    }
    return true;
  };

  const post: Route = {
    contract: INTERNAL_INSTITUTIONS_POST,
    async handle(request, response) {
      const contract = INTERNAL_INSTITUTIONS_POST;
      if (!admitted(request, response, contract)) return;
      const invalid = (polje: Field) =>
        sendInternalRefusal(response, contract, 400, { greska: "neispravan_unos", polje });
      if (!isJson(request.headersDistinct["content-type"])) {
        response.setHeader("Connection", "close");
        return invalid("tijelo");
      }
      const body = await readBodyWithLimit(request, PROVISIONING_MAX_BODY_BYTES, timeoutMs);
      if (!body.ok) {
        response.setHeader("Connection", "close");
        return invalid("tijelo");
      }
      const parsed = parseJson(body.bytes);
      if (!parsed.ok) return invalid("tijelo");
      const checked = checkProvisionBody(parsed.value);
      if (!checked.ok) return invalid(checked.polje);
      try {
        const result = await port.provision(checked.value);
        switch (result.outcome) {
          case "created":
          case "existing":
            return sendJson(response, result.outcome === "created" ? 201 : 200, {
              institutionId: result.institutionId,
              slug: checked.value.slug,
              status: "aktivna",
            });
          case "slug_taken":
            return sendInternalRefusal(response, contract, 409, { greska: "slug_zauzet" });
          case "domain_taken":
            return sendInternalRefusal(response, contract, 409, { greska: "domena_zauzeta" });
          case "invalid":
            // Every field but the display name passed the column rules above;
            // is_plain_label is the one rule only the database holds.
            return invalid("displayName");
        }
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendInternalRefusal(response, contract, 503);
      }
    },
  };

  const get: Route = {
    contract: INTERNAL_INSTITUTION_GET,
    async handle(request, response, params) {
      const contract = INTERNAL_INSTITUTION_GET;
      if (!admitted(request, response, contract)) return;
      const slug = params?.slug ?? "";
      // Nothing is decoded: a slug is ASCII, so a percent sign is no slug.
      if (!SLUG_RE.test(slug)) return sendInternalRefusal(response, contract, 404);
      try {
        const found = await port.read(slug);
        if (found === null) return sendInternalRefusal(response, contract, 404);
        return sendJson(response, 200, instanceOf(found));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendInternalRefusal(response, contract, 503);
      }
    },
  };

  return [post, get];
}
