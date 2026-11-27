import type { TsaConfig, TsaEndpoint } from "./config.ts";
import { tsaFailure, type TsaErrorCode, type TsaResult } from "./errors.ts";
import { buildTimeStampRequest, isDigest, newNonce, type RandomSource } from "./request.ts";
import { type TrustMaterial, verifyTimeStampResponse, type VerifiedTimeStamp } from "./verify.ts";

// HTTP transport of RFC 3161 (RFC 3161 §3.4) and the attempts per TSA (O-4 (a)).
// `fetch` is always injected: this module never reaches the global fetch, so a
// test or CI run cannot call a real TSA by accident (docs/plan/ISTR-2-TSA.md §5).

export const TIME_STAMP_QUERY = "application/timestamp-query";
export const TIME_STAMP_REPLY = "application/timestamp-reply";
/** A real response with its certificates is a few kilobytes; more is refused unread. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

export type TsaFetch = (url: string, init: RequestInit) => Promise<Response>;

export type TsaClientDeps = {
  readonly fetch: TsaFetch;
  readonly now: () => Date;
  /** Waits between attempts; a test passes the fake clock's sleep. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Signal that aborts one attempt; default AbortSignal.timeout. */
  readonly timeout?: (ms: number) => AbortSignal;
  readonly random?: RandomSource;
};

export type TsaStampOutcome = {
  readonly tsaId: string;
  /** Attempts made, 1..maxAttempts. */
  readonly attempts: number;
  readonly result: TsaResult<VerifiedTimeStamp>;
};

/** Failures that come from the caller, not the TSA: another attempt cannot help. */
const NOT_RETRIED: ReadonlySet<TsaErrorCode> = new Set([
  "TSA_DIGEST_INVALID",
  "TSA_CONFIG_INVALID",
  "TSA_ANCHORS_INVALID",
]);

async function readBody(response: Response): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** One attempt against one TSA with a fresh nonce; never throws for a TSA's behaviour. */
export async function requestTimeStamp(
  endpoint: TsaEndpoint,
  digest: Uint8Array,
  trust: TrustMaterial,
  clockSkewMs: number,
  deps: TsaClientDeps,
): Promise<TsaResult<VerifiedTimeStamp>> {
  const nonce = newNonce(deps.random);
  const request = buildTimeStampRequest(digest, nonce);
  if (!request.ok) return request;
  const signal = (deps.timeout ?? ((ms) => AbortSignal.timeout(ms)))(endpoint.timeoutMs);
  const sentAt = deps.now();
  let der: Uint8Array | null;
  try {
    const response = await deps.fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": TIME_STAMP_QUERY, accept: TIME_STAMP_REPLY },
      body: request.value,
      signal,
      redirect: "error",
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return tsaFailure("TSA_HTTP_STATUS");
    }
    der = await readBody(response);
  } catch {
    return tsaFailure(signal.aborted ? "TSA_TIMEOUT" : "TSA_UNAVAILABLE");
  }
  if (der === null) return tsaFailure("TSA_MALFORMED");
  const receivedAt = deps.now();
  return verifyTimeStampResponse(
    der,
    {
      digest,
      nonce,
      notBefore: new Date(sentAt.getTime() - clockSkewMs),
      notAfter: new Date(receivedAt.getTime() + clockSkewMs),
    },
    trust,
  );
}

/** Up to config.maxAttempts attempts with doubling backoff, each with a new nonce (O-4 (a)). */
export async function stampWithTsa(
  endpoint: TsaEndpoint,
  digest: Uint8Array,
  trust: TrustMaterial | undefined,
  config: TsaConfig,
  deps: TsaClientDeps,
): Promise<TsaStampOutcome> {
  if (!isDigest(digest))
    return { tsaId: endpoint.id, attempts: 0, result: tsaFailure("TSA_DIGEST_INVALID") };
  if (trust === undefined || trust.anchors.length === 0)
    return { tsaId: endpoint.id, attempts: 0, result: tsaFailure("TSA_ANCHORS_INVALID") };
  let result: TsaResult<VerifiedTimeStamp> = tsaFailure("TSA_UNAVAILABLE");
  let attempts = 0;
  while (attempts < config.maxAttempts) {
    if (attempts > 0) await deps.sleep(config.initialBackoffMs * 2 ** (attempts - 1));
    attempts++;
    result = await requestTimeStamp(endpoint, digest, trust, config.clockSkewMs, deps);
    if (result.ok || NOT_RETRIED.has(result.error.code)) break;
  }
  return { tsaId: endpoint.id, attempts, result };
}

/**
 * Every configured TSA, independently and concurrently (D-72: two independent
 * TSAs; O-2 (c): no fallback). One outcome per TSA, in configuration order.
 * The day succeeds when at least one outcome is ok (ADR §5 t. 5); the worker
 * (step 3) turns "none" into an alarm and a recorded gap.
 */
export async function stampWithAll(
  config: TsaConfig,
  digest: Uint8Array,
  trustByTsa: Readonly<Record<string, TrustMaterial>>,
  deps: TsaClientDeps,
): Promise<readonly TsaStampOutcome[]> {
  return Promise.all(
    config.tsas.map((endpoint) =>
      stampWithTsa(
        endpoint,
        digest,
        Object.hasOwn(trustByTsa, endpoint.id) ? trustByTsa[endpoint.id] : undefined,
        config,
        deps,
      ),
    ),
  );
}

/** True when at least one TSA returned a verified time stamp. */
export function anyVerified(outcomes: readonly TsaStampOutcome[]): boolean {
  return outcomes.some((o) => o.result.ok);
}
