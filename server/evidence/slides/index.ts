// Public interface of server/evidence/slides; the area exports it through server/evidence/index.ts.
export {
  verifySlidesCommit,
  workKindOfContext,
  type EvidenceWorkKind,
  type SlidesCommitInput,
  type SlidesCommitVerdict,
} from "./commit-dispatch.ts";
export { replaySlidesSegments, slidesStepReplayer } from "./reconstruct.ts";
