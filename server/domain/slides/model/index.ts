// Public interface of server/domain/slides/model: the slides document type, its
// validator and the step reader, with no Node module (SRV-V14-PARSERI-BEZ-NODE).
// The evidence segment check imports this file, so the browser bundle can hold
// it (granica 8, #638); ../index.ts re-exports everything here unchanged.
export * from "./schema.ts";
export { isSlideText, validateSlidesDocument, type SlidesValidation } from "./validate.ts";
export {
  MAX_SLIDE_STEPS_BYTES,
  MAX_SLIDE_STEPS_PER_EVENT,
  SLIDE_STEP_FORMAT_V1,
  SLIDE_STEP_TYPES,
  parseSlideStep,
  parseSlideSteps,
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
