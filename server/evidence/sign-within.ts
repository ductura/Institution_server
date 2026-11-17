// The signer, asked once within a bound, for a pending receipt v2 (DAN-820,
// VS-1b part 1, 820c-2; plan of attack ductura/server#146 P-2). Port of
// `signWithin`, `sameSignature` and `MAX_SIGN_TIMEOUT_MS` from Ductus
// src/application/evidence/sign-pending-receipt.ts at 333e163. The one change
// of logic: the signer here answers a Result (docs/CODE_STYLE.md §8, the
// ReceiptSigner port of database), not an envelope. The whole reply is cloned
// first, as in the source, and only the copy is read: `ok: false` is
// `sign_failed`, a reply that is no Result or holds no Ed25519 envelope is
// `signature_malformed`, and so is a reply that cannot be cloned.
import type { ReceiptSigner } from "../database/index.ts";
import {
  canonicalizeJcs,
  isPlainObject,
  isSignatureEnvelope,
  type SignatureEnvelope,
} from "../domain/index.ts";

export const MAX_SIGN_TIMEOUT_MS = 60_000;

export type SignedWithin =
  | { ok: true; signature: SignatureEnvelope }
  | { ok: false; reason: "sign_failed" | "sign_timeout" | "signature_malformed" };

function envelopeOf(copy: unknown): SignedWithin {
  if (!isPlainObject(copy) || (copy.ok !== true && copy.ok !== false)) {
    return { ok: false, reason: "signature_malformed" };
  }
  if (copy.ok === false) return { ok: false, reason: "sign_failed" };
  const value = copy.value;
  return isSignatureEnvelope(value) && value.algorithm === "Ed25519"
    ? { ok: true, signature: value }
    : { ok: false, reason: "signature_malformed" };
}

export async function signWithin(
  signer: ReceiptSigner,
  input: Uint8Array,
  timeoutMs: number,
): Promise<SignedWithin> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<SignedWithin>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ ok: false, reason: "sign_timeout" });
    }, timeoutMs);
  });
  // The signer gets a copy; a reply after the timeout is dropped unread: the
  // race does not cancel the signing, so the flag keeps its getters unrun
  // (Codex P2 on #204).
  const signing = Promise.resolve()
    .then(() => signer.sign(input.slice()))
    .then((raw): SignedWithin => {
      if (timedOut) return { ok: false, reason: "sign_timeout" };
      let copy: unknown;
      try {
        copy = structuredClone(raw);
      } catch {
        // A reply that cannot be copied (a function, a symbol) is no Result.
        return { ok: false, reason: "signature_malformed" };
      }
      return envelopeOf(copy);
    })
    .catch((): SignedWithin => ({ ok: false, reason: "sign_failed" }));
  try {
    return await Promise.race([signing, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function sameSignature(stored: unknown, sent: SignatureEnvelope): boolean {
  try {
    return isSignatureEnvelope(stored) && canonicalizeJcs(stored) === canonicalizeJcs(sent);
  } catch {
    return false;
  }
}
