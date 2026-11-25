// SRV-V18-KODIRANJE-BAZA: the shape of qualitative-export-v1 (the route comes
// with SRV-V18-KODIRANJE-OZNAKE). Pure: the same input gives the same output. It
// holds the owner's codebook and passages and nothing else, in the order of the
// codebook, then of the materials, then of the text. The counts per code and
// material describe; no order, no "most often" and no comparison of materials
// comes out of them (V18-8).
import type { CodebookEntry } from "./codebook.ts";

export const QUALITATIVE_EXPORT_SCHEMA = "qualitative-export-v1";

export type ExportSegmentInput = {
  materialId: string;
  /** The place of the material in the order they were kept in. */
  materialRank: number;
  codeId: string;
  paragraph: number;
  start: number;
  end: number;
  quote: string;
  memo: string | null;
};

export type QualitativeExport = {
  schema: typeof QUALITATIVE_EXPORT_SCHEMA;
  codebook: { code: string; name: string; description: string }[];
  segments: {
    material: string;
    code: string;
    paragraph: number;
    start: number;
    end: number;
    quote: string;
    memo: string | null;
  }[];
  counts: { code: string; material: string; n: number }[];
};

const byNumbers = (left: number[], right: number[]): number => {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export function buildQualitativeExport(
  codebook: readonly CodebookEntry[],
  segments: readonly ExportSegmentInput[],
): QualitativeExport {
  const order = new Map(codebook.map((entry) => [entry.id, entry.order]));
  const place = (segment: ExportSegmentInput): number[] => {
    const codeOrder = order.get(segment.codeId);
    if (codeOrder === undefined)
      throw new Error("a passage names a code that is not in the codebook");
    return [codeOrder, segment.materialRank, segment.paragraph, segment.start, segment.end];
  };
  const sorted = segments
    .map((segment) => ({ segment, key: place(segment) }))
    .sort((a, b) => byNumbers(a.key, b.key))
    .map(({ segment }) => segment);
  const counts: QualitativeExport["counts"] = [];
  for (const segment of sorted) {
    const last = counts[counts.length - 1];
    if (last && last.code === segment.codeId && last.material === segment.materialId) last.n += 1;
    else counts.push({ code: segment.codeId, material: segment.materialId, n: 1 });
  }
  return {
    schema: QUALITATIVE_EXPORT_SCHEMA,
    codebook: [...codebook]
      .sort((a, b) => a.order - b.order)
      .map((entry) => ({ code: entry.id, name: entry.name, description: entry.description })),
    segments: sorted.map((segment) => ({
      material: segment.materialId,
      code: segment.codeId,
      paragraph: segment.paragraph,
      start: segment.start,
      end: segment.end,
      quote: segment.quote,
      memo: segment.memo,
    })),
    counts,
  };
}
