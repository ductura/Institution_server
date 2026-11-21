export const MATCH_NORMALIZATION = "ductura-match-norm-v1";

const IGNORED = /[\u00ad\u200b\u200c\u200d\u2060\ufeff]/u;
const SINGLE_QUOTE = /[‘’‚‛′]/u;
const DOUBLE_QUOTE = /[“”„‟″«»]/u;
const DASH = /[‐‑‒–—―−]/u;
const WHITE_SPACE = /\p{White_Space}/u;

export type SourceRange = { from: number; to: number };

// NFC can compose adjacent source points or reorder combining marks. For each
// decomposed point, occurrences retain their order through canonical reordering.
// Consume the same occurrences when decomposing each NFC point to map it back.
function sourceRangesOfNfc(source: string, nfc: string): SourceRange[] {
  const positions = new Map<string, { offsets: number[]; next: number }>();
  let offset = 0;
  for (const point of source) {
    for (const part of point.normalize("NFD")) {
      let queue = positions.get(part);
      if (queue === undefined) {
        queue = { offsets: [], next: 0 };
        positions.set(part, queue);
      }
      queue.offsets.push(offset);
    }
    offset++;
  }
  return Array.from(nfc, (point) => {
    let from = offset;
    let to = 0;
    for (const part of point.normalize("NFD")) {
      const queue = positions.get(part)!;
      const position = queue.offsets[queue.next++]!;
      from = Math.min(from, position);
      to = Math.max(to, position + 1);
    }
    return { from, to };
  });
}

function normalizePunctuation(point: string): string {
  if (SINGLE_QUOTE.test(point)) return "'";
  if (DOUBLE_QUOTE.test(point)) return '"';
  if (DASH.test(point)) return "-";
  return point;
}

export function normalizeMatchText(text: string, mapSource = true) {
  const nfc = text.normalize("NFC");
  const alignment = mapSource && nfc !== text ? sourceRangesOfNfc(text, nfc) : undefined;
  const points: string[] = [];
  const sourceRanges: SourceRange[] = [];
  let index = 0;
  let whiteSpace: SourceRange | undefined;
  for (const point of nfc) {
    const offsets = alignment?.[index];
    const from = offsets?.from ?? index;
    const to = offsets?.to ?? index + 1;
    index++;
    if (IGNORED.test(point)) continue;
    // NFKC expands the double prime into two single primes. Preserve the
    // contract's explicit double-quote alias for that original point.
    const normalized = point === "″" ? '"' : point.normalize("NFKC").toLowerCase();
    for (const part of normalized) {
      if (WHITE_SPACE.test(part)) {
        if (points.length > 0) {
          whiteSpace = {
            from: Math.min(whiteSpace?.from ?? from, from),
            to: Math.max(whiteSpace?.to ?? to, to),
          };
        }
        continue;
      }
      if (whiteSpace !== undefined) {
        points.push(" ");
        if (mapSource) sourceRanges.push(whiteSpace);
        whiteSpace = undefined;
      }
      points.push(normalizePunctuation(part));
      if (mapSource) sourceRanges.push({ from, to });
    }
  }
  return {
    points,
    sourceRanges,
    sourceLength: alignment === undefined ? index : Array.from(text).length,
  };
}
