import { DIACRITICS, extractDates } from "./corpus.ts";

export type Metrics = {
  readonly cer: number; // character error rate over the whole text, whitespace-normalised
  readonly diacriticRecall: number; // share of reference diacritics read correctly (aligned)
  readonly diacriticTotal: number;
  readonly datesFound: number; // reference dates found verbatim in the output
  readonly datesTotal: number;
};

export function normalise(text: string): string {
  // Line breaks are layout, not content: wrapped lines and OCR line breaks must not count as errors.
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

// Levenshtein alignment over code points; returns the edit distance and, for every reference
// position, whether it was matched unchanged.
function align(
  reference: readonly string[],
  hypothesis: readonly string[],
): { distance: number; matched: boolean[] } {
  const n = reference.length;
  const m = hypothesis.length;
  const row = (): number[] => new Array<number>(m + 1).fill(0);
  const d: number[][] = Array.from({ length: n + 1 }, row);
  for (let i = 0; i <= n; i += 1) d[i]![0] = i;
  for (let j = 0; j <= m; j += 1) d[0]![j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  const matched = new Array<boolean>(n).fill(false);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const cost = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
    if (d[i]![j] === d[i - 1]![j - 1]! + cost) {
      matched[i - 1] = cost === 0;
      i -= 1;
      j -= 1;
    } else if (d[i]![j] === d[i - 1]![j]! + 1) i -= 1;
    else j -= 1;
  }
  return { distance: d[n]![m]!, matched };
}

export function measure(reference: string, output: string): Metrics {
  const ref = [...normalise(reference)];
  const hyp = [...normalise(output)];
  const { distance, matched } = align(ref, hyp);
  let total = 0;
  let ok = 0;
  ref.forEach((char, index) => {
    if (DIACRITICS.includes(char)) {
      total += 1;
      if (matched[index]) ok += 1;
    }
  });
  const dates = extractDates(reference);
  const outDates = new Set(extractDates(normalise(output)));
  return {
    cer: ref.length === 0 ? 0 : distance / ref.length,
    diacriticRecall: total === 0 ? 1 : ok / total,
    diacriticTotal: total,
    datesFound: dates.filter((date) => outDates.has(date)).length,
    datesTotal: dates.length,
  };
}
