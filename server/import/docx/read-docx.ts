// Reads a received DOCX into a Ductura document v2 and its traces (SRV-1803,
// M8.2; ADR docs/adr/import-contract.md §4 and §7). One pure function over the
// bytes: no file system, no network, nothing from the file is run or fetched.
// The order is fixed: size, format, ZIP container, package rules, XML, the
// document, then the content bound of a segment (L2). The first failure is
// the answer, a code from the contract's closed list and nothing else.
import {
  canonicalizeJcs,
  MAX_EVIDENCE_SEGMENT_BYTES,
  validateVersionedDocument,
  type CanonicalDocumentV2,
} from "../../domain/index.ts";
import type {
  ImportReadLimitsV1,
  ImportReadRejectCode,
  ImportTraceV1,
} from "../../contracts/index.ts";

import { convertDocument } from "./convert.ts";
import { readPackage } from "./package.ts";
import { openZip } from "./zip.ts";

export type DocxRead =
  | {
      readonly ok: true;
      readonly content: CanonicalDocumentV2;
      /** JCS of the content: the text whose SHA-256 is `contentSha256`. */
      readonly contentCanonical: string;
      readonly traces: ImportTraceV1[];
    }
  | { readonly ok: false; readonly code: ImportReadRejectCode };

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function readDocx(
  bytes: Uint8Array,
  limits: ImportReadLimitsV1,
  uuid?: () => string,
): DocxRead {
  if (bytes.length === 0) return { ok: false, code: "FILE_EMPTY" };
  if (bytes.length > limits.maxInputBytes) return { ok: false, code: "FILE_TOO_LARGE" };
  if (!ZIP_MAGIC.every((byte, i) => bytes[i] === byte)) {
    return { ok: false, code: "FORMAT_NOT_ALLOWED" };
  }
  const zip = openZip(bytes, limits);
  if (!zip.ok) return zip;
  const pkg = readPackage(zip.archive, limits);
  if (!pkg.ok) return pkg;
  const converted = convertDocument(pkg.parts, uuid);
  if (converted === null) return { ok: false, code: "PACKAGE_INVALID" };
  const content: CanonicalDocumentV2 = { schemaVersion: 2, nodes: converted.nodes, sources: [] };
  // The converter only builds what document v2 takes; a refusal here is a bug, read as a broken package.
  if (!validateVersionedDocument(content).ok) return { ok: false, code: "PACKAGE_INVALID" };
  const contentCanonical = canonicalizeJcs(content);
  // L2: too much text for one segment is refused, never cut.
  if (Buffer.byteLength(contentCanonical, "utf8") > MAX_EVIDENCE_SEGMENT_BYTES) {
    return { ok: false, code: "CONTENT_TOO_LARGE" };
  }
  return { ok: true, content, contentCanonical, traces: converted.traces };
}
