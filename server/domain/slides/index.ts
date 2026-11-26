// Public interface of server/domain/slides; other folders import only this file.
export * from "./schema.ts";
export { isSlideText, validateSlidesDocument, type SlidesValidation } from "./validate.ts";
export {
  slidesDocumentsEqual,
  slidesSnapshotSha256,
  slidesSnapshotText,
  verifySlidesSnapshot,
  type SlidesSnapshotVerification,
} from "./snapshot.ts";
export {
  SLIDES_REVISION_ZERO_JCS,
  SLIDES_REVISION_ZERO_SHA256,
  SLIDES_REVISION_ZERO_SLIDE_ID,
  slidesRevisionZeroDocument,
} from "./revision-zero.ts";
export {
  MAX_SLIDE_STEPS_BYTES,
  MAX_SLIDE_STEPS_PER_EVENT,
  SLIDE_STEP_FORMAT_V1,
  SLIDE_STEP_TYPES,
  parseSlideStep,
  parseSlideSteps,
  slideTextSha256,
  type BlockRemoveStep,
  type BlockSetStep,
  type LayoutSetStep,
  type NotesRemoveStep,
  type NotesSetStep,
  type SlideAddStep,
  type SlideMoveStep,
  type SlideRemoveStep,
  type SlideStep,
  type SlideStepErrorCode,
  type SlideStepParse,
  type SlideStepsParse,
  type SlideStepType,
  type TextEditStep,
} from "./steps.ts";
export {
  applySlideStep,
  applySlideSteps,
  slideNodeSha256,
  type ApplySlideStep,
  type ApplySlideStepErrorCode,
  type ApplySlideSteps,
} from "./apply.ts";
