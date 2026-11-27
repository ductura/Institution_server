import { tsaFailure, type TsaResult } from "./errors.ts";

// The list of TSAs comes from configuration (docs/plan/ISTR-2-TSA.md §4 step 1,
// O-1 (b), O-2 (c), O-4 (a)): adding FINA later as a third TSA, or changing the
// number of attempts, is a configuration change, not a code change. Every TSA
// is called independently; there is no fallback TSA (O-2 (c)).

export const TSA_CONFIG_FORMAT = "ductura-tsa-v1";
export const TSA_MAX_ENTRIES = 5;
export const TSA_MAX_ATTEMPTS = 10;
export const TSA_MAX_TIMEOUT_MS = 120_000;
export const TSA_MAX_BACKOFF_MS = 3_600_000;
export const TSA_MAX_CLOCK_SKEW_MS = 600_000;

export type TsaEndpoint = {
  /** Stable kebab-case id, recorded with every result. */
  readonly id: string;
  /** http: or https:. A response is checked by its signature, not by the transport. */
  readonly url: string;
  readonly timeoutMs: number;
};

export type TsaConfig = {
  readonly format: typeof TSA_CONFIG_FORMAT;
  readonly tsas: readonly TsaEndpoint[];
  /** Attempts per TSA within the daily window, each with a new nonce (O-4 (a)). */
  readonly maxAttempts: number;
  /** Wait before the second attempt; it doubles for each further one. */
  readonly initialBackoffMs: number;
  /** Allowed difference between genTime and the local clock around the request. */
  readonly clockSkewMs: number;
};

/**
 * The pilot list (D-72, D-209): DigiCert and Sectigo, both free; FINA is not
 * in the pilot (O-1 (b)). The worker of step 3 is the only caller that uses it
 * with a real network; tests use the fake TSA.
 */
export const PILOT_TSA_CONFIG: TsaConfig = {
  format: TSA_CONFIG_FORMAT,
  tsas: [
    { id: "digicert", url: "http://timestamp.digicert.com", timeoutMs: 15_000 },
    { id: "sectigo", url: "https://timestamp.sectigo.com", timeoutMs: 15_000 },
  ],
  maxAttempts: 4,
  initialBackoffMs: 60_000,
  clockSkewMs: 120_000,
};

const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k));
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
  return value;
}

function parseEndpoint(value: unknown): TsaEndpoint | null {
  if (!isRecord(value) || !hasOnly(value, ["id", "url", "timeoutMs"])) return null;
  const { id, timeoutMs } = value;
  const url = parseUrl(value["url"]);
  if (typeof id !== "string" || id.length > 40 || !ID_RE.test(id)) return null;
  if (url === null || !intIn(timeoutMs, 1, TSA_MAX_TIMEOUT_MS)) return null;
  return { id, url, timeoutMs };
}

/** Validates a configuration object; any unknown key, wrong type or duplicate id is refused. */
export function parseTsaConfig(raw: unknown): TsaResult<TsaConfig> {
  const invalid = tsaFailure<TsaConfig>("TSA_CONFIG_INVALID");
  if (!isRecord(raw)) return invalid;
  const keys = ["format", "tsas", "maxAttempts", "initialBackoffMs", "clockSkewMs"];
  if (!hasOnly(raw, keys) || raw["format"] !== TSA_CONFIG_FORMAT) return invalid;
  const { tsas, maxAttempts, initialBackoffMs, clockSkewMs } = raw;
  if (!Array.isArray(tsas) || tsas.length === 0 || tsas.length > TSA_MAX_ENTRIES) return invalid;
  if (!intIn(maxAttempts, 1, TSA_MAX_ATTEMPTS)) return invalid;
  if (!intIn(initialBackoffMs, 0, TSA_MAX_BACKOFF_MS)) return invalid;
  if (!intIn(clockSkewMs, 0, TSA_MAX_CLOCK_SKEW_MS)) return invalid;
  const endpoints: TsaEndpoint[] = [];
  for (const entry of tsas) {
    const endpoint = parseEndpoint(entry);
    if (endpoint === null || endpoints.some((e) => e.id === endpoint.id)) return invalid;
    endpoints.push(endpoint);
  }
  return {
    ok: true,
    value: {
      format: TSA_CONFIG_FORMAT,
      tsas: endpoints,
      maxAttempts,
      initialBackoffMs,
      clockSkewMs,
    },
  };
}
