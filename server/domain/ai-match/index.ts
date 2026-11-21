import type { AssistantResponse } from "./fake-assistant-responses.ts";
import { MATCH_NORMALIZATION, normalizeMatchText } from "./normalization.ts";
import { SuffixIndex } from "./suffix-index.ts";

export { readFakeAssistantResponses, type AssistantResponse } from "./fake-assistant-responses.ts";

export const MIN_MATCH_CODE_POINTS = 60;
const NOTICE = "not_authorship_evidence";
const WORD_POINT = /[\p{L}\p{N}\p{M}]/u;

type SubmittedBlock = { blockId: string; text: string };
type Span = { blockId: string; from: number; to: number };
type Witness = { blockId: string; normalizedFrom: number; normalizedTo: number; messageId: string };

export type AiMatchResult = {
  aiMatch: {
    normalization: typeof MATCH_NORMALIZATION;
    minMatchCodePoints: number;
    spans: Span[];
    notice: typeof NOTICE;
  };
  /** Internal matches only. A union of overlapping matches can depend on several messages. */
  witnesses: Witness[];
};

/** Compares the ordered text blocks of a recorded submission with its eligible replies. */
export function compareAssistantResponses(
  blocks: readonly Readonly<SubmittedBlock>[],
  responses: readonly Readonly<AssistantResponse>[],
): AiMatchResult {
  const spans: Span[] = [];
  const witnesses: Witness[] = [];
  const aiMatch: AiMatchResult["aiMatch"] = {
    normalization: MATCH_NORMALIZATION,
    minMatchCodePoints: MIN_MATCH_CODE_POINTS,
    spans,
    notice: NOTICE,
  };
  if (responses.length === 0) return { aiMatch, witnesses };

  const index = new SuffixIndex();
  const indexedBlocks = blocks.flatMap(({ blockId, text }) => {
    const normalized = normalizeMatchText(text);
    if (normalized.points.length < MIN_MATCH_CODE_POINTS) return [];
    return [{ blockId, ...normalized, starts: index.addBlock(normalized.points) }];
  });
  if (indexedBlocks.length === 0) return { aiMatch, witnesses };

  for (const { messageId, text } of responses) {
    const { points } = normalizeMatchText(text, false);
    index.addResponse(points, messageId);
  }
  index.finish();

  for (const { blockId, points, sourceRanges, sourceLength, starts } of indexedBlocks) {
    const inWord = points.map((point) => WORD_POINT.test(point));
    const lastWordEnd = [0];
    for (let i = 1; i <= points.length; i++) {
      lastWordEnd[i] = inWord[i - 1] && !inWord[i] ? i : lastWordEnd[i - 1]!;
    }

    // Merge in normalized order first. Project whole merged spans back to
    // source offsets, where compatibility expansion and NFC can overlap again.
    const coverage = new Int32Array(sourceLength + 1);
    let end = 0;
    let sourceFrom = sourceLength;
    let sourceTo = 0;
    function finishSpan(): void {
      if (sourceFrom >= sourceTo) return;
      coverage[sourceFrom] = coverage[sourceFrom]! + 1;
      coverage[sourceTo] = coverage[sourceTo]! - 1;
      sourceFrom = sourceLength;
      sourceTo = 0;
    }
    for (let from = 0; from < points.length; from++) {
      if (!inWord[from] || inWord[from - 1]) continue;
      const { matchedLength, messageId } = index.matchAt(starts[from]!);
      const to = lastWordEnd[from + matchedLength]!;
      if (to - from < MIN_MATCH_CODE_POINTS || to <= end) continue;
      if (from > end) finishSpan();
      witnesses.push({ blockId, normalizedFrom: from, normalizedTo: to, messageId });
      for (let i = Math.max(from, end); i < to; i++) {
        const range = sourceRanges[i]!;
        sourceFrom = Math.min(sourceFrom, range.from);
        sourceTo = Math.max(sourceTo, range.to);
      }
      end = to;
    }
    finishSpan();

    let active = 0;
    let from = 0;
    for (let to = 0; to <= sourceLength; to++) {
      const previous = active;
      active += coverage[to]!;
      if (previous === 0 && active > 0) from = to;
      if (previous > 0 && active === 0) spans.push({ blockId, from, to });
    }
  }
  return { aiMatch, witnesses };
}
