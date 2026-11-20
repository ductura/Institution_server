/**
 * Structural validation of an untrusted canonical document.
 *
 * Input may come from the network, from IndexedDB or from an older client, so
 * nothing is trusted: unknown fields are rejected rather than ignored, and the
 * returned document is a fresh copy built only from known fields, so a caller
 * cannot later mutate the validated value through the untrusted reference.
 *
 * Validation never repairs. Anything repairable (mark order, adjacent text
 * runs with identical marks) is reported so the caller can decide to run
 * `normalizeDocument` explicitly — a silent rewrite of an author's document
 * is exactly what this kernel must not do.
 */

import {
  DOCUMENT_BLOCK_TYPES_BY_VERSION,
  DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_SCHEMA_VERSION_V2,
  DOCUMENT_SCHEMA_VERSION_V3,
  MAX_CITATION_LOCATOR_CODE_POINTS,
  MAX_CITATION_VIA_CODE_POINTS,
  MAX_FOOTNOTE_TEXT_CODE_POINTS,
  isAcceptedDocumentSchemaVersion,
  isCrossReferenceTarget,
  isHeadingLevel,
  isMark,
  isPlainBlockType,
  isNodeId,
  isRequestId,
  isSourceId,
  marksAreCanonical,
  type CanonicalDocument,
  type CitationNodeV3,
  type CrossReferenceNode,
  type DocumentNode,
  type DocumentNodeV3,
  type FootnoteNode,
  type DocumentSchemaVersion,
  type InlineNode,
  type InlineNodeV3,
  type HeadingLevel,
  type Mark,
  type NodeId,
  type VersionedDocument,
} from "./schema.ts";
import { isAllowedText, isAllowedTrimmedText } from "./forbidden.ts";
import { checkUnknownFields, validateSources } from "./validate-sources.ts";
import { isPlainObject } from "../json/index.ts";

/** Stable error codes. Never renamed without a schema version bump. */
export const VALIDATION_ERROR_CODES = [
  "DOCUMENT_NOT_OBJECT",
  "SCHEMA_VERSION_INVALID",
  "UNKNOWN_FIELD",
  "NODES_NOT_ARRAY",
  "NODES_EMPTY",
  "NODE_NOT_OBJECT",
  "NODE_TYPE_INVALID",
  "NODE_ID_INVALID",
  "NODE_ID_DUPLICATE",
  "HEADING_LEVEL_INVALID",
  "CHILDREN_NOT_ARRAY",
  "INLINE_NOT_OBJECT",
  "INLINE_TYPE_INVALID",
  "TEXT_NOT_STRING",
  "TEXT_EMPTY",
  "MARKS_NOT_ARRAY",
  "MARK_INVALID",
  "MARKS_DUPLICATE",
  "MARKS_UNSORTED",
  "ADJACENT_TEXT_SAME_MARKS",
  // Document v2 (docs/contracts/document-schema-v2.md). Appended, never
  // inserted: the codes above keep their meaning and their position.
  "SOURCES_NOT_ARRAY",
  "SOURCES_TOO_MANY",
  "SOURCE_NOT_OBJECT",
  "SOURCE_TYPE_INVALID",
  "SOURCE_FIELD_MISSING",
  "SOURCE_FIELD_INVALID",
  "SOURCE_ID_INVALID",
  "SOURCE_ID_DUPLICATE",
  "SOURCE_YEAR_INVALID",
  "SOURCE_ACCESSED_INVALID",
  "SOURCE_URL_INVALID",
  "AUTHORS_INVALID",
  "EDITORS_INVALID",
  "AUTHOR_INVALID",
  "CITATION_SOURCE_ID_INVALID",
  "CITATION_LOCATOR_INVALID",
  "CITATION_NOT_ALLOWED",
  // Document v3 (docs/contracts/document-schema-v3.md), appended likewise.
  "CITATION_VIA_INVALID",
  "CITATION_REQUEST_INVALID",
  "FOOTNOTE_TEXT_INVALID",
  "FOOTNOTE_NOT_ALLOWED",
  "CROSS_REFERENCE_TARGET_INVALID",
  "CROSS_REFERENCE_NOT_ALLOWED",
  // Document v4 (docs/contracts/document-schema-v4.md), appended likewise.
  "MARKS_EXCLUSIVE",
  "MARK_ATTRIBUTE_INVALID",
  "VARIANT_GROUP_INVALID",
  "FORMULA_TEX_INVALID",
  "INLINE_FORMULA_NOT_ALLOWED",
  "CODE_LANGUAGE_INVALID",
  "CODE_CAPTION_INVALID",
  "CODE_CONTENT_INVALID",
  "BOX_KIND_INVALID",
  "BOX_CHILDREN_INVALID",
] as const;

export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];

