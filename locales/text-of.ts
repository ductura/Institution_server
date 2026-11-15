/**
 * Reads one text from a table by key. It lives outside the catalogues, which hold
 * only data and types: the forbidden terms scan reads them from their syntax tree
 * and refuses any code in them (DAN-774).
 */
import type { MessageKey, Messages } from "./hr.ts";

/** The text of `key` in `table`. */
export function textOf(table: Messages, key: MessageKey): string {
  let node: unknown = table;
  for (const segment of key.split(".")) {
    // Own keys only: an inherited one (`constructor`, `toString`) is no text.
    const own = typeof node === "object" && node !== null && Object.hasOwn(node, segment);
    node = own ? (node as Record<string, unknown>)[segment] : undefined;
  }
  if (typeof node !== "string") throw new Error(`locales: no text at ${key}`);
  return node;
}
