// The closed JSON object of an evidence body (M3.1, B-8; N-19 of plan #1504,
// DAN-707). JSON.parse keeps the last of two equal keys, so a check of
// Object.keys alone never sees the first one: {"documentId":"a",
// "documentId":"b"} passed as {"documentId":"b"}. Here every top-level key of
// the received text is read as written, so a repeated key is refused as an
// unknown one is (BACKEND 4.13 t. 2: a closed set of keys).

/**
 * The top-level keys of a JSON object, in the order written and decoded
 * (`"d"` is `"d"`). Only called on text JSON.parse has taken as an
 * object, so every string token is closed and the scan is linear.
 */
function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      index += 1;
      if (depth === 1 && expectKey) {
        keys.push(JSON.parse(text.slice(start, index)) as string);
        expectKey = false;
      }
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      if (depth === 1) expectKey = true;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      expectKey = true;
    }
    index += 1;
  }
  return keys;
}

/**
 * A JSON object with exactly the given keys, each written once, from strict
 * UTF-8: a byte order mark stays a character and fails the parse. Anything
 * else is null; the caller answers it with a closed code and never echoes it.
 */
export function parseClosedJsonObject(
  bytes: Uint8Array,
  keys: readonly string[],
): Record<string, unknown> | null {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) return null;
  // Equal counts: the text names no key twice, so no value was dropped.
  if (topLevelKeys(text).length !== own.length) return null;
  return value as Record<string, unknown>;
}
