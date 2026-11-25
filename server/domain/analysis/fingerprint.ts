// SRV-V15-SKUP (Ductus#2055; val 15, docs/nalazi/val15-razlika.md §3.4): the
// fingerprints of an analysis. `datasetSha256` is the SHA-256 (lower-case hex) of the
// JCS (RFC 8785) of {dataset: {columns, rows}, variables}, so it does not depend on
// the order of keys in the request, only on the cells, the order of columns and rows,
// and the order of the chosen variables. The same helper gives `resultSha256`
// for the executor. No clock, no randomness, no identity.
import { canonicalizeJcs, sha256WebCrypto } from "../forensics/index.ts";
import type { Dataset } from "./dataset.ts";

export type FingerprintResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: { readonly code: "invalid_input" } };

/** SHA-256 of the JCS of any JSON value; a value JCS refuses is a structured error, not a throw. */
export async function sha256OfJcs(value: unknown): Promise<FingerprintResult> {
  try {
    return { ok: true, value: await sha256WebCrypto(canonicalizeJcs(value)) };
  } catch {
    return { ok: false, error: { code: "invalid_input" } };
  }
}

/** `datasetSha256` of a checked dataset and the variables chosen for the analysis. */
export function datasetFingerprint(
  dataset: Dataset,
  variables: readonly string[],
): Promise<FingerprintResult> {
  return sha256OfJcs({
    dataset: { columns: dataset.columns, rows: dataset.rows },
    variables,
  });
}
