// DAN-820 820c-4: a one-character change of the stored text is never signed
// as the original. Ported from Ductus sign-pending-receipt.test.ts at 333e163
// with the same assertions, as a property test (docs/CODE_STYLE.md §7). It
// needs the store's digest check, so it runs through the whole factory.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  RECEIPT,
  TEXT,
  memoryStore,
  testSigner,
} from "../../test-support/pending-receipt/index.ts";

import { createSignPendingReceipt } from "./sign-pending-receipt.ts";

describe("signPendingReceipt", () => {
  it("a one-character change of the stored text is never signed as the original", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat(TEXT.length - 1),
        fc.constantFrom(...'0123456789abcdef"{}:, -xZ'),
        async (at, ch) => {
          fc.pre(TEXT[at] !== ch);
          const signer = testSigner("k1");
          const { store, stored } = memoryStore(() => [signer.key()]);
          const run = createSignPendingReceipt({
            signer: signer.provider,
            store,
            signTimeoutMs: 1000,
            checkObject: async () => ({ status: "present" }),
          });
          const out = await run({
            receiptId: RECEIPT,
            receiptPayloadText: TEXT.slice(0, at) + ch + TEXT.slice(at + 1),
          });
          expect(out.status).not.toBe("signed");
          expect(out.status).not.toBe("already_signed");
          expect(stored.size).toBe(0);
        },
      ),
      { numRuns: 150 },
    );
  });
});
