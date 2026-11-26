// SRV-V13-KORACI-SLAJD: the SHA-256 a slide step carries for the text or notes
// it removes. Kept apart from the step reader (./model/steps.ts) so that the
// reader imports no Node module (SRV-V14-PARSERI-BEZ-NODE): it checks only that
// a hash is 64 lowercase hex digits, and application compares it with this.
import { createHash } from "node:crypto";

/** SHA-256 (lowercase hex) of the UTF-8 bytes of a text; the `removedSha256` of text and notes. */
export function slideTextSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
