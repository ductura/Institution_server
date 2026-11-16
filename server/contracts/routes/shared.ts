import { error } from "../schema/index.ts";

/**
 * Refusals of the Ductus mutation guard and body reader at 078c780
 * (src/server/http/mutation-request.ts: checkMutationRequest,
 * readBodyWithLimit), in the default problem body. Routes new in DAN-803 have
 * no v1 body to keep, so several errors of one status are a plain oneOf.
 */
export const MUTATION_GUARD = [
  error(403, "origin_missing"),
  error(403, "origin_mismatch"),
  error(403, "cross_site"),
  error(413, "body_too_large"),
  error(408, "body_timeout"),
  error(400, "content_length_invalid"),
  error(400, "content_length_mismatch"),
  error(400, "body_stream_error"),
] as const;
