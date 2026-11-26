// Public interface of server/domain/slides; other folders import only this file.
// The document type, its validator and the step reader, with no Node module
// (SRV-V14-PARSERI-BEZ-NODE); the hash of a removal is in ./step-hash.ts.
export * from "./model/index.ts";
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
export { slideTextSha256 } from "./step-hash.ts";
export {
  applySlideStep,
  applySlideSteps,
  slideNodeSha256,
  type ApplySlideStep,
  type ApplySlideStepErrorCode,
  type ApplySlideSteps,
} from "./apply.ts";