/** `path` is a JSON-pointer-ish locator such as `$.nodes[0].children[1].text`. */
export type ValidationError = { path: string; code: ValidationErrorCode };

export type ValidationOutcome =
  { ok: true; doc: CanonicalDocument } | { ok: false; errors: ValidationError[] };

export type VersionedValidationOutcome =
  { ok: true; doc: VersionedDocument } | { ok: false; errors: ValidationError[] };

/** The top-level keys of each accepted version (contract §1). */
const DOCUMENT_FIELDS: ReadonlyMap<DocumentSchemaVersion, ReadonlySet<string>> = new Map([
  [DOCUMENT_SCHEMA_VERSION, new Set(["schemaVersion", "nodes"])],
  [DOCUMENT_SCHEMA_VERSION_V2, new Set(["schemaVersion", "nodes", "sources"])],
  [DOCUMENT_SCHEMA_VERSION_V3, new Set(["schemaVersion", "nodes", "sources"])],
]);
/** Paragraph and every other plain block type (`PLAIN_BLOCK_TYPES`). */
const PARAGRAPH_FIELDS = new Set(["type", "id", "children"]);
const HEADING_FIELDS = new Set(["type", "id", "level", "children"]);
const INLINE_FIELDS = new Set(["type", "text", "marks"]);
const CITATION_FIELDS = new Set(["type", "sourceId", "locator"]);
const CITATION_FIELDS_V3 = new Set(["type", "sourceId", "locator", "via", "rq"]);
const FOOTNOTE_FIELDS = new Set(["type", "text"]);
const CROSS_REFERENCE_FIELDS = new Set(["type", "targetId"]);

/**
 * The inline atoms each version knows besides text (contract v2 §3.1, v3
 * §3.1), with the code for one in a heading. A type not listed for the
 * version is read as text, so it is INLINE_TYPE_INVALID.
 */
const ATOMS_BY_VERSION: ReadonlyMap<
  DocumentSchemaVersion,
  ReadonlyMap<string, ValidationErrorCode>
> = new Map([
  [DOCUMENT_SCHEMA_VERSION, new Map()],
  [DOCUMENT_SCHEMA_VERSION_V2, new Map([["citation", "CITATION_NOT_ALLOWED"]])],
  [
    DOCUMENT_SCHEMA_VERSION_V3,
    new Map<string, ValidationErrorCode>([
      ["citation", "CITATION_NOT_ALLOWED"],
      ["footnote", "FOOTNOTE_NOT_ALLOWED"],
      ["crossReference", "CROSS_REFERENCE_NOT_ALLOWED"],
    ]),
  ],
]);

/**
 * Validates `doc` as a v1 document, the only version the callers of this
 * function read. Any other version, v2 included, is `SCHEMA_VERSION_INVALID`.
 * Errors are collected (not fail-fast) so a caller can report everything
 * wrong with a payload in one pass.
 */
export function validateDocument(doc: unknown): ValidationOutcome {
  return validate(doc, (version) => version === DOCUMENT_SCHEMA_VERSION) as ValidationOutcome;
}

/**
 * Validates `doc` as a document of any accepted version
 * (`DOCUMENT_BLOCK_TYPES_BY_VERSION`): v1 by the rules of v1, v2 with its
 * sources and citations. The version is returned as found, never changed.
 */
export function validateVersionedDocument(doc: unknown): VersionedValidationOutcome {
  return validate(doc, () => true);
}

