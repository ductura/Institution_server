/**
 * Validation of an untrusted document v4 (docs/contracts/document-schema-v4.md).
 *
 * The rules of `validate.ts` hold unchanged: nothing is trusted, unknown
 * fields are refused, nothing is repaired, every error is collected and the
 * result is a fresh copy built from known fields only. Until the consumers
 * take v4 (contract §11) this is its own entry: `validateVersionedDocument`
 * still refuses `schemaVersion: 4`, so no stored path accepts a v4 document.
 */

import { isPlainObject } from "../json/index.ts";
import { isAllowedTrimmedText } from "./forbidden.ts";
import {
  BOX_KINDS,
  CODE_LANGUAGES,
  DOCUMENT_SCHEMA_VERSION_V3,
  DOCUMENT_SCHEMA_VERSION_V4,
  MAX_CODE_CAPTION_CODE_POINTS,
  MAX_FORMULA_TEX_CODE_POINTS,
  MAX_INLINE_FORMULA_TEX_CODE_POINTS,
  isHeadingLevel,
  isNodeId,
  isSourceId,
  type BoxKind,
  type CanonicalDocumentV4,
  type CodeLanguage,
  type DocumentNodeV4,
  type InlineNodeV4,
  type NodeId,
  type ParagraphNodeV4,
  type TextNodeV4,
} from "./schema.ts";
import { checkUnknownFields, validateSources } from "./validate-sources.ts";
import { IMAGE_FIELDS, validateCover, validateImage } from "./validate-image-v4.ts";
import { TABLE_FIELDS, validateTable } from "./validate-table-v4.ts";
import { marksV4Key, validateMarksV4 } from "./validate-marks-v4.ts";
import {
  validateCitation,
  validateCrossReference,
  validateFootnote,
  type ValidationError,
  type ValidationErrorCode,
} from "./validate.ts";

export type V4ValidationOutcome =
  { ok: true; doc: CanonicalDocumentV4 } | { ok: false; errors: ValidationError[] };

type Raw = Record<string, unknown>;

const DOCUMENT_FIELDS = new Set(["schemaVersion", "nodes", "sources", "cover"]);
const BLOCK_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["paragraph", new Set(["type", "id", "children", "variantGroup"])],
  ["heading", new Set(["type", "id", "level", "children"])],
  ["bulletItem", new Set(["type", "id", "children"])],
  ["quote", new Set(["type", "id", "children"])],
  ["codeBlock", new Set(["type", "id", "children", "language", "caption"])],
  ["box", new Set(["type", "id", "kind", "children"])],
  ["formula", new Set(["type", "id", "tex"])],
  ["pageBreak", new Set(["type", "id"])],
  ["table", TABLE_FIELDS],
  ["image", IMAGE_FIELDS],
]);
const TEXT_FIELDS = new Set(["type", "text", "marks"]);
const INLINE_FORMULA_FIELDS = new Set(["type", "tex"]);

/** The inline atoms of v4 and the code for one in a heading (§3.1 of v3, §4.1). */
const ATOMS: ReadonlyMap<string, ValidationErrorCode> = new Map([
  ["citation", "CITATION_NOT_ALLOWED"],
  ["footnote", "FOOTNOTE_NOT_ALLOWED"],
  ["crossReference", "CROSS_REFERENCE_NOT_ALLOWED"],
  ["inlineFormula", "INLINE_FORMULA_NOT_ALLOWED"],
]);

export function validateDocumentV4(doc: unknown): V4ValidationOutcome {
  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ path: "$", code: "DOCUMENT_NOT_OBJECT" }] };
  }
  const errors: ValidationError[] = [];
  checkUnknownFields(doc, DOCUMENT_FIELDS, "$", errors);
  // Read by the rules of v4 even when the version is wrong, so that every
  // error is reported; the document is refused.
  if (doc.schemaVersion !== DOCUMENT_SCHEMA_VERSION_V4) {
    errors.push({ path: "$.schemaVersion", code: "SCHEMA_VERSION_INVALID" });
  }
  const sources = validateSources(Object.hasOwn(doc, "sources") ? doc.sources : undefined, errors);
  const cover = Object.hasOwn(doc, "cover") ? validateCover(doc.cover, errors) : null;
  if (!Array.isArray(doc.nodes)) {
    errors.push({ path: "$.nodes", code: "NODES_NOT_ARRAY" });
    return { ok: false, errors };
  }
  if (doc.nodes.length === 0) {
    errors.push({ path: "$.nodes", code: "NODES_EMPTY" });
  }
  const seenIds = new Set<string>();
  const nodes: DocumentNodeV4[] = [];
  Array.from(doc.nodes).forEach((raw, index) => {
    const node = validateBlock(raw, `$.nodes[${index}]`, seenIds, errors);
    if (node) nodes.push(node);
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    doc: { schemaVersion: DOCUMENT_SCHEMA_VERSION_V4, nodes, sources, ...(cover ? { cover } : {}) },
  };
}

