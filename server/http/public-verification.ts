// POST /api/v1/public/verification (SRV-9B, Ductus#2028 c.7041664094; ✓ C-6).
// The page /provjera posts the two values of a receipt's QR and learns only
// whether a signed receipt binds that text. The route never reads the Cookie
// header, never answers Set-Cookie and runs the read with no session token,
// so it cannot become a way in (D-09). Besides the pipeline's limit (step 4,
// class default) it has its own, per address only: the check is cheap to ask
// and must not be a way to probe many receipts.
import { Value } from "@sinclair/typebox/value";

import { publicVerificationPost } from "../contracts/index.ts";
import { createPublicVerification } from "../public-verification/index.ts";
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

export function createPublicVerificationRouteFor(
  main: Pick<Databases["main"], "withActor">,
  limiter: RateLimiter = publicVerificationLimiter(),
): Route {
  const verify = createPublicVerification(main.withActor);
  return {
    contract: publicVerificationPost,
    async handle(request, response) {
      const decision = limiter.check(request);
      if (!decision.allowed) {
        response.setHeader("Retry-After", String(decision.retryAfter));
        return refuse(response, 429, "too_many_requests");
      }
      const media = request.headersDistinct["content-type"];
      if (
        media?.length !== 1 ||
        media[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const { body, maxBodyBytes } = publicVerificationPost.request;
      const raw = await readBodyWithLimit(request, maxBodyBytes, BODY_TIMEOUT_MS);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const parsed = parseJson(raw.bytes);
      if (!parsed.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(body, parsed.value)) return sendProblem(response, 422, "invalid_input");

      const result = await verify(parsed.value.submissionId, parsed.value.artifactSha256);
      if (result.status === "unavailable") return sendProblem(response, 503, "unavailable");
      return sendJson(response, 200, result.answer);
    },
  };
}
