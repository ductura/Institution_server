// SRV-1230 (Ductus#2052; P-1, rule 13): the deterministic match of a segment of a
// work with the answers of the assistant of the same work. A match is a run of
// 8 or more words in a row that is the same in the segment and in an answer,
// after the normalization below. Pure: no I/O, no clock, no randomness; the same
// input gives the same result, in the same order.
//
// Normalization (version ASSISTANT_MATCH_NORMALIZATION): NFC, lower case by
// Unicode default case folding of the language-neutral kind, every character that
// is neither a letter, a mark nor a number is a separator (so spaces, line
// breaks, punctuation, quotes and dashes all vanish), the words are what is left
// between separators. A hyphen inside a word splits it, so "mid-way" is two
// words. A number is a word.
//
// The result names which answer matched and how long the longest run is, never a
// quotation: nothing of either text is returned. "Podudara se" is all it says;
// it never says "copied" (Ductus PRODUCT §5), and no model is involved.

export const ASSISTANT_MATCH_NORMALIZATION = "ductura-assistant-match-v1";
/** The least number of words in a row that makes a match. One constant: the whole rule. */
export const MIN_MATCH_WORDS = 8;

/** The words of a text, normalized. */
export function matchWords(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word !== "");
}

export type AssistantAnswer = {
  readonly id: string;
  readonly conversationId: string;
  readonly text: string;
};
export type AssistantMatch = {
  readonly messageId: string;
  readonly conversationId: string;
  /** The words of the longest run the segment shares with that answer; at least MIN_MATCH_WORDS. */
  readonly runWords: number;
};

/** The length of the longest run of equal words in a row that two word lists share. */
export function longestSharedRun(a: readonly string[], b: readonly string[]): number {
  if (a.length < MIN_MATCH_WORDS || b.length < MIN_MATCH_WORDS) return 0;
  const key = (words: readonly string[], at: number) =>
    words.slice(at, at + MIN_MATCH_WORDS).join(" ");
  const grams = new Map<string, number[]>();
  for (let i = 0; i + MIN_MATCH_WORDS <= a.length; i++) {
    const gram = key(a, i);
    const at = grams.get(gram);
    if (at === undefined) grams.set(gram, [i]);
    else at.push(i);
  }
  let longest = 0;
  for (let j = 0; j + MIN_MATCH_WORDS <= b.length; j++) {
    for (const i of grams.get(key(b, j)) ?? []) {
      // Only the start of a run: the pair before it on the same diagonal does not match.
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) continue;
      let length = MIN_MATCH_WORDS;
      while (i + length < a.length && j + length < b.length && a[i + length] === b[j + length])
        length++;
      if (length > longest) longest = length;
    }
  }
  return longest;
}

/**
 * The answers that share a run of at least MIN_MATCH_WORDS words with the
 * segment, in the order given. An empty segment, or no answer, matches nothing.
 */
export function matchSegment(
  segmentText: string,
  answers: readonly AssistantAnswer[],
): AssistantMatch[] {
  const segment = matchWords(segmentText);
  if (segment.length < MIN_MATCH_WORDS) return [];
  const matches: AssistantMatch[] = [];
  for (const answer of answers) {
    const runWords = longestSharedRun(segment, matchWords(answer.text));
    if (runWords >= MIN_MATCH_WORDS) {
      matches.push({ messageId: answer.id, conversationId: answer.conversationId, runWords });
    }
  }
  return matches;
}