function validateBlock(
  raw: unknown,
  path: string,
  seenIds: Set<string>,
  errors: ValidationError[],
): DocumentNodeV4 | null {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: "NODE_NOT_OBJECT" });
    return null;
  }
  const type = raw.type;
  const fields = typeof type === "string" ? BLOCK_FIELDS.get(type) : undefined;
  if (fields === undefined) {
    errors.push({ path: `${path}.type`, code: "NODE_TYPE_INVALID" });
    return null;
  }
  checkUnknownFields(raw, fields, path, errors);
  const before = errors.length;
  const id = validateId(raw, path, seenIds, errors);

  if (type === "pageBreak") {
    return id === null ? null : { type, id };
  }
  if (type === "formula") {
    const tex = optionalText(
      raw,
      "tex",
      path,
      MAX_FORMULA_TEX_CODE_POINTS,
      "FORMULA_TEX_INVALID",
      errors,
      true,
    );
    return id === null || tex === undefined ? null : { type, id, tex };
  }
  if (type === "table") return validateTable(raw, path, id, errors);
  if (type === "image") return validateImage(raw, path, id, errors);
  if (type === "box") {
    return validateBox(raw, path, id, seenIds, errors);
  }

  if (!Array.isArray(raw.children)) {
    errors.push({ path: `${path}.children`, code: "CHILDREN_NOT_ARRAY" });
    return null;
  }
  const children = validateInlineChildren(raw.children, path, type as string, errors);
  if (type === "heading" && !isHeadingLevel(raw.level)) {
    errors.push({ path: `${path}.level`, code: "HEADING_LEVEL_INVALID" });
  }
  const language = raw.language;
  if (type === "codeBlock" && Object.hasOwn(raw, "language")) {
    if (!(CODE_LANGUAGES as readonly unknown[]).includes(language)) {
      errors.push({ path: `${path}.language`, code: "CODE_LANGUAGE_INVALID" });
    }
  }
  const caption =
    type === "codeBlock"
      ? optionalText(
          raw,
          "caption",
          path,
          MAX_CODE_CAPTION_CODE_POINTS,
          "CODE_CAPTION_INVALID",
          errors,
        )
      : undefined;
  const variantGroup = raw.variantGroup;
  if (type === "paragraph" && Object.hasOwn(raw, "variantGroup") && !isSourceId(variantGroup)) {
    errors.push({ path: `${path}.variantGroup`, code: "VARIANT_GROUP_INVALID" });
  }
  if (id === null || errors.length > before) {
    return null;
  }

  switch (type) {
    case "heading":
      return { type, id, level: raw.level as 1 | 2 | 3, children: children as TextNodeV4[] };
    case "codeBlock":
      return {
        type,
        id,
        children: children as TextNodeV4[],
        ...(Object.hasOwn(raw, "language") ? { language: language as CodeLanguage } : {}),
        ...(caption !== undefined ? { caption } : {}),
      };
    case "paragraph":
      return {
        type,
        id,
        children,
        ...(Object.hasOwn(raw, "variantGroup") ? { variantGroup: variantGroup as string } : {}),
      };
    default:
      return { type: type as "bulletItem" | "quote", id, children };
  }
}

function validateId(
  raw: Raw,
  path: string,
  seenIds: Set<string>,
  errors: ValidationError[],
): NodeId | null {
  if (!isNodeId(raw.id)) {
    errors.push({ path: `${path}.id`, code: "NODE_ID_INVALID" });
    return null;
  }
  // UUIDs are case-insensitive: the same id in two cases is a duplicate.
  if (seenIds.has(raw.id.toLowerCase())) {
    errors.push({ path: `${path}.id`, code: "NODE_ID_DUPLICATE" });
    return null;
  }
  seenIds.add(raw.id.toLowerCase());
  return raw.id;
}

/**
 * An optional tidy text field: `undefined` when absent or invalid. With
 * `required`, absence is the field's own error code too.
 */
