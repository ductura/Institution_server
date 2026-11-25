export type { AppError, Result } from "./result.ts";
export * from "./json/index.ts";
export * from "./document/index.ts";
export * from "./collaboration/index.ts";
export * from "./forensics/index.ts";
export * from "./evidence/index.ts";
export * from "./settings/index.ts";
export * from "./jobs/index.ts";
export * from "./assignment/index.ts";
export * from "./profile/index.ts";
export * from "./sync/index.ts";
export * from "./support/index.ts";
export * from "./text/index.ts";
export * from "./assistant/index.ts";
export * from "./declaration/index.ts";
export * from "./export-snapshot/index.ts";
export * from "./provenance-share/index.ts";
// SRV-V19-DNEVNIK-RUTE: the digest and the input checks of the practice journal.
export * from "./practice-journal/index.ts";
// SRV-V19-GRUPA-RUTE: order of team members and assembly of the contribution.
export * from "./work-team/index.ts";
// SRV-1230: the deterministic match with an answer of the assistant.
export * from "./assistant-match/index.ts";
export * from "./retention/index.ts";
export { zagrebWall, type ZagrebWall } from "./time/index.ts";
// SRV-1308: the student data export lists the access log by day, as the student reads it.
export { accessLogDaysOf, type AccessLogDay } from "./privacy/index.ts";
// Both document and evidence name a `SourceId` (Ductus keeps them in separate
// folders): the document's is the source of a citation, the evidence one the
// source of an evidence basis. The explicit exports settle which is which.
export type { SourceId } from "./document/index.ts";
export type { SourceId as EvidenceSourceId } from "./evidence/index.ts";