function validate(
  doc: unknown,
  accepts: (version: DocumentSchemaVersion) => boolean,
): VersionedValidationOutcome {
  const errors: ValidationError[] = [];

  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ path: "$", code: "DOCUMENT_NOT_OBJECT" }] };
  }

  const accepted =
    isAcceptedDocumentSchemaVersion(doc.schemaVersion) && accepts(doc.schemaVersion)
      ? doc.schemaVersion
      : null;
  // A document of a version the caller does not accept is still read, by the
  // rules of v1, so that every error is reported; the document is refused.
  // `validateDocument` therefore reads a v2 document as v1: its `sources` is
  // also UNKNOWN_FIELD and a citation INLINE_TYPE_INVALID.
  const rules = accepted ?? DOCUMENT_SCHEMA_VERSION;

  checkUnknownFields(doc, DOCUMENT_FIELDS.get(rules)!, "$", errors);

  if (accepted === null) {
    errors.push({ path: "$.schemaVersion", code: "SCHEMA_VERSION_INVALID" });
  }
  const blockTypes = DOCUMENT_BLOCK_TYPES_BY_VERSION.get(rules)!;

  const sources =
    rules !== DOCUMENT_SCHEMA_VERSION
      ? validateSources(Object.hasOwn(doc, "sources") ? doc.sources : undefined, errors)
      : [];

  if (!Array.isArray(doc.nodes)) {
    errors.push({ path: "$.nodes", code: "NODES_NOT_ARRAY" });
    return { ok: false, errors };
  }

  if (doc.nodes.length === 0) {
    errors.push({ path: "$.nodes", code: "NODES_EMPTY" });
  }

  const seenIds = new Set<string>();
  const nodes: DocumentNodeV3[] = [];

  // Array.from turns holes into `undefined`, so a sparse array fails validation
  // instead of being skipped by forEach.
  Array.from(doc.nodes).forEach((rawNode, index) => {
    const node = validateNode(rawNode, `$.nodes[${index}]`, blockTypes, rules, seenIds, errors);
    if (node) {
      nodes.push(node);
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // The atoms of each version are checked above, so the nodes are of `rules`.
  if (rules === DOCUMENT_SCHEMA_VERSION) {
    return { ok: true, doc: { schemaVersion: rules, nodes: nodes as DocumentNode[] } };
  }
  return rules === DOCUMENT_SCHEMA_VERSION_V2
    ? { ok: true, doc: { schemaVersion: rules, nodes: nodes as never, sources } }
    : { ok: true, doc: { schemaVersion: rules, nodes, sources } };
}

function validateNode(
  raw: unknown,
  path: string,
  blockTypes: ReadonlySet<string>,
  rules: DocumentSchemaVersion,
  seenIds: Set<string>,
  errors: ValidationError[],
): DocumentNodeV3 | null {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: "NODE_NOT_OBJECT" });
    return null;
  }

  const type = raw.type;
  if (
    typeof type !== "string" ||
    !blockTypes.has(type) ||
    (type !== "heading" && !isPlainBlockType(type))
  ) {
    errors.push({ path: `${path}.type`, code: "NODE_TYPE_INVALID" });
    return null;
  }

  checkUnknownFields(raw, type === "heading" ? HEADING_FIELDS : PARAGRAPH_FIELDS, path, errors);

  let nodeOk = true;
  let id: NodeId | null = null;
  if (!isNodeId(raw.id)) {
    errors.push({ path: `${path}.id`, code: "NODE_ID_INVALID" });
    nodeOk = false;
  } else if (seenIds.has(raw.id.toLowerCase())) {
    // UUIDs are case-insensitive: the same id in two cases is a duplicate.
    errors.push({ path: `${path}.id`, code: "NODE_ID_DUPLICATE" });
    nodeOk = false;
  } else {
    seenIds.add(raw.id.toLowerCase());
    id = raw.id;
  }

  let level: HeadingLevel = 1;
  if (type === "heading") {
    if (!isHeadingLevel(raw.level)) {
      errors.push({ path: `${path}.level`, code: "HEADING_LEVEL_INVALID" });
      nodeOk = false;
    } else {
      level = raw.level;
    }
  }

  if (!Array.isArray(raw.children)) {
    errors.push({ path: `${path}.children`, code: "CHILDREN_NOT_ARRAY" });
    return null;
  }

  const children: InlineNodeV3[] = [];
  const atoms = ATOMS_BY_VERSION.get(rules)!;
  // The last valid text run. An atom, valid or not, stands between the runs
  // on either side of it, so they are not adjacent (contract v2 and v3 §3.1).
  let previous: InlineNode | null = null;
  Array.from(raw.children).forEach((rawChild, index) => {
    const childPath = `${path}.children[${index}]`;
    const atomType = isPlainObject(rawChild) ? rawChild.type : undefined;
    if (typeof atomType === "string" && atoms.has(atomType)) {
      previous = null;
      if (type === "heading") {
        errors.push({ path: childPath, code: atoms.get(atomType)! });
      }
      const atom = validateAtom(rawChild as Record<string, unknown>, childPath, rules, errors);
      if (atom) children.push(atom);
      return;
    }
    const child = validateInline(rawChild, childPath, errors);
    if (child) {
      if (previous && sameMarks(previous.marks, child.marks)) {
        errors.push({ path: childPath, code: "ADJACENT_TEXT_SAME_MARKS" });
      }
      previous = child;
      children.push(child);
    }
  });

  if (!nodeOk || id === null) {
    return null;
  }

  return type === "heading"
    ? { type: "heading", id, level, children: children as InlineNode[] }
    : { type, id, children };
}

/** An atom of a type `ATOMS_BY_VERSION` lists for `rules`. */
function validateAtom(
  raw: Record<string, unknown>,
  path: string,
  rules: DocumentSchemaVersion,
  errors: ValidationError[],
): InlineNodeV3 | null {
  if (raw.type === "footnote") return validateFootnote(raw, path, errors);
  if (raw.type === "crossReference") return validateCrossReference(raw, path, errors);
  return validateCitation(raw, path, rules, errors);
}

/**
 * A citation atom (contract v2 §3.1, v3 §3.2). The copy holds an optional
 * field only when the input has it as an own key: absent means "none", and
 * `""` is refused so one meaning has one form. `via` and `rq` are fields of
 * v3 only; in v2 they are UNKNOWN_FIELD.
 */