function optionalText(
  raw: Raw,
  key: string,
  path: string,
  max: number,
  code: ValidationErrorCode,
  errors: ValidationError[],
  required = false,
): string | undefined {
  if (!Object.hasOwn(raw, key) && !required) return undefined;
  const value = raw[key];
  if (!isAllowedTrimmedText(value, max)) {
    errors.push({ path: `${path}.${key}`, code });
    return undefined;
  }
  return value;
}

/** §4.3: a kind and one or more paragraphs; no other block, no box in a box. */
function validateBox(
  raw: Raw,
  path: string,
  id: NodeId | null,
  seenIds: Set<string>,
  errors: ValidationError[],
): DocumentNodeV4 | null {
  const before = errors.length;
  if (!(BOX_KINDS as readonly unknown[]).includes(raw.kind)) {
    errors.push({ path: `${path}.kind`, code: "BOX_KIND_INVALID" });
  }
  if (!Array.isArray(raw.children)) {
    errors.push({ path: `${path}.children`, code: "CHILDREN_NOT_ARRAY" });
    return null;
  }
  if (raw.children.length === 0) {
    errors.push({ path: `${path}.children`, code: "BOX_CHILDREN_INVALID" });
  }
  const children: ParagraphNodeV4[] = [];
  Array.from(raw.children).forEach((child: unknown, index) => {
    const childPath = `${path}.children[${index}]`;
    if (!isPlainObject(child) || child.type !== "paragraph") {
      errors.push({ path: childPath, code: "BOX_CHILDREN_INVALID" });
      return;
    }
    const node = validateBlock(child, childPath, seenIds, errors);
    if (node) children.push(node as ParagraphNodeV4);
  });
  if (id === null || errors.length > before) return null;
  return { type: "box", id, kind: raw.kind as BoxKind, children };
}

/**
 * The inline children of a text block. In a heading each atom gets its own
 * NOT_ALLOWED code; in a code block an atom or a mark is CODE_CONTENT_INVALID.
 */
function validateInlineChildren(
  rawChildren: unknown[],
  path: string,
  blockType: string,
  errors: ValidationError[],
): InlineNodeV4[] {
  const children: InlineNodeV4[] = [];
  // An atom, valid or not, stands between the text runs on either side.
  let previous: TextNodeV4 | null = null;
  Array.from(rawChildren).forEach((raw, index) => {
    const childPath = `${path}.children[${index}]`;
    const atomType = isPlainObject(raw) ? raw.type : undefined;
    if (typeof atomType === "string" && ATOMS.has(atomType)) {
      previous = null;
      if (blockType === "heading") errors.push({ path: childPath, code: ATOMS.get(atomType)! });
      if (blockType === "codeBlock") errors.push({ path: childPath, code: "CODE_CONTENT_INVALID" });
      const atom = validateAtom(raw as Raw, childPath, errors);
      if (atom) children.push(atom);
      return;
    }
    const text = validateText(raw, childPath, errors);
    if (!text) return;
    if (blockType === "codeBlock" && text.marks.length > 0) {
      errors.push({ path: `${childPath}.marks`, code: "CODE_CONTENT_INVALID" });
    }
    if (previous && marksV4Key(previous.marks) === marksV4Key(text.marks)) {
      errors.push({ path: childPath, code: "ADJACENT_TEXT_SAME_MARKS" });
    }
    previous = text;
    children.push(text);
  });
  return children;
}

function validateAtom(raw: Raw, path: string, errors: ValidationError[]): InlineNodeV4 | null {
  if (raw.type === "footnote") return validateFootnote(raw, path, errors);
  if (raw.type === "crossReference") return validateCrossReference(raw, path, errors);
  if (raw.type === "citation")
    return validateCitation(raw, path, DOCUMENT_SCHEMA_VERSION_V3, errors);
  checkUnknownFields(raw, INLINE_FORMULA_FIELDS, path, errors);
  const tex = optionalText(
    raw,
    "tex",
    path,
    MAX_INLINE_FORMULA_TEX_CODE_POINTS,
    "FORMULA_TEX_INVALID",
    errors,
    true,
  );
  return tex === undefined ? null : { type: "inlineFormula", tex };
}

function validateText(raw: unknown, path: string, errors: ValidationError[]): TextNodeV4 | null {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: "INLINE_NOT_OBJECT" });
    return null;
  }
  if (raw.type !== "text") {
    errors.push({ path: `${path}.type`, code: "INLINE_TYPE_INVALID" });
    return null;
  }
  checkUnknownFields(raw, TEXT_FIELDS, path, errors);
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
  const marks = validateMarksV4(raw.marks, `${path}.marks`, errors);
  return ok && marks ? { type: "text", text: raw.text as string, marks } : null;
}
