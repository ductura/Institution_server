/**
 * Institution exit contract (SRV-1810, plan M10.6-P01, D-274 MQ12, F-04): the
 * package with all data of an institution that the operator hands to a named
 * recipient on the institution's written request, and its manifest. The
 * contract only; the job, the console and the delivery are M10.6-P02 and
 * P03, after the pilot. Nothing here builds a table, RPC or route, and users
 * have no route for it (ADR docs/adr/institution-exit.md).
 *
 * Two things are fixed by the type and not by a flag: the actor is always the
 * operator, and the export deletes nothing (`deletesNothing` is the literal
 * `true`, `deletion` is the literal `"none"`).
 */
import { Type, type Static } from "@sinclair/typebox";

export const INSTITUTION_EXIT_SCHEMA_V1 = "ductura-institution-exit-v1";
/** Who starts an exit. Never an institution administrator, a student or a teacher. */
export const INSTITUTION_EXIT_ACTOR_V1 = "operator";
export const INSTITUTION_EXIT_STATES_V1 = Object.freeze([
  "requested",
  "running",
  "ready",
  "handed_over",
  "failed",
] as const);
export type InstitutionExitStateV1 = (typeof INSTITUTION_EXIT_STATES_V1)[number];

/** Data classes of Ductus docs/privacy/06-klase-podataka.md §2: 30 classes. */
export const INSTITUTION_EXIT_CLASS_COUNT = 30;
export const MAX_EXIT_FILES = 200;
/** Same bound as the retention reference of the legal hold (SRV-1304 family): short, never a legal description. */
export const MAX_WRITTEN_REQUEST_REF_LENGTH = 120;

export const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
export const SHA256_PATTERN = "^[0-9a-f]{64}$";
const INSTANT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
/** `data/<name>.jsonl` or `manifest.json`-adjacent plain names: lowercase, no path separators, no dots but one extension. */
export const EXIT_FILE_PATH_PATTERN = "^data/[a-z0-9][a-z0-9-]{0,62}\\.(jsonl|bin)$";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const Sha256 = Type.String({ pattern: SHA256_PATTERN });

/**
 * The institution's written request, as the operator records it. The
 * reference is the registry number of the letter; the text of the letter and
 * any personal data stay out. The recipient is a label of the named
 * recipient, never an address or an account.
 */
export const InstitutionExitRequestV1 = Type.Object(
  {
    institutionId: Uuid,
    writtenRequestRef: Type.String({ minLength: 1, maxLength: MAX_WRITTEN_REQUEST_REF_LENGTH }),
    recipientLabel: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
);
export type InstitutionExitRequestV1 = Static<typeof InstitutionExitRequestV1>;

export const InstitutionExitFileV1 = Type.Object(
  {
    path: Type.String({ pattern: EXIT_FILE_PATH_PATTERN }),
    /** Class number 1..30 of the file; one class may span several files. */
    dataClass: Type.Integer({ minimum: 1, maximum: INSTITUTION_EXIT_CLASS_COUNT }),
    rowCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    byteLength: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    sha256: Sha256,
  },
  { additionalProperties: false },
);
export type InstitutionExitFileV1 = Static<typeof InstitutionExitFileV1>;

/** `manifest.json` of the package. The hash of the manifest is kept beside it, never in it. */
export const InstitutionExitManifestV1 = Type.Object(
  {
    manifestSchema: Type.Literal(INSTITUTION_EXIT_SCHEMA_V1),
    exitId: Uuid,
    institutionId: Uuid,
    writtenRequestRef: Type.String({ minLength: 1, maxLength: MAX_WRITTEN_REQUEST_REF_LENGTH }),
    recipientLabel: Type.String({ minLength: 1, maxLength: 120 }),
    startedBy: Type.Literal(INSTITUTION_EXIT_ACTOR_V1),
    generatedAt: Type.String({ pattern: INSTANT_PATTERN }),
    /** The export reads; it never deletes or changes retention (D-274 MQ12). */
    deletesNothing: Type.Literal(true),
    files: Type.Array(InstitutionExitFileV1, { maxItems: MAX_EXIT_FILES }),
  },
  { additionalProperties: false },
);
export type InstitutionExitManifestV1 = Static<typeof InstitutionExitManifestV1>;

/** The record of the handover: the one thing that is written when the package is given away. */
export const InstitutionExitHandoverV1 = Type.Object(
  {
    exitId: Uuid,
    manifestSha256: Sha256,
    recipientLabel: Type.String({ minLength: 1, maxLength: 120 }),
    handedOverAt: Type.String({ pattern: INSTANT_PATTERN }),
    deletion: Type.Literal("none"),
  },
  { additionalProperties: false },
);
export type InstitutionExitHandoverV1 = Static<typeof InstitutionExitHandoverV1>;

/** What the exit never does. The list is closed; a test pins it. */
export const INSTITUTION_EXIT_NEVER_V1 = Object.freeze([
  "delete-data",
  "change-retention",
  "release-legal-hold",
  "start-from-user-route",
] as const);

export const INSTITUTION_EXIT_REJECT_CODES_V1 = Object.freeze([
  "MANIFEST_INVALID",
  "FILES_NOT_SORTED",
  "FILE_PATH_DUPLICATE",
  "DATA_CLASS_MISSING",
] as const);
export type InstitutionExitRejectCodeV1 = (typeof INSTITUTION_EXIT_REJECT_CODES_V1)[number];
