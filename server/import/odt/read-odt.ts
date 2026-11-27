// Reads a received ODT into a Ductura document v2 and its traces (F4-PM2-R18
// step 3; ADR docs/adr/import-manifest-v2.md §2, §2a and §4 t. 3). One pure
// function over the bytes, the same shape as readDocx and the same read limits
// (B-8 input, ZIP entries, inflated sizes and ratio, XML depth and
// attributes): the ZIP and XML readers are the DOCX ones, so paths with ".."
// or a leading "/", a DTD or an entity declaration and a zip bomb are refused
// the same way. The order is fixed: size, format (mimetype first and exact),
// ZIP container, package (META-INF/manifest.xml), content.xml, the document,
// then the content bound of a segment (L2). meta.xml, styles.xml and
// settings.xml are never read: no author, date or title enters the result.
// An encrypted ODT and active content (Basic and script parts, office:scripts,
// event listeners, embedded objects) refuse the whole import with the codes
// the contract already has (ADR "Otvoreno za review" t. 5); nothing from the
// file is run, opened or fetched.
import {
  canonicalizeJcs,
  decodeStrictUtf8,
  MAX_EVIDENCE_SEGMENT_BYTES,
  validateVersionedDocument,
  type CanonicalDocumentV2,
} from "../../domain/index.ts";
import type {
  ImportReadLimitsV1,
  ImportReadRejectCode,
  ImportTraceV1,
} from "../../contracts/index.ts";

import { elementsOf, openZip, readXml, type XmlElement, type ZipArchive } from "../docx/index.ts";

import { ContentTooLarge, convertContent, OFFICE_NS } from "./convert.ts";
import { hasOdtSignature, ODT_MIMETYPE } from "./signature.ts";

export type OdtRead =
  | {
      readonly ok: true;
      readonly content: CanonicalDocumentV2;
      /** JCS of the content: the text whose SHA-256 is `contentSha256`. */
      readonly contentCanonical: string;
      readonly traces: ImportTraceV1[];
    }
  | { readonly ok: false; readonly code: ImportReadRejectCode };

const MANIFEST_NS = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const SCRIPT_NS = "urn:oasis:names:tc:opendocument:xmlns:script:1.0";
const DRAW_NS = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
const EMBEDDED_ELEMENTS: ReadonlySet<string> = new Set([
  "object",
  "object-ole",
  "plugin",
  "applet",
]);

type Refused = { readonly ok: false; readonly code: ImportReadRejectCode };
const refuse = (code: ImportReadRejectCode): Refused => ({ ok: false, code });

/** Every element under `root`, root included; depth is bounded by the XML reader. */
function* walk(root: XmlElement): Generator<XmlElement> {
  const stack: XmlElement[] = [root];
  for (let element = stack.pop(); element !== undefined; element = stack.pop()) {
    yield element;
    stack.push(...elementsOf(element));
  }
}

/** A part only macros or embedded objects use, by its (lowercase) name. */
function activePart(archive: ZipArchive): ImportReadRejectCode | null {
  for (const key of archive.entries.keys()) {
    if (/^(?:basic|scripts)\//u.test(key)) return "MACRO_PRESENT";
    if (/^object[ _]?[0-9]+\//u.test(key)) return "EMBEDDED_CONTENT";
  }
  return null;
}

function activeContent(content: XmlElement): ImportReadRejectCode | null {
  for (const element of walk(content)) {
    if (element.ns === SCRIPT_NS) return "MACRO_PRESENT";
    if (
      element.ns === OFFICE_NS &&
      (element.local === "scripts" || element.local === "event-listeners") &&
      elementsOf(element).length > 0
    )
      return "MACRO_PRESENT";
    if (element.ns === DRAW_NS && EMBEDDED_ELEMENTS.has(element.local)) return "EMBEDDED_CONTENT";
  }
  return null;
}

export function readOdt(
  bytes: Uint8Array,
  limits: ImportReadLimitsV1,
  uuid?: () => string,
): OdtRead {
  if (bytes.length === 0) return refuse("FILE_EMPTY");
  if (bytes.length > limits.maxInputBytes) return refuse("FILE_TOO_LARGE");
  if (!hasOdtSignature(bytes)) return refuse("FORMAT_NOT_ALLOWED");
  const zip = openZip(bytes, limits);
  if (!zip.ok) return zip;
  const { archive } = zip;
  const mimetype = archive.read("mimetype");
  if (!mimetype.ok) return mimetype;
  // The entry the signature saw, now inflated and CRC-checked: exactly the type, nothing around it.
  if (decodeStrictUtf8(mimetype.bytes) !== ODT_MIMETYPE) return refuse("FORMAT_NOT_ALLOWED");
  const active = activePart(archive);
  if (active !== null) return refuse(active);

  const xmlLimits = { maxDepth: limits.maxXmlDepth, maxAttributes: limits.maxXmlAttributes };
  const xmlOf = (name: string): { ok: true; root: XmlElement } | Refused => {
    const part = archive.read(name);
    if (!part.ok) return part;
    return readXml(part.bytes, xmlLimits);
  };
  const manifest = xmlOf("META-INF/manifest.xml");
  if (!manifest.ok) return manifest;
  if (manifest.root.ns !== MANIFEST_NS || manifest.root.local !== "manifest")
    return refuse("PACKAGE_INVALID");
  for (const element of walk(manifest.root)) {
    if (element.ns === MANIFEST_NS && element.local === "encryption-data")
      return refuse("ZIP_ENCRYPTED");
  }
  const contentXml = xmlOf("content.xml");
  if (!contentXml.ok) return contentXml;
  const activeCode = activeContent(contentXml.root);
  if (activeCode !== null) return refuse(activeCode);

  let converted;
  try {
    converted = convertContent(contentXml.root, uuid);
  } catch (thrown) {
    if (thrown instanceof ContentTooLarge) return refuse("CONTENT_TOO_LARGE");
    throw thrown;
  }
  if (converted === null) return refuse("PACKAGE_INVALID");
  const content: CanonicalDocumentV2 = { schemaVersion: 2, nodes: converted.nodes, sources: [] };
  // The converter only builds what document v2 takes; a refusal here is a bug, read as a broken package.
  if (!validateVersionedDocument(content).ok) return refuse("PACKAGE_INVALID");
  const contentCanonical = canonicalizeJcs(content);
  // L2: too much text for one segment is refused, never cut.
  if (Buffer.byteLength(contentCanonical, "utf8") > MAX_EVIDENCE_SEGMENT_BYTES) {
    return refuse("CONTENT_TOO_LARGE");
  }
  return { ok: true, content, contentCanonical, traces: converted.traces };
}
