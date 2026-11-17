// DAN-820 820c-1: a one-character change of a pending receipt text is refused
// or reads as another payload, never as the original (docs/CODE_STYLE.md §7;
// moved from pending-receipt-text.test.ts after the review of #202).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { PAYLOAD, RECEIPT, TEXT } from "../../test-support/pending-receipt/index.ts";

import { parsePendingReceipt } from "./pending-receipt-text.ts";

describe("parsePendingReceipt", () => {
  it("a one-character change is refused or reads as another payload, never as the original", () => {
    fc.assert(
      fc.property(
        fc.nat(TEXT.length - 1),
        fc.constantFrom(...'0123456789abcdef"{}:, -xZ'),
        (at, ch) => {
          fc.pre(TEXT[at] !== ch);
          const read = parsePendingReceipt({
            receiptId: RECEIPT,
            receiptPayloadText: TEXT.slice(0, at) + ch + TEXT.slice(at + 1),
          });
          if (read.ok) expect(read.payload).not.toEqual(PAYLOAD);
        },
      ),
      { numRuns: 300 },
    );
  });
});
