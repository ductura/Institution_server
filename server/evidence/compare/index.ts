export {
  compareWorkVersions,
  type CompareDeps,
  type CompareResult,
  type CompareUnavailableReason,
  MAX_COMPARE_READ_BYTES,
  MAX_COMPARE_SEGMENTS,
} from "./compare.ts";
export {
  blocksOf,
  type CompareBlock,
  type CompareChange,
  type CompareEntry,
  diffBlocks,
  MAX_COMPARE_BLOCKS,
  MAX_COMPARE_DIFF_CELLS,
} from "./blocks.ts";
