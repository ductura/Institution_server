// SRV-1809: the declaration-v1 routes show ai.recorded as an empty list. Their
// schema has always held it empty (maxItems 0); a declaration confirmed since
// 20261220500000 may name transfer records there, which only the v2 routes
// show. Only the answer changes: the stored payload, its hash and the v2
// answer keep the list.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A copy of `body` whose payload carries `ai.recorded: []`, or `body` itself
 * when there is no payload with a non-empty list. The argument is never
 * changed.
 */
export function withoutRecorded<T>(body: T): T {
  if (!isRecord(body) || !isRecord(body.payload)) return body;
  const ai = body.payload.ai;
  if (!isRecord(ai) || !Array.isArray(ai.recorded) || ai.recorded.length === 0) return body;
  return { ...body, payload: { ...body.payload, ai: { ...ai, recorded: [] } } };
}
