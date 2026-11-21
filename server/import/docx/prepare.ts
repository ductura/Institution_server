// The preview of a DOCX import (SRV-1803, M8.2; ADR docs/adr/import-contract.md
// §2 and §3): the server reads the received bytes, builds the manifest
// `ductus-import-manifest-v1` with its three hashes and normalises the file
// name, which stays outside every hash (D-292). The manifest is checked with
// the contract's own reader and is exactly its JCS text; the database stores
// that text and its SHA-256 (RPC collaboration.prepare_import). Nothing here
// writes: the RPC decides who may import.
import { createHash, randomUUID } from "node:crypto";

import {
  canonicalImportManifestV1,
  checkImportManifestV1,
  IMPORT_MANIFEST_SCHEMA_V1,
  normalizeImportFileName,
  parseImportManifestV1Text,
  type ImportManifestV1,
  type ImportReadLimitsV1,
  type ImportReadRejectCode,
  type ImportTraceV1,
} from "../../contracts/index.ts";
import type { CanonicalDocumentV2 } from "../../domain/index.ts";

import { readDocx } from "./read-docx.ts";

export type DocxImportPreview = {
  readonly importId: string;
  readonly manifest: ImportManifestV1;
  /** The canonical JCS text of the manifest. */
  readonly manifestText: string;
  readonly manifestSha256: string;
  readonly content: CanonicalDocumentV2;
  readonly traces: readonly ImportTraceV1[];
  readonly rawByteLength: number;
  readonly fileName: string | null;
};

export type DocxImportPrepared =
  | { readonly ok: true; readonly preview: DocxImportPreview }
  | { readonly ok: false; readonly code: ImportReadRejectCode | "MANIFEST_INVALID" };

const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export function prepareDocxImport(input: {
  readonly bytes: Uint8Array;
  readonly documentId: string;
  readonly fileName: string | null;
  readonly limits: ImportReadLimitsV1;
  readonly importId?: string;
  readonly uuid?: () => string;
}): DocxImportPrepared {
  const read = readDocx(input.bytes, input.limits, input.uuid);
  if (!read.ok) return read;
  const importId = input.importId ?? randomUUID();
  const recomputed = {
    rawSha256: sha256Hex(input.bytes),
    rawByteLength: input.bytes.length,
    contentSha256: sha256Hex(read.contentCanonical),
    traces: read.traces,
  };
  const draft = {
    manifestSchema: IMPORT_MANIFEST_SCHEMA_V1,
    importId,
    documentId: input.documentId,
    importKind: "file-upload",
    fileFormat: "docx",
    ...recomputed,
  };
  // The contract's reader is the gate: a document id it refuses never gets a manifest.
  const manifestText = canonicalImportManifestV1(draft as ImportManifestV1);
  const parsed = parseImportManifestV1Text(manifestText);
  if (!parsed.ok) return { ok: false, code: "MANIFEST_INVALID" };
  const checked = checkImportManifestV1(parsed.manifest, recomputed);
  if (!checked.ok) return { ok: false, code: "MANIFEST_INVALID" };
  return {
    ok: true,
    preview: {
      importId,
      manifest: parsed.manifest,
      manifestText,
      manifestSha256: sha256Hex(manifestText),
      content: read.content,
      traces: read.traces,
      rawByteLength: input.bytes.length,
      fileName: input.fileName === null ? null : normalizeImportFileName(input.fileName),
    },
  };
}
