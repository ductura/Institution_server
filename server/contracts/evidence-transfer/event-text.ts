/**
 * The event text and the verdict on a known paste origin (SRV-1809, plan
 * M9.0-S1; Ductus docs/contracts/evidence-segment-v4.md, "Tekst događaja",
 * "Prihvat i rekonstrukcija" and "Presuda i brisanje izvora").
 *
 * The event text is every inserted range of the event's steps, in step order,
 * each range taken as `textBetween(0, size, "\n")`, joined with nothing in
 * between. Its hash (`textSha256` of a `pasteOrigin` and of an AI transfer
 * record) is SHA-256 over the UTF-8 bytes of that text, never normalised:
 * NFC and NFD give different hashes (K14). Contracts hash nothing: the caller
 * hashes {@link eventTextBytes} and hands the hex in.
 *
 * PRIJEDLOG until the contract review, like SRV-1801.
 */
import { Type, type Static } from "@sinclair/typebox";

import { SHA256_HEX_PATTERN, UUID_V4_PATTERN } from "../import/index.ts";

import { PASTE_ORIGIN_KINDS_V4 } from "./transfer-link.ts";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** The event text from the inserted ranges, each already `textBetween(0, size, "\n")`. */
export function eventTextOf(insertedRanges: readonly string[]): string {
  return insertedRanges.join("");
}

/**
 * The bytes whose SHA-256 is the event text hash, or null for text that has
 * no one UTF-8 spelling (a lone surrogate). Text without bytes cannot be a
 * known origin; the verdict is `not_observed`.
 */
export function eventTextBytes(text: string): Uint8Array | null {
  if (LONE_SURROGATE.test(text)) return null;
  return new TextEncoder().encode(text);
}

/** `known` or `not_observed`; never a rejection of the segment (D2, D3). */
export const PASTE_ORIGIN_VERDICTS_V1 = Object.freeze(["known", "not_observed"] as const);
export type PasteOriginVerdictV1 = (typeof PASTE_ORIGIN_VERDICTS_V1)[number];

export type PasteOriginVerdictInputV1 = {
  /** `textSha256` the paste claims. */
  readonly claimedTextSha256: string;
  /** The event text computed from the steps of the received segment, not the document. */
  readonly eventText: string;
  /** SHA-256 hex of {@link eventTextBytes} of `eventText`; null when it has no bytes. */
  readonly eventTextSha256: string | null;
  /**
   * The current text of the answer or notebook item `refId`, read for the same
   * principal and document under a lock taken after the document's; null when
   * there is none. Foreign and missing are both null, so they give the same
   * verdict (C7).
   */
  readonly sourceText: string | null;
};

/**
 * The verdict taken once, at acceptance (E5). `known` only when the hash of
 * the event text is the claimed hash and the event text is a non-empty,
 * contiguous, exact substring of the source's current text: byte for byte,
 * without normalisation or collation (K14). A part of an answer counts like
 * the whole (D-58). Anything else is `not_observed`: a false negative, never
 * a false positive. The verdict carries no source text and no position (D9).
 */
export function pasteOriginVerdictV1(input: PasteOriginVerdictInputV1): PasteOriginVerdictV1 {
  const { claimedTextSha256, eventText, eventTextSha256, sourceText } = input;
  if (eventTextSha256 === null || eventTextSha256 !== claimedTextSha256) return "not_observed";
  if (sourceText === null || eventText === "") return "not_observed";
  // Well-formed UTF-16 on both sides: a code unit match is a UTF-8 byte match
  // and cannot start or end inside a surrogate pair.
  if (LONE_SURROGATE.test(eventText) || LONE_SURROGATE.test(sourceText)) return "not_observed";
  return sourceText.includes(eventText) ? "known" : "not_observed";
}

/**
 * The stored verdict beside its claim. Written only by the acceptance RPC,
 * one per event, never updated (E5). No source text, position or source hash
 * (D9, D-30): deleting or editing the source later leaves the verdict as it is.
 */
export const PasteOriginVerdictRecordV1 = Type.Object(
  {
    segmentHash: Type.String({ pattern: SHA256_HEX_PATTERN }),
    sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    kind: Type.Union(PASTE_ORIGIN_KINDS_V4.map((kind) => Type.Literal(kind))),
    refId: Type.String({ pattern: UUID_V4_PATTERN }),
    textSha256: Type.String({ pattern: SHA256_HEX_PATTERN }),
    verdict: Type.Union(PASTE_ORIGIN_VERDICTS_V1.map((verdict) => Type.Literal(verdict))),
  },
  { additionalProperties: false },
);
export type PasteOriginVerdictRecordV1 = Static<typeof PasteOriginVerdictRecordV1>;

/**
 * What the projection shows for a paste after a successful replay: `known`
 * only with a stored `known` verdict and a replayed event text whose hash is
 * the claimed one. Otherwise `not_observed`, as today; the reconstruction
 * never fails over it. The projection reads the verdict, never the source.
 */
export function displayedPasteOriginV1(
  verdict: PasteOriginVerdictRecordV1 | null,
  replayedTextSha256: string | null,
): PasteOriginVerdictV1 {
  if (verdict === null || verdict.verdict !== "known") return "not_observed";
  return replayedTextSha256 === verdict.textSha256 ? "known" : "not_observed";
}
