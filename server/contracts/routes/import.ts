import { Type } from "@sinclair/typebox";

import {
  ImportConfirmBodyV1,
  ImportConfirmResponseV1,
  ImportFileNameV1,
  ImportTraceV1,
  IMPORT_TRACE_KINDS_V1,
  MAX_IMPORT_RAW_BYTES,
  SHA256_HEX_PATTERN,
  UUID_V4_PATTERN,
} from "../import/index.ts";
import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1803 (M8.2 and M8.2b, DAN-396; D-282, D-290 to D-292; contract
// docs/adr/import-contract.md, SRV-1801): a DOCX import into a work. The
// student owner sends the file; the server reads it (limits, package rules,
// no macro, embedded object or external resource), builds the manifest
// ductus-import-manifest-v1 with its three hashes and answers a preview: the
// content as document v2, marked evidenceKind "imported" and source "import",
// never "observed". Nothing enters the work until the student confirms the
// reviewed manifest hash; the confirmation is idempotent and gives the one
// event of the import. Only while the current version of the assignment has
// "Dopušten uvoz" on (off by default; a new version may only turn it off) and
// the work is not submitted. Identity, role, institution, revision and time
// never come from the body. Written through collaboration.import_gate,
// prepare_import and confirm_import (server/database/import).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const ImportId = Type.String({ pattern: UUID_V4_PATTERN });
const Sha256 = Type.String({ pattern: SHA256_HEX_PATTERN });
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});

/** Standard Base64 of at most MAX_IMPORT_RAW_BYTES bytes. */
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMPORT_RAW_BYTES / 3);
const FileBase64 = Type.String({
  minLength: 4,
  maxLength: MAX_BASE64_LENGTH,
  pattern: "^[A-Za-z0-9+/]+={0,2}(?![\\s\\S])",
});
/** The name as the client had it; the server keeps only its normalised form (D-292). */
const MAX_RAW_FILE_NAME_LENGTH = 1024;

// Document v2 as an import builds it: paragraphs, headings 1 to 3, list items
// and quotes of text with bold and italic; no citation and no source.
const NodeId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const Text = closed({
  type: Type.Literal("text"),
  text: Type.String({ minLength: 1 }),
  /** Canonical order: bold before italic, each at most once. */
  marks: Type.Array(Type.Union([Type.Literal("bold"), Type.Literal("italic")]), {
    maxItems: 2,
    uniqueItems: true,
  }),
});
const children = Type.Array(Text);
const Block = Type.Union([
  closed({ type: Type.Literal("paragraph"), id: NodeId, children }),
  closed({
    type: Type.Literal("heading"),
    id: NodeId,
    level: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    children,
  }),
  closed({ type: Type.Literal("bulletItem"), id: NodeId, children }),
  closed({ type: Type.Literal("quote"), id: NodeId, children }),
]);
const Content = closed({
  schemaVersion: Type.Literal(2),
  nodes: Type.Array(Block, { minItems: 1 }),
  sources: Type.Array(closed({}), { maxItems: 0 }),
});

const params = closed({ documentId: WorkId });
const confirmParams = closed({ documentId: WorkId, importId: ImportId });

export const workImportsPost = defineRoute({
  id: "work.imports.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/imports",
  inventory: "app/api/works/[documentId]/imports/route.ts",
  access: "student_owner",
  summary:
    "The student owner sends a DOCX of the work as standard Base64, at most 2 MiB (2 097 152 bytes), with the file name or null, as application/json. The server reads it within the limits of the import contract and refuses a macro, an embedded object or an external resource; nothing from the file is run or fetched. 201 is a preview, not yet part of the work: importId, manifestSha256 (SHA-256 of the canonical manifest ductus-import-manifest-v1 built from the received bytes), source import, evidenceKind imported, the content as document v2, the traces counted (comment, deletion, insertion; never an author or date), rawByteLength, the normalised file name (outside every hash, D-292) or null, baseRevision and expiresAt (60 minutes). Confirm it with work.imports.confirm.post. A file above the limit is 413 body_too_large, a file the reader refuses 422 invalid_document, an assignment without import allowed or a submitted work 403 import_not_allowed; a teacher, another's, an unknown or a malformed work is 404.",
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: MAX_BASE64_LENGTH + MAX_RAW_FILE_NAME_LENGTH * 6 + 64,
    body: closed({
      fileBase64: FileBase64,
      fileName: Type.Union([Type.String({ maxLength: MAX_RAW_FILE_NAME_LENGTH }), Type.Null()]),
    }),
  },
  responses: [
    {
      status: 201,
      description: "the preview of the import, waiting for the student's confirmation",
      body: closed({
        importId: ImportId,
        manifestSha256: Sha256,
        source: Type.Literal("import"),
        evidenceKind: Type.Literal("imported"),
        fileFormat: Type.Literal("docx"),
        content: Content,
        traces: Type.Array(ImportTraceV1, { maxItems: IMPORT_TRACE_KINDS_V1.length }),
        rawByteLength: Type.Integer({ minimum: 1, maximum: MAX_IMPORT_RAW_BYTES }),
        fileName: ImportFileNameV1,
        baseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        expiresAt: Instant,
      }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(422, "invalid_document"),
    error(403, "import_not_allowed"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const workImportsConfirmPost = defineRoute({
  id: "work.imports.confirm.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/imports/{importId}/confirm",
  inventory: "app/api/works/[documentId]/imports/[importId]/confirm/route.ts",
  access: "student_owner",
  summary:
    "The student owner confirms a reviewed import: {importId, manifestSha256} as application/json, at most 1 KiB, the importId equal to the one in the path. The first confirmation and every retry answer the same 200 {importId, eventId}: one import gives exactly one event, also when two tabs confirm at once. Another's, a teacher's, an unknown or a malformed import is 404 import_not_found; another reviewed hash 409 import_manifest_mismatch; after 60 minutes 410 import_expired; an assignment that no longer allows import or a submitted work 403 import_not_allowed; a revision committed since the preview 409 import_revision_changed. A confirmed import stays confirmed.",
  request: {
    params: confirmParams,
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: ImportConfirmBodyV1,
  },
  responses: [
    {
      status: 200,
      description: "confirmed, or the same confirmation again",
      body: ImportConfirmResponseV1,
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "import_not_found"),
    error(409, "import_manifest_mismatch"),
    error(410, "import_expired"),
    error(403, "import_not_allowed"),
    error(409, "import_revision_changed"),
    error(503, "unavailable"),
  ],
});

export const importRoutes = [workImportsPost, workImportsConfirmPost] as const;
