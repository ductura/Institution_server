// Public interface of server/deletion/restore-drill; server/deletion re-exports it.
export {
  MAX_DRILL_COPY_ITEMS,
  runRestoreDrill,
  SYNTHETIC_INSTITUTION_PATTERN,
  type DrillCopyItem,
  type RestoreDrillProblem,
  type RestoreDrillResult,
} from "./restore-drill.ts";
