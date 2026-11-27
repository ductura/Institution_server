// Public interface of the RFC 3161 time-stamp port (ISTR-2 steps 1; D-72,
// D-209). Other areas import from here only. The worker of step 3 is the
// first caller; until then only tests use it, with the fake TSA.
export {
  anyVerified,
  MAX_RESPONSE_BYTES,
  requestTimeStamp,
  stampWithAll,
  stampWithTsa,
  TIME_STAMP_QUERY,
  TIME_STAMP_REPLY,
  type TsaClientDeps,
  type TsaFetch,
  type TsaStampOutcome,
} from "./client.ts";
export {
  parseTsaConfig,
  PILOT_TSA_CONFIG,
  TSA_CONFIG_FORMAT,
  TSA_MAX_ATTEMPTS,
  TSA_MAX_BACKOFF_MS,
  TSA_MAX_CLOCK_SKEW_MS,
  TSA_MAX_ENTRIES,
  TSA_MAX_TIMEOUT_MS,
  type TsaConfig,
  type TsaEndpoint,
} from "./config.ts";
export {
  TSA_ERROR_CODES,
  tsaError,
  tsaMessageKey,
  type TsaError,
  type TsaErrorCode,
  type TsaResult,
} from "./errors.ts";
export {
  buildTimeStampRequest,
  DIGEST_BYTES,
  newNonce,
  NONCE_BYTES,
  type RandomSource,
} from "./request.ts";
export {
  parseAnchorsPem,
  parseCertificates,
  verifyTimeStampResponse,
  type TimeStampExpectation,
  type TrustMaterial,
  type VerifiedTimeStamp,
} from "./verify.ts";
