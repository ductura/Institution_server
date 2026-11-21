// The preview of a PDF import (SRV-1804, M8.3; ADR docs/adr/import-contract.md
// §2 and §3): the same manifest `ductus-import-manifest-v1` with its three
// hashes as for DOCX, except that a PDF manifest has no `traces` key at all
// (M9). The file name stays outside every hash (D-292). The manifest is
// checked with the contract's own reader and is exactly its JCS text.
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
} from "../../contracts/index.ts";
import type { CanonicalDocumentV2 } from "../../domain/index.ts";

import { readPdf } from "./read-pdf.ts";

export type PdfImportPreview = {
  readonly importId: string;
  readonly manifest: ImportManifestV1;
  /** The canonical JCS text of the manifest. */
  readonly manifestText: string;
  readonly manifestSha256: string;
  readonly content: CanonicalDocumentV2;
  /** A PDF has no traces; always empty. */
  readonly traces: readonly [];
  readonly rawByteLength: number;
  readonly fileName: string | null;
};

export type PdfImportPrepared =
  | { readonly ok: true; readonly preview: PdfImportPreview }
  | { readonly ok: false; readonly code: ImportReadRejectCode | "MANIFEST_INVALID" };

const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export async function preparePdfImport(input: {
  readonly bytes: Uint8Array;
  readonly documentId: string;
  readonly fileName: string | null;
  readonly limits: ImportReadLimitsV1;
  readonly importId?: string;
  readonly uuid?: () => string;
}): Promise<PdfImportPrepared> {
  const read = await readPdf(input.bytes, input.limits, input.uuid);
  if (!read.ok) return read;
  const importId = input.importId ?? randomUUID();
  const recomputed = {
    rawSha256: sha256Hex(input.bytes),
    rawByteLength: input.bytes.length,
    contentSha256: sha256Hex(read.contentCanonical),
  };
  const draft = {
    manifestSchema: IMPORT_MANIFEST_SCHEMA_V1,
    importId,
    documentId: input.documentId,
    importKind: "file-upload",
    fileFormat: "pdf",
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
      traces: [],
      rawByteLength: input.bytes.length,
      fileName: input.fileName === null ? null : normalizeImportFileName(input.fileName),
    },
  };
}
