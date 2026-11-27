import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { ConfirmationCode, MUTATION_GUARD } from "./shared.ts";

// SRV-9B (Ductus#2028 c.7041664094; plan „Val 9”, ✓ C-6): the public check of a
// submission receipt. The page /provjera reads the two values of the receipt's
// QR fragment (r = submissionId, o = artifactSha256) and posts them here. The
// route never reads, issues or changes a session (D-09) and gives no access
// to a work (C-23): the answer is only whether a signed receipt binds exactly
// that text, and then when it was submitted and signed and by which key.

const END = "(?![\\s\\S])";
const LowerUuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
const Sha256 = Type.String({ pattern: `^[0-9a-f]{64}${END}` });
/** isSubmissionInstant: the database clock with exactly six fraction digits, in UTC. */
const Microsecond = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z${END}`,
});

const RESPONSES = [
  {
    status: 200,
    description: "the answer of the check",
    body: Type.Union([
      closed({
        match: Type.Literal(true),
        submittedAt: Microsecond,
        signedAt: Microsecond,
        keyId: Type.String({ minLength: 1, maxLength: 256 }),
      }),
      closed({ match: Type.Literal(false) }),
    ]),
  },
] as const;
const ERRORS = [
  ...MUTATION_GUARD,
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
  error(503, "unavailable"),
] as const;

export const publicVerificationPost = defineRoute({
  id: "public.verification.post",
  method: "POST",
  path: "/api/v1/public/verification",
  inventory: "app/api/public/verification/route.ts",
  access: "anyone",
  summary:
    "Checks whether a signed submission receipt binds exactly the given text (C-6). The body is the two values of the receipt's QR fragment: the submission id and the SHA-256 of the submitted text, lowercase. Works without a login, never reads or sets a session cookie and is not a way to sign in (D-09); it has its own rate limit per address. match is true only when the institution's receipt for that submission names that hash and its Ed25519 signature verifies with a key valid then and not revoked; the answer then carries only the submission and signing instants and the key id, never a name, course, assignment or text. Every other case, an unknown submission included, is the same match false.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({ submissionId: LowerUuid, artifactSha256: Sha256 }),
  },
  responses: RESPONSES,
  errors: ERRORS,
});

// DIZAJN-27-11 1.1 (3): the same check by the receipt's confirmation code
// alone, the code its PDF prints and its QR carries. One limiter per address
// serves both routes, so the two together allow no more checks than one.
export const publicVerificationCodePost = defineRoute({
  id: "public.verification-code.post",
  method: "POST",
  path: "/api/v1/public/verification/code",
  inventory: "app/api/public/verification/code/route.ts",
  access: "anyone",
  summary:
    "Checks a signed submission receipt by its confirmation code alone (C-6): 16 characters of the alphabet without I, L, O and U in 4 groups of 4, upper case, as the receipt prints it (for example DK7M-4Q9P-X2HT-R8VN). Works without a login, never reads or sets a session cookie and is not a way to sign in (D-09); it shares the rate limit per address of public.verification.post. The answer is the same as there: match true only when the code belongs to a bound receipt whose Ed25519 signature verifies with a key valid then and not revoked, with only the two instants and the key id. An unknown code and the code of a submission without a bound receipt are the same match false.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({ code: ConfirmationCode }),
  },
  responses: RESPONSES,
  errors: ERRORS,
});

export const publicVerificationRoutes = [
  publicVerificationPost,
  publicVerificationCodePost,
] as const;
