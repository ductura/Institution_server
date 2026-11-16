// DAN-817 B: the stack's default ports through a real fetch (review c.6913054471:
// network calls belong in an integration test, docs/CODE_STYLE.md §7). The
// server reaches the local S3 through fetch, which refuses its "bad ports".
import { describe, expect, it } from "vitest";

import { DEFAULT_PORTS } from "./index.ts";

const causeOf = (error: unknown): string =>
  String((error as { cause?: { message?: string } }).cause?.message ?? "");

describe("the stack's default ports under fetch", () => {
  it("are never refused as bad ports, while 4190 is", async () => {
    for (const port of Object.values(DEFAULT_PORTS)) {
      // undici's own refusal comes before any connection: "bad port" only for the listed ones.
      const fault = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2000),
      }).then(() => null, causeOf);
      expect(fault).not.toBe("bad port");
    }
    expect(await fetch("http://127.0.0.1:4190/").then(() => null, causeOf)).toBe("bad port");
  });
});
