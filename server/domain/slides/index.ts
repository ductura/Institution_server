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
