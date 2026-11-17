// S-1H.3 (DAN-1003): someone else's work is answered as a work that does not
// exist, the contract's 404 {"status":"not_found"} (evidence.*.post).

/** One answer: the status and the parsed JSON body (`post` of scripts/stack reads a non-JSON body as {}). */
export type Answer = { status: number; body: unknown };

/**
 * null only for status 404 with a body of exactly one own key `status` equal
 * to "not_found"; otherwise the line that fails the test. It names the route
 * and the status, never a value of the body.
 */
export function notFoundProblem(route: string, answer: Answer): string | null {
  const { status, body } = answer;
  const exact =
    status === 404 &&
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    Object.hasOwn(body, "status") &&
    (body as Record<string, unknown>).status === "not_found";
  if (exact) return null;
  return status === 404
    ? `${route} answered 404 with a body other than {"status":"not_found"}`
    : `${route} answered ${status}, not 404 not_found`;
}
