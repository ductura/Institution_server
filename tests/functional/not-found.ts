// S-1H.3 (DAN-1003): someone else's work is answered as a work that does not
// exist, the contract's 404 {"status":"not_found"} (evidence.*.post).

/** The one body the contract allows, as the server writes it (JSON.stringify). */
export const NOT_FOUND_BODY = '{"status":"not_found"}';

/** One answer: the status and the body exactly as received. */
export type RawAnswer = { status: number; text: string };

/**
 * null only for status 404 whose body is exactly the bytes of
 * {"status":"not_found"}: no other key, no repeated key, no whitespace, no
 * escape. Otherwise the line that fails the test; it names the route and the
 * status, never a value of the body.
 */
export function notFoundProblem(route: string, answer: RawAnswer): string | null {
  const { status, text } = answer;
  if (status === 404 && text === NOT_FOUND_BODY) return null;
  return status === 404
    ? `${route} answered 404 with a body other than ${NOT_FOUND_BODY}`
    : `${route} answered ${status}, not 404 not_found`;
}
