import type { SourceIdentifier } from "./identifier.ts";
import { bookMetadata, crossrefMetadata, record, type SourceMetadata } from "./metadata.ts";

type CatalogueAnswer = { kind: "found"; source: SourceMetadata } | { kind: "missing" };

export type LookupResult =
  CatalogueAnswer | { kind: "unavailable" | "timeout" } | { kind: "limited"; retryAfter: number };

export type SourceLookup = (identifier: SourceIdentifier) => Promise<LookupResult>;

const MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 256;
const MIN_INTERVAL_MS = 1000;
const LOOKUP_TIMEOUT_MS = 7000;

async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("missing catalogue body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("catalogue body too large");
      chunks.push(value);
    }
    return await new Response(Buffer.concat(chunks)).json();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function requestCatalogue(
  identifier: SourceIdentifier,
  fetcher: typeof fetch,
  contact: string,
  signal: AbortSignal,
): Promise<CatalogueAnswer> {
  const doi = identifier.kind === "doi";
  const bookKey = `ISBN:${identifier.value}`;
  const query = new URLSearchParams({ bibkeys: bookKey, format: "json", jscmd: "data" });
  const url = doi
    ? `https://api.crossref.org/works/${encodeURIComponent(identifier.value)}`
    : `https://openlibrary.org/api/books?${query}`;
  const response = await fetcher(url, {
    redirect: "error",
    signal,
    headers: { accept: "application/json", "user-agent": `Ductura (${contact})` },
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    if (doi && response.status === 404) return { kind: "missing" };
    throw new Error("catalogue request failed");
  }
  const payload = record(await json(response));
  if (!doi && payload !== undefined && Object.keys(payload).length === 0)
    return { kind: "missing" };
  const item = record(payload?.[doi ? "message" : bookKey]);
  const source = item && (doi ? crossrefMetadata(item) : bookMetadata(item));
  if (!source) throw new Error("invalid catalogue record");
  return { kind: "found", source };
}

export function createSourceLookup(
  contact: string,
  {
    fetcher = fetch,
    now = () => performance.now(),
    timeoutMs = LOOKUP_TIMEOUT_MS,
  }: { fetcher?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): SourceLookup {
  const next = { doi: 0, isbn: 0 };
  const cache = new Map<string, { expiresAt: number; answer: CatalogueAnswer }>();
  return async ({ kind, value }) => {
    const start = now();
    if (kind === "isbn") {
      const cached = cache.get(value);
      if (cached && start < cached.expiresAt) return cached.answer;
      cache.delete(value);
    }
    if (start < next[kind]) {
      return { kind: "limited", retryAfter: Math.ceil((next[kind] - start) / 1000) };
    }
    next[kind] = start + MIN_INTERVAL_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const answer = await requestCatalogue({ kind, value }, fetcher, contact, signal);
      signal.throwIfAborted();
      if (kind === "isbn") {
        const first = cache.keys().next();
        if (cache.size >= CACHE_MAX && !first.done) cache.delete(first.value);
        cache.set(value, { expiresAt: now() + CACHE_TTL_MS, answer });
      }
      return answer;
    } catch {
      return { kind: signal.aborted ? "timeout" : "unavailable" };
    }
  };
}
