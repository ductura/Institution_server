import { createHash, randomUUID } from "node:crypto";

import {
  canonicalImportManifestV1,
  checkImportManifestV1,
  IMPORT_MANIFEST_SCHEMA_V1,
  normalizeImportFileName,
  parseImportManifestV1Text,
  type ImportReadLimitsV1,
} from "../../contracts/index.ts";

import { readPdfInWorker } from "./worker.ts";

export { hasPdfHeader } from "./signature.ts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function preparePdfImport(input: {
  bytes: Uint8Array;
  documentId: string;
  fileName: string | null;
  limits: ImportReadLimitsV1;
}) {
  const rawSha256 = sha256(input.bytes);
  const rawByteLength = input.bytes.byteLength;
  const read = await readPdfInWorker({ bytes: input.bytes, limits: input.limits });
  if (!read.ok) return read;
  const importId = randomUUID();
  const hashes = { rawSha256, rawByteLength, contentSha256: sha256(read.contentCanonical) };
  const manifestText = canonicalImportManifestV1({
    manifestSchema: IMPORT_MANIFEST_SCHEMA_V1,
    importId,
    documentId: input.documentId,
    importKind: "file-upload",
    fileFormat: "pdf",
    ...hashes,
  });
  const parsed = parseImportManifestV1Text(manifestText);
  if (!parsed.ok || !checkImportManifestV1(parsed.manifest, hashes).ok) {
    return { ok: false, code: "MANIFEST_INVALID" } as const;
  }
  return {
    ok: true,
    preview: {
      importId,
      manifest: parsed.manifest,
      manifestText,
      manifestSha256: sha256(manifestText),
      content: read.content,
      rawByteLength,
      fileName: input.fileName === null ? null : normalizeImportFileName(input.fileName),
    },
  } as const;
}
