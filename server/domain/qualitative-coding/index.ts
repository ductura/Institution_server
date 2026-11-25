// Public interface of server/domain/qualitative-coding; other folders import only this file.
export {
  MATERIAL_KINDS,
  MAX_MATERIALS_PER_PERSON,
  MAX_MATERIAL_BODY_LENGTH,
  MAX_MATERIAL_TITLE_LENGTH,
  isMaterialBody,
  isMaterialKind,
  isMaterialTitle,
  normalizeBody,
  paragraphsOf,
  type MaterialKind,
} from "./material.ts";
export {
  MAX_MEMO_LENGTH,
  MAX_QUOTE_LENGTH,
  MAX_SEGMENTS_PER_MATERIAL,
  isAnchorOfText,
  isMemo,
  type Anchor,
} from "./anchor.ts";
export {
  MAX_CODES_PER_PERSON,
  MAX_CODE_DESCRIPTION_LENGTH,
  MAX_CODE_NAME_LENGTH,
  isCodeDescription,
  isCodeName,
  moveCode,
  sameCodeName,
  type CodebookEntry,
} from "./codebook.ts";
export {
  QUALITATIVE_EXPORT_SCHEMA,
  buildQualitativeExport,
  type ExportSegmentInput,
  type QualitativeExport,
} from "./export.ts";