function validateCitation(
  raw: Record<string, unknown>,
  path: string,
  rules: DocumentSchemaVersion,
  errors: ValidationError[],
): CitationNodeV3 | null {
  const v3 = rules === DOCUMENT_SCHEMA_VERSION_V3;
  checkUnknownFields(raw, v3 ? CITATION_FIELDS_V3 : CITATION_FIELDS, path, errors);

  let ok = true;
  const sourceId = raw.sourceId;
  if (!isSourceId(sourceId)) {
    errors.push({ path: `${path}.sourceId`, code: "CITATION_SOURCE_ID_INVALID" });
    ok = false;
  }
  const hasLocator = Object.hasOwn(raw, "locator");
  const locator = raw.locator;
  if (hasLocator && !isAllowedText(locator, MAX_CITATION_LOCATOR_CODE_POINTS)) {
    errors.push({ path: `${path}.locator`, code: "CITATION_LOCATOR_INVALID" });
    ok = false;
  }

  const hasVia = v3 && Object.hasOwn(raw, "via");
  if (hasVia && !isAllowedTrimmedText(raw.via, MAX_CITATION_VIA_CODE_POINTS)) {
    errors.push({ path: `${path}.via`, code: "CITATION_VIA_INVALID" });
    ok = false;
  }
  const hasRq = v3 && Object.hasOwn(raw, "rq");
  if (hasRq && !isRequestId(raw.rq)) {
    errors.push({ path: `${path}.rq`, code: "CITATION_REQUEST_INVALID" });
    ok = false;
  }

  if (!ok || !isSourceId(sourceId)) {
    return null;
  }
  return {
    type: "citation",
    sourceId,
    ...(hasLocator ? { locator: locator as string } : {}),
    ...(hasVia ? { via: raw.via as string } : {}),
    ...(hasRq && isRequestId(raw.rq) ? { rq: raw.rq } : {}),
  };
}

/** A footnote atom (contract v3 §3.3): tidy plain text of 1 to 2000 code points. */
function validateFootnote(
  raw: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): FootnoteNode | null {
  checkUnknownFields(raw, FOOTNOTE_FIELDS, path, errors);
  if (!isAllowedTrimmedText(raw.text, MAX_FOOTNOTE_TEXT_CODE_POINTS)) {
    errors.push({ path: `${path}.text`, code: "FOOTNOTE_TEXT_INVALID" });
    return null;
  }
  return { type: "footnote", text: raw.text };
}

/**
 * A cross reference atom (contract v3 §3.4). Whether a block with the target
 * id exists, and is a heading, is not checked: either way it is valid.
 */
function validateCrossReference(
  raw: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): CrossReferenceNode | null {
  checkUnknownFields(raw, CROSS_REFERENCE_FIELDS, path, errors);
  if (!isCrossReferenceTarget(raw.targetId)) {
    errors.push({ path: `${path}.targetId`, code: "CROSS_REFERENCE_TARGET_INVALID" });
    return null;
  }
  return { type: "crossReference", targetId: raw.targetId };
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((mark, i) => mark === b[i]);
}

function validateInline(raw: unknown, path: string, errors: ValidationError[]): InlineNode | null {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: "INLINE_NOT_OBJECT" });
    return null;
  }

  if (raw.type !== "text") {
    errors.push({ path: `${path}.type`, code: "INLINE_TYPE_INVALID" });
    return null;
  }

  checkUnknownFields(raw, INLINE_FIELDS, path, errors);

  let ok = true;

  if (typeof raw.text !== "string") {
    errors.push({ path: `${path}.text`, code: "TEXT_NOT_STRING" });
    ok = false;
  } else if (raw.text.length === 0) {
    errors.push({ path: `${path}.text`, code: "TEXT_EMPTY" });
    ok = false;
  }

  if (!Array.isArray(raw.marks)) {
    errors.push({ path: `${path}.marks`, code: "MARKS_NOT_ARRAY" });
    return null;
  }

  const marks: Mark[] = [];
  Array.from(raw.marks).forEach((rawMark, index) => {
    if (!isMark(rawMark)) {
      errors.push({ path: `${path}.marks[${index}]`, code: "MARK_INVALID" });
      ok = false;
      return;
    }
    if (marks.includes(rawMark)) {
      errors.push({ path: `${path}.marks[${index}]`, code: "MARKS_DUPLICATE" });
      ok = false;
      return;
    }
    marks.push(rawMark);
  });

  if (ok && !marksAreCanonical(marks)) {
    errors.push({ path: `${path}.marks`, code: "MARKS_UNSORTED" });
    ok = false;
  }

  if (!ok) {
    return null;
  }

  return { type: "text", text: raw.text as string, marks };
}
