// The JSON body of a route: strict UTF-8, then JSON.parse (DAN-826-1b; shared
// with the WebAuthn routes since DAN-840-3c).

/**
 * Strict UTF-8 (a byte order mark stays a character) and JSON.parse; a
 * duplicate key keeps its last value. `text` is the decoded body, for a route
 * that also judges its spelling (acknowledgment.ts, Ductus singleKeys).
 */
export function parseJson(
  bytes: Uint8Array,
): { ok: true; value: unknown; text: string } | { ok: false } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown, text };
  } catch {
    return { ok: false };
  }
}
