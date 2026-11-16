// Public interface of server/evidence; other areas import only this file.
export {
  createEvidenceService,
  type EvidenceCommitDependencies,
  type EvidenceCommitRequest,
  type EvidenceCommitRequestOutcome,
  type EvidenceService,
} from "./service.ts";
// The wire limits of the commit route, as the domain states them: http may not
// import domain (docs/server-map.md §2), so it reads them here.
export {
  DUCTUS_ASYNC_COMMIT_PROTOCOL,
  DUCTUS_PROTOCOL_VERSION,
  MAX_COMMIT_REQUEST_BYTES,
} from "../domain/index.ts";
