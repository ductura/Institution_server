// Public interface of the ISVU source adapters (SRV-V22-ISVU-PORT; contract
// docs/contracts/isvu-v1.md). Areas other than `http` import it with
// `import type` only (docs/server-map.md §2). Only the synthetic adapter
// exists; a real one waits for OP-V22-2.
export {
  confirmGradeBatch,
  GRADE_BATCH_MAX_ROWS,
  GRADE_MAX,
  GRADE_MIN,
  gradeBatchSha256,
  isGrade,
  isGradeConfirmation,
  isValidBatch,
  type GradeConfirmation,
  type IsvuCourse,
  type IsvuGradeRow,
  type IsvuListCoursesInput,
  type IsvuPort,
  type IsvuRosterRow,
  type IsvuSubmitOutcome,
  type IsvuSubmitRefusal,
} from "./port.ts";
export {
  ISVU_SETTING_FORMAT,
  ISVU_SETTING_MAX_BYTES,
  ISVU_SETTING_OFF,
  isvuPortFor,
  PRODUCTION_ISVU_SETTING,
  readIsvuSetting,
  readIsvuSettingFile,
  type IsvuMode,
  type IsvuSetting,
} from "./setting.ts";
export {
  createSyntheticIsvu,
  SYNTHETIC_INSTITUTION_KEY,
  type SyntheticIsvu,
} from "./synthetic-isvu.ts";
