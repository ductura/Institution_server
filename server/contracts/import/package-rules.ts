/**
 * What an import reader refuses in a file (SRV-1801; ADR docs/adr/import-contract.md
 * §4 and §8, attack classes Z, X, K and D). PRIJEDLOG until the contract review.
 *
 * The server never runs, opens or fetches anything a file points to. A macro,
 * an embedded object or an external resource rejects the whole import; an
 * external hyperlink is the one external target allowed, and its target is
 * never fetched. A rejection carries only a code, never input content
 * (D-198 t. 5).
 */
import { Type, type Static } from "@sinclair/typebox";

/** Every code a read may end with, in a fixed order. */
export const IMPORT_READ_REJECT_CODES = Object.freeze([
  "FILE_EMPTY",
  "FILE_TOO_LARGE",
  "FORMAT_NOT_ALLOWED",
  "ZIP_INVALID",
  "ZIP_TOO_MANY_ENTRIES",
  "ZIP_PART_TOO_LARGE",
  "ZIP_TOTAL_TOO_LARGE",
  "ZIP_RATIO_EXCEEDED",
  "ZIP_ENCRYPTED",
  "ZIP_PATH_INVALID",
  "ZIP_DUPLICATE_ENTRY",
  "XML_INVALID",
  "XML_DTD",
  "XML_TOO_DEEP",
  "XML_TOO_MANY_ATTRIBUTES",
  "PACKAGE_INVALID",
  "CONTENT_TYPE_NOT_ALLOWED",
  "MACRO_PRESENT",
  "EMBEDDED_CONTENT",
  "EXTERNAL_RESOURCE",
  "CONTENT_TOO_LARGE",
  "PDF_INVALID",
  "PDF_ENCRYPTED",
  "PDF_ACTIVE_CONTENT",
  "PDF_TOO_MANY_PAGES",
] as const);
export type ImportReadRejectCode = (typeof IMPORT_READ_REJECT_CODES)[number];

/** A refused read: the code and nothing else. */
export const ImportReadRejectV1 = Type.Object(
  { code: Type.Union(IMPORT_READ_REJECT_CODES.map((code) => Type.Literal(code))) },
  { additionalProperties: false },
);
export type ImportReadRejectV1 = Static<typeof ImportReadRejectV1>;

export type PackageRuleResult = { ok: true } | { ok: false; code: ImportReadRejectCode };

const OK: PackageRuleResult = { ok: true };
const reject = (code: ImportReadRejectCode): PackageRuleResult => ({ ok: false, code });

/** The only main part a DOCX import reads: a plain, macro-free document. */
export const DOCX_MAIN_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

/** The one external relationship allowed; its target is text, never fetched. */
export const DOCX_HYPERLINK_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

// Matched on the last segment, so the Transitional, Strict and Microsoft
// namespaces of the same relationship are all caught.
const MACRO_RELATIONSHIPS: ReadonlySet<string> = new Set([
  "vbaProject",
  "wordVbaData",
  "vbaProjectSignature",
]);
const EMBEDDED_RELATIONSHIPS: ReadonlySet<string> = new Set([
  "oleObject",
  "package",
  "aFChunk",
  "control",
  "activeXControlBinary",
  "attachedTemplate",
  "subDocument",
  "frame",
]);

const MACRO_CONTENT_TYPE =
  /^application\/vnd\.ms-(?:word\.(?:document|template)\.macroenabled(?:template)?\.main\+xml|office\.vbaproject(?:signature)?)$/u;
const EMBEDDED_CONTENT_TYPE =
  /^application\/vnd\.ms-office\.activex(?:\+xml)?$|^application\/vnd\.openxmlformats-officedocument\.oleobject$/u;

function lastSegment(uri: string): string {
  const parts = uri.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * One relationship of a DOCX package (`_rels/*.rels`). An unknown target mode
 * is a broken package; a macro or embedding is refused whatever its mode; any
 * external target other than a hyperlink is refused (no template, image,
 * frame or subdocument is ever fetched).
 */
export function checkDocxRelationship(type: unknown, targetMode: unknown): PackageRuleResult {
  if (typeof type !== "string" || type === "") return reject("PACKAGE_INVALID");
  if (targetMode !== undefined && targetMode !== "Internal" && targetMode !== "External")
    return reject("PACKAGE_INVALID");
  const name = lastSegment(type);
  if (MACRO_RELATIONSHIPS.has(name)) return reject("MACRO_PRESENT");
  if (EMBEDDED_RELATIONSHIPS.has(name))
    return reject(targetMode === "External" ? "EXTERNAL_RESOURCE" : "EMBEDDED_CONTENT");
  if (targetMode === "External" && type !== DOCX_HYPERLINK_RELATIONSHIP)
    return reject("EXTERNAL_RESOURCE");
  return OK;
}

/** One content type of `[Content_Types].xml`, compared without case. */
export function checkDocxContentType(contentType: unknown): PackageRuleResult {
  if (typeof contentType !== "string" || contentType === "") return reject("PACKAGE_INVALID");
  const type = contentType.trim().toLowerCase();
  if (MACRO_CONTENT_TYPE.test(type)) return reject("MACRO_PRESENT");
  if (EMBEDDED_CONTENT_TYPE.test(type)) return reject("EMBEDDED_CONTENT");
  return OK;
}

/** The main document part: only {@link DOCX_MAIN_CONTENT_TYPE}; a template or macro document is refused. */
export function checkDocxMainContentType(contentType: unknown): PackageRuleResult {
  const part = checkDocxContentType(contentType);
  if (!part.ok) return part;
  return (contentType as string).trim().toLowerCase() === DOCX_MAIN_CONTENT_TYPE
    ? OK
    : reject("CONTENT_TYPE_NOT_ALLOWED");
}
