// POST /api/v1/public/verification (SRV-9B, Ductus#2028 c.7041664094; ✓ C-6).
// The page /provjera posts the two values of a receipt's QR and learns only
// whether a signed receipt binds that text. The route never reads the Cookie
// header, never answers Set-Cookie and runs the read with no session token,
// so it cannot become a way in (D-09). Besides the pipeline's limit (step 4,
// class default) it has its own, per address only: the check is cheap to ask
// and must not be a way to probe many receipts. POST
// /api/v1/public/verification/code (DIZAJN-27-11 1.1, step 3) asks the same by
// the receipt's confirmation code and shares that one limiter.
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { publicVerificationCodePost, publicVerificationPost } from "../contracts/index.ts";
import {
  createPublicVerification,
  createPublicVerificationByCode,
  type PublicVerificationResult,
} from "../public-verification/index.ts";
import { createRateLimiter, type RateLimiter, type RateLimits } from "../traffic/index.ts";

import type { Databases } from "./databases.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const BODY_TIMEOUT_MS = 5000;

/** Checks per minute from one client address. */
export const PUBLIC_VERIFICATION_PER_MINUTE = 30;
const PER_ADDRESS = { perIp: PUBLIC_VERIFICATION_PER_MINUTE, perAccount: null };
const ONE_LIMIT: RateLimits = {
  login: PER_ADDRESS,
  // The limiter asks every class but login for an account limit; with no
  // session token read, it is never used.
  enroll: { ...PER_ADDRESS, perAccount: 1 },
  save: { ...PER_ADDRESS, perAccount: 1 },
  default: { ...PER_ADDRESS, perAccount: 1 },
};

/** The route's own limiter: one bucket per address, the session never read. */
export function publicVerificationLimiter(now?: () => number): RateLimiter {
  return createRateLimiter({
    limits: ONE_LIMIT,
    sessionTokenOf: () => null,
    ...(now === undefined ? {} : { now }),
  });
}

/** The JSON media type is the one body both routes take. */
export function isJsonMedia(media: readonly string[] | undefined): boolean {
  return (
    media?.length === 1 && media[0]?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

type Parsed = { ok: true; value: unknown } | { ok: false; status: 400 | 422 };

/** Parses a read body against the route's schema: 400 for broken JSON, 422 for a wrong shape. */
export function parseCheckBody(schema: TSchema, bytes: Uint8Array): Parsed {
  const parsed = parseJson(bytes);
  if (!parsed.ok) return { ok: false, status: 400 };
  return Value.Check(schema, parsed.value)
    ? { ok: true, value: parsed.value }
    : { ok: false, status: 422 };
}

type Contract = typeof publicVerificationPost | typeof publicVerificationCodePost;

/** One route of the check: the limiter first, then media type, body and the read. */
function checkRoute(
  contract: Contract,
  limiter: RateLimiter,
  run: (value: unknown) => Promise<PublicVerificationResult>,
): Route {
  return {
    contract,
    async handle(request, response) {
      const decision = limiter.check(request);
      if (!decision.allowed) {
        response.setHeader("Retry-After", String(decision.retryAfter));
        return refuse(response, 429, "too_many_requests");
      }
      if (!isJsonMedia(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes, BODY_TIMEOUT_MS);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const parsed = parseCheckBody(contract.request.body, raw.bytes);
      if (!parsed.ok) {
        return sendProblem(
          response,
          parsed.status,
          parsed.status === 400 ? "invalid_json" : "invalid_input",
        );
      }
      const result = await run(parsed.value);
      if (result.status === "unavailable") return sendProblem(response, 503, "unavailable");
      return sendJson(response, 200, result.answer);
    },
  };
}

export function createPublicVerificationRouteFor(
  main: Pick<Databases["main"], "withActor">,
  limiter: RateLimiter = publicVerificationLimiter(),
): Route {
  const verify = createPublicVerification(main.withActor);
  return checkRoute(publicVerificationPost, limiter, (value) => {
    const body = value as { submissionId: string; artifactSha256: string };
    return verify(body.submissionId, body.artifactSha256);
  });
}

function createPublicVerificationCodeRouteFor(
  main: Pick<Databases["main"], "withActor">,
  limiter: RateLimiter = publicVerificationLimiter(),
): Route {
  const verify = createPublicVerificationByCode(main.withActor);
  return checkRoute(publicVerificationCodePost, limiter, (value) =>
    verify((value as { code: string }).code),
  );
}

/** Both routes over one limiter: checks by pair and by code count together per address. */
export function createPublicVerificationRoutesFor(
  main: Pick<Databases["main"], "withActor">,
  limiter: RateLimiter = publicVerificationLimiter(),
): Route[] {
  return [
    createPublicVerificationRouteFor(main, limiter),
    createPublicVerificationCodeRouteFor(main, limiter),
  ];
}
