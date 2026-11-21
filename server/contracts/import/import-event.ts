/**
 * The `import_event` record (SRV-1801, D-290; ADR docs/adr/import-contract.md §1).
 * One row per prepared import, written only by the server through an RPC; the
 * client never writes it. The table, its RLS and pgTAP rows come with
 * SRV-1803 (M8.2); this is the shape it stores and what each side reads.
 */
import { Type, type Static } from "@sinclair/typebox";

import { ImportFileNameV1 } from "./file-name.ts";
import { MAX_IMPORT_RAW_BYTES } from "./limits.ts";
import {
  IMPORT_FILE_FORMATS_V1,
  IMPORT_KINDS_V1,
  SHA256_HEX_PATTERN,
  UUID_V4_PATTERN,
} from "./manifest.ts";

export const IMPORT_EVENT_STATES_V1 = Object.freeze(["pending", "confirmed", "cancelled"] as const);
export type ImportEventStateV1 = (typeof IMPORT_EVENT_STATES_V1)[number];

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
const Uuid = Type.String({ pattern: UUID_V4_PATTERN });
const Sha256 = Type.String({ pattern: SHA256_HEX_PATTERN });
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const Id = Type.String({ minLength: 1, maxLength: 256 });

/**
 * The stored row in camelCase. `manifest` is the canonical JCS text of the
 * manifest; `manifestSha256` is its hash, kept beside it. `importKind`,
 * `fileFormat` and `rawByteLength` copy the manifest for queries; the manifest
 * is the source of truth. `fileName` is outside every hash (D-292).
 */
export const ImportEventRecordV1 = Type.Object(
  {
    importId: Uuid,
    ownerId: Id,
    documentId: Id,
    baseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    manifest: Type.String({ minLength: 2 }),
    manifestSha256: Sha256,
    importKind: literals(IMPORT_KINDS_V1),
    fileFormat: literals(IMPORT_FILE_FORMATS_V1),
    rawByteLength: Type.Integer({ minimum: 1, maximum: MAX_IMPORT_RAW_BYTES }),
    fileName: ImportFileNameV1,
    state: literals(IMPORT_EVENT_STATES_V1),
    preparedAt: Instant,
    /** The id of the one `import` segment event; null until confirmed (E2). */
    confirmedEventId: Type.Union([Id, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ImportEventRecordV1 = Static<typeof ImportEventRecordV1>;

/**
 * What the mentor of the work reads, through the existing access path of the
 * document (C-23: access comes from the relation, never from the role alone).
 * Only confirmed imports; no hash, manifest, owner or preparation time.
 */
export const ImportEventMentorViewV1 = Type.Object(
  {
    importId: Uuid,
    importKind: literals(IMPORT_KINDS_V1),
    fileFormat: literals(IMPORT_FILE_FORMATS_V1),
    rawByteLength: Type.Integer({ minimum: 1, maximum: MAX_IMPORT_RAW_BYTES }),
    fileName: ImportFileNameV1,
  },
  { additionalProperties: false },
);
export type ImportEventMentorViewV1 = Static<typeof ImportEventMentorViewV1>;

/** True when the row is one of the consistent combinations of state and event id. */
export function isConsistentImportEvent(record: ImportEventRecordV1): boolean {
  return record.state === "confirmed"
    ? record.confirmedEventId !== null
    : record.confirmedEventId === null;
}

/** The mentor projection of one row, or null when the mentor may not see it yet. */
export function mentorViewOfImportEvent(
  record: ImportEventRecordV1,
): ImportEventMentorViewV1 | null {
  if (record.state !== "confirmed" || !isConsistentImportEvent(record)) return null;
  return {
    importId: record.importId,
    importKind: record.importKind,
    fileFormat: record.fileFormat,
    rawByteLength: record.rawByteLength,
    fileName: record.fileName,
  };
}
