// The OPC package of a DOCX (SRV-1803, M8.2; ADR docs/adr/import-contract.md
// §7, attack class K). Every content type of [Content_Types].xml and every
// relationship of every .rels part goes through the package rules of the
// contract, before the document is read: a macro, an embedded object or an
// external resource refuses the whole import, and nothing a relationship
// names is ever opened, run or fetched. A part name that only a macro or an
// embedding uses is refused as well, even when no relationship names it (K1,
// Z4). Only the main document, its comments and its styles are read.
import {
  checkDocxContentType,
  checkDocxMainContentType,
  checkDocxRelationship,
  type ImportReadLimitsV1,
  type ImportReadRejectCode,
} from "../../contracts/index.ts";

import { attributeOf, elementsOf, readXml, type XmlElement } from "./xml.ts";
import type { ZipArchive } from "./zip.ts";

const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

export type DocxParts = {
  readonly document: XmlElement;
  readonly styles: XmlElement | null;
  readonly comments: XmlElement | null;
};
export type PackageRead =
  | { readonly ok: true; readonly parts: DocxParts }
  | { readonly ok: false; readonly code: ImportReadRejectCode };

/** Thrown inside the package reader; turned into a refusal at its edge. */
class Refusal extends Error {
  readonly code: ImportReadRejectCode;
  constructor(code: ImportReadRejectCode) {
    super(code);
    this.code = code;
  }
}

type Relationship = { type: string; target: string; external: boolean };

function lastSegment(uri: string): string {
  return uri.split("/").at(-1) ?? "";
}

/** A part name that only macros or embedded objects use (K1, K3, Z4). */
function forbiddenPartName(name: string): ImportReadRejectCode | null {
  const lower = name.toLowerCase();
  const file = lower.split("/").at(-1) ?? "";
  if (/^vbaproject(?:signature)?\.bin$|^vbadata\.xml$/u.test(file)) return "MACRO_PRESENT";
  if (/(^|\/)(?:embeddings|activex)\//u.test(lower)) return "EMBEDDED_CONTENT";
  return null;
}

/** Resolves an internal target against the folder of its source part, inside the package. */
function resolveTarget(sourceFolder: string, target: string): string {
  const joined = target.startsWith("/") ? target.slice(1) : `${sourceFolder}${target}`;
  const parts: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) throw new Refusal("PACKAGE_INVALID");
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  if (parts.length === 0) throw new Refusal("PACKAGE_INVALID");
  return parts.join("/");
}

export function readPackage(archive: ZipArchive, limits: ImportReadLimitsV1): PackageRead {
  try {
    return { ok: true, parts: read(archive, limits) };
  } catch (thrown) {
    if (thrown instanceof Refusal) return { ok: false, code: thrown.code };
    throw thrown;
  }
}

function read(archive: ZipArchive, limits: ImportReadLimitsV1): DocxParts {
  const xmlLimits = { maxDepth: limits.maxXmlDepth, maxAttributes: limits.maxXmlAttributes };
  const xmlOf = (name: string): XmlElement => {
    const part = archive.read(name);
    if (!part.ok) throw new Refusal(part.code);
    const xml = readXml(part.bytes, xmlLimits);
    if (!xml.ok) throw new Refusal(xml.code);
    return xml.root;
  };
  const has = (name: string) => archive.entries.has(name.toLowerCase());

  for (const entry of archive.entries.values()) {
    const code = forbiddenPartName(entry.name);
    if (code !== null) throw new Refusal(code);
  }

  // Content types: every Default and Override passes the contract's rule.
  if (!has("[Content_Types].xml")) throw new Refusal("PACKAGE_INVALID");
  const types = xmlOf("[Content_Types].xml");
  if (types.ns !== CONTENT_TYPES_NS || types.local !== "Types")
    throw new Refusal("PACKAGE_INVALID");
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const item of elementsOf(types)) {
    const contentType = attributeOf(item, "", "ContentType");
    const rule = checkDocxContentType(contentType);
    if (!rule.ok) throw new Refusal(rule.code);
    if (item.ns === CONTENT_TYPES_NS && item.local === "Default") {
      const extension = attributeOf(item, "", "Extension");
      if (extension === undefined || extension === "") throw new Refusal("PACKAGE_INVALID");
      defaults.set(extension.toLowerCase(), contentType!);
    } else if (item.ns === CONTENT_TYPES_NS && item.local === "Override") {
      const partName = attributeOf(item, "", "PartName");
      if (partName === undefined || !partName.startsWith("/")) throw new Refusal("PACKAGE_INVALID");
      overrides.set(partName.slice(1).toLowerCase(), contentType!);
    } else {
      throw new Refusal("PACKAGE_INVALID");
    }
  }
  const contentTypeOf = (part: string): string | undefined => {
    const lower = part.toLowerCase();
    return overrides.get(lower) ?? defaults.get(lower.split(".").at(-1) ?? "");
  };

  // Every relationship of every .rels part, also of parts nobody reads.
  const relationshipsOf = new Map<string, Relationship[]>();
  for (const entry of archive.entries.values()) {
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith(".rels")) continue;
    const match = /^(.*?)_rels\/([^/]*)\.rels$/u.exec(entry.name);
    if (match === null) throw new Refusal("PACKAGE_INVALID");
    const folder = match[1]!;
    const source = `${folder}${match[2]!}`.toLowerCase();
    const root = xmlOf(entry.name);
    if (root.ns !== RELATIONSHIPS_NS || root.local !== "Relationships") {
      throw new Refusal("PACKAGE_INVALID");
    }
    const list: Relationship[] = [];
    for (const item of elementsOf(root)) {
      if (item.ns !== RELATIONSHIPS_NS || item.local !== "Relationship") {
        throw new Refusal("PACKAGE_INVALID");
      }
      const type = attributeOf(item, "", "Type");
      const mode = attributeOf(item, "", "TargetMode");
      const rule = checkDocxRelationship(type, mode);
      if (!rule.ok) throw new Refusal(rule.code);
      const target = attributeOf(item, "", "Target");
      if (target === undefined || target === "") throw new Refusal("PACKAGE_INVALID");
      const external = mode === "External";
      list.push({
        type: type!,
        target: external ? target : resolveTarget(folder, target),
        external,
      });
    }
    relationshipsOf.set(source, list);
  }

  const internal = (source: string, kind: string): string[] =>
    (relationshipsOf.get(source) ?? [])
      .filter((r) => !r.external && lastSegment(r.type) === kind)
      .map((r) => r.target);

  const main = internal("", "officeDocument");
  if (main.length !== 1 || !has(main[0]!)) throw new Refusal("PACKAGE_INVALID");
  const mainPart = main[0]!;
  const mainRule = checkDocxMainContentType(contentTypeOf(mainPart));
  if (!mainRule.ok) throw new Refusal(mainRule.code);

  const single = (kind: string): XmlElement | null => {
    const targets = internal(mainPart.toLowerCase(), kind);
    if (targets.length > 1) throw new Refusal("PACKAGE_INVALID");
    const target = targets[0];
    if (target === undefined) return null;
    if (!has(target)) throw new Refusal("PACKAGE_INVALID");
    return xmlOf(target);
  };
  return { document: xmlOf(mainPart), styles: single("styles"), comments: single("comments") };
}
