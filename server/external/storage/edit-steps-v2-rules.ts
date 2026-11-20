import { getSchema } from "@tiptap/core";
import {
  Fragment,
  Schema,
  type Node as PmNode,
  type NodeSpec,
  type ResolvedPos,
} from "@tiptap/pm/model";
import { Step } from "@tiptap/pm/transform";

import { validateVersionedDocument } from "../../domain/document/index.ts";
import {
  EDIT_STEP_FORMAT_V2,
  EDIT_STEP_FORMAT_V3,
  parseEditSteps,
  type EditStepBlockOf,
  type EditStepInlineV3,
  type EditStepV3,
} from "../../domain/document/edit-step.ts";
import {
  canonicalMarks,
  isMark,
  isPlainBlockType,
  MAX_DOCUMENT_SOURCES,
  type DocumentSource,
  type InlineNodeV3,
  type Mark,
} from "../../domain/document/schema.ts";
import { EvidenceContentNotSupportedV2 } from "../../domain/forensics/evidence-replay-v2.ts";
import type { EvidenceEventV3 } from "../../domain/forensics/evidence-segment-v2.ts";
import { canonicalizeJcs, type JcsJsonValue } from "../../domain/forensics/jcs.ts";
import { createEditorExtensions } from "./editor/index.ts";

import { refuse, removedRangeCanonical, type RemovedRangeClaim } from "./edit-steps-v1-rules.ts";

/**
 * Rules of the `ductus-edit-steps-v2` replayer (DAN-619, contract
 * `docs/contracts/document-schema-v2.md` §5), shared by the server and the
 * browser like the v1 rules: no Node module may be imported here. Everything
 * v1 checks is checked here the same way (`edit-steps-v1-rules.ts`), on the
 * v2 schema below and with three additions:
 *
 *   1. a citation is an atom of one position. A removal that holds one is a
 *      removal of content, so it carries `removedSha256` over the same
 *      `removedRangeCanonical` as v1, which includes `sourceId` and `locator`
 *      (§5.2); `structure` over a citation is refused;
 *   2. `addMark` and `removeMark` never mark a citation: ProseMirror marks
 *      every leaf in the range, so the marks are taken off again. A step is
 *      refused as changing nothing only if ProseMirror's own result is the
 *      document it started from; one that marks a lone citation is accepted
 *      and leaves the document as it was (§3.1, §5.1);
 *   3. `sourceSet` and `sourceRemove` change the list of sources. Replacing
 *      or removing a record yields a claim over the JCS of the old record, so
 *      the driver checks its hash exactly as it checks a removed range (§5.3).
 *
 * Every refusal is internal; `replayEvidenceSegmentsV2` reports `step_failed`.
 *
 * The same rules replay `ductus-edit-steps-v3` (SRV-7A, contract
 * `docs/contracts/document-schema-v3.md` §5) on the v3 schema: a footnote and
 * a cross reference are atoms like the citation in 1 and 2, and a citation
 * also has `via` and `rq`. Each function takes the version it replays; the
 * v2 entries below keep their names and behaviour.
 */

/** The schema version a replay runs on, and its step format. */
export type EditStepsVersion = 2 | 3;

const FORMAT = { 2: EDIT_STEP_FORMAT_V2, 3: EDIT_STEP_FORMAT_V3 } as const;

/**
 * The attributes of each atom in ProseMirror's JSON, per version: every
 * optional one is written, `null` when absent, as ProseMirror writes it back.
 */
const ATOM_ATTRS: Record<EditStepsVersion, Readonly<Record<string, readonly string[]>>> = {
  2: { citation: ["locator", "sourceId"] },
  3: {
    citation: ["locator", "rq", "sourceId", "via"],
    crossReference: ["targetId"],
    footnote: ["text"],
  },
};

const isAtomType = (version: EditStepsVersion, type: unknown): type is string =>
  typeof type === "string" && Object.hasOwn(ATOM_ATTRS[version], type);

/** An atom in its document form, as ProseMirror's node JSON. */
function atomToPm(version: EditStepsVersion, atom: Record<string, unknown>) {
  const type = atom.type as string;
  const attrs = Object.fromEntries(
    ATOM_ATTRS[version][type]!.map((key) => [key, atom[key] ?? null]),
  );
  return { type, attrs };
}

/** ProseMirror's atom node JSON in the document form: `null` attributes left out. */
function atomFromPm(type: string, attrs: Record<string, unknown>): Record<string, unknown> {
  const fields = Object.entries(attrs).filter(([, value]) => value !== null);
  return Object.fromEntries([...fields, ["type", type]].sort(([a], [b]) => (a! < b! ? -1 : 1)));
}

/** The state a v2 or v3 replay carries: the ProseMirror document and the sources. */
export type EditStepsV2Document = {
  readonly doc: PmNode;
  readonly sources: readonly DocumentSource[];
};

/** The replay of one event: yields every claim in order, returns the state. */
export type EditStepsV2Run = Generator<RemovedRangeClaim, EditStepsV2Document, void>;

/** An inline atom whose attributes are `required`, plus the optional ones. */
function atomSpec(required: readonly string[], optional: readonly string[] = []): NodeSpec {
  return {
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    attrs: Object.fromEntries([
      ...required.map((key) => [key, {}]),
      ...optional.map((key) => [key, { default: null }]),
    ]),
  };
}

const schemas = new Map<EditStepsVersion, Schema>();

/**
 * The F1 schema with the atoms of the version: a heading holds text only
 * (v2 and v3 §3.1), every other block also atoms. The editor of each version
 * (DAN-620, WEB-7A) must use a schema that gives the same JSON, or its steps
 * do not replay.
 */
export function editStepsSchema(version: EditStepsVersion): Schema {
  const cached = schemas.get(version);
  if (cached) return cached;
  const f1 = getSchema(createEditorExtensions());
  const heading = f1.spec.nodes.get("heading");
  if (!heading) throw new Error("F1 schema has no heading");
  let nodes = f1.spec.nodes.update("heading", { ...heading, content: "text*" });
  nodes =
    version === 2
      ? nodes.addToEnd("citation", atomSpec(["sourceId"], ["locator"]))
      : nodes
          .addToEnd("citation", atomSpec(["sourceId"], ["locator", "via", "rq"]))
          .addToEnd("footnote", atomSpec(["text"]))
          .addToEnd("crossReference", atomSpec(["targetId"]));
  // Tiptap's getSchema always names the top node.
  const schema = new Schema({ topNode: f1.spec.topNode!, nodes, marks: f1.spec.marks });
  schemas.set(version, schema);
  return schema;
}

/** The schema of `ductus-edit-steps-v2`. */
export const editStepsV2Schema = (): Schema => editStepsSchema(2);
/** The schema of `ductus-edit-steps-v3` (contract v3 §5). */
export const editStepsV3Schema = (): Schema => editStepsSchema(3);

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** The position exists and does not split a surrogate pair. */
function at(document: PmNode, pos: number): ResolvedPos {
  if (pos > document.content.size) {
    refuse("position_outside_document");
  }
  const resolved = document.resolve(pos);
  // A block can hold atoms now, so the text around the position is read
  // from the nodes next to it, not from the text of the whole block.
  const before = resolved.nodeBefore;
  const after = resolved.nodeAfter;
  if (before?.isText && after?.isText) {
    const left = before.text ?? "";
    if (isHigh(left.charCodeAt(left.length - 1)) && isLow((after.text ?? "").charCodeAt(0))) {
      refuse("position_splits_surrogate_pair");
    }
  }
  return resolved;
}

type Block = EditStepBlockOf<EditStepInlineV3>;
type ContentStep = Exclude<EditStepV3, { stepType: "sourceSet" | "sourceRemove" }>;

function sameBlock(written: Block, block: PmNode): boolean {
  const level = written.type === "heading" ? written.attrs.level : undefined;
  return (
    written.type === block.type.name &&
    level === block.attrs.level &&
    written.attrs.nodeId === block.attrs.nodeId
  );
}

/** Whether `from..to` holds a character, an atom or both ends of one block. */
function removesContent(document: PmNode, from: number, to: number): boolean {
  if (document.textBetween(from, to, undefined, "￼").length > 0) {
    return true;
  }
  let wholeBlock = false;
  document.forEach((block, offset) => {
    wholeBlock ||= offset >= from && offset + block.nodeSize <= to;
  });
  return wholeBlock;
}

function* checkReplace(
  document: PmNode,
  step: Extract<ContentStep, { stepType: "replace" }>,
): Generator<RemovedRangeClaim, void, void> {
  const $from = at(document, step.from);
  const $to = at(document, step.to);
  if (step.to > step.from) {
    const content = removesContent(document, step.from, step.to);
    if (content !== "removedSha256" in step || content === "structure" in step) {
      refuse("removed_range_record");
    }
    if (content) {
      yield {
        canonical: removedRangeCanonical(document, step.from, step.to),
        recorded: step.removedSha256,
      };
    }
  }
  const slice = step.slice;
  const first = slice?.content[0];
  if (!slice || first?.type === "text" || isAtomType(3, first?.type)) {
    return;
  }
  const blocks = slice.content as Block[];
  if ("openStart" in slice && ($from.depth !== 1 || !sameBlock(blocks[0]!, $from.parent))) {
    refuse("open_start_block");
  }
  if ("openEnd" in slice) {
    const last = blocks[blocks.length - 1]!;
    const sameParent = $from.depth === 1 && $to.depth === 1 && $from.before() === $to.before();
    const ok = sameParent
      ? last.attrs.nodeId === null
      : $to.depth === 1 && sameBlock(last, $to.parent);
    if (!ok) {
      refuse("open_end_block");
    }
  }
}

function checkReplaceAround(
  document: PmNode,
  step: Extract<ContentStep, { stepType: "replaceAround" }>,
): void {
  const $from = at(document, step.from);
  at(document, step.to);
  const block = $from.depth === 0 ? document.nodeAt(step.from) : null;
  if (!block || step.from + block.nodeSize !== step.to) {
    refuse("replace_around_range");
  }
  const wrapper = step.slice.content[0] as Block;
  if (wrapper.attrs.nodeId !== block.attrs.nodeId) {
    refuse("replace_around_identity");
  }
  const level = wrapper.type === "heading" ? wrapper.attrs.level : undefined;
  if (wrapper.type === block.type.name && level === block.attrs.level) {
    refuse("replace_around_unchanged");
  }
}

function* checkStep(document: PmNode, step: ContentStep): Generator<RemovedRangeClaim, void, void> {
  switch (step.stepType) {
    case "replace":
      return yield* checkReplace(document, step);
    case "replaceAround":
      return checkReplaceAround(document, step);
    case "addMark":
    case "removeMark":
      at(document, step.from);
      at(document, step.to);
      return;
    case "attr": {
      const $pos = at(document, step.pos);
      const block = $pos.depth === 0 ? document.nodeAt(step.pos) : null;
      if (!block?.isTextblock || block.attrs.nodeId !== null) {
        refuse("attr_identity");
      }
    }
  }
}

/**
 * The step in ProseMirror's JSON: without `removedSha256`, and with every
 * atom in the node form `{type, attrs}` of the version (`ATOM_ATTRS`).
 */
function toPmJson(version: EditStepsVersion, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => toPmJson(version, item));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  if (isAtomType(version, object.type)) {
    return atomToPm(version, object);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, toPmJson(version, item)]),
  );
}

/**
 * The inverse of `toPmJson` for capture: ProseMirror's JSON of a step with
 * every atom in the document form of a slice (v2 §5.1, v3 §5), each `null`
 * attribute left out. Capture adds `removedSha256` itself. Atoms of a type
 * the version does not have are left as they are, so the parser refuses them.
 */
function editStepJson(version: EditStepsVersion, pmJson: unknown): unknown {
  if (Array.isArray(pmJson)) return pmJson.map((item) => editStepJson(version, item));
  if (typeof pmJson !== "object" || pmJson === null) return pmJson;
  const object = pmJson as Record<string, unknown>;
  if (
    isAtomType(version, object.type) &&
    typeof object.attrs === "object" &&
    object.attrs !== null
  ) {
    return atomFromPm(object.type, object.attrs as Record<string, unknown>);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, editStepJson(version, item)]),
  );
}

export const editStepJsonV2 = (pmJson: unknown): unknown => editStepJson(2, pmJson);
export const editStepJsonV3 = (pmJson: unknown): unknown => editStepJson(3, pmJson);

/** The document with the marks taken off every atom (v2 and v3 §3.1). */
function unmarkAtoms(document: PmNode): PmNode {
  const isAtom = (node: PmNode) => node.isInline && node.isLeaf && !node.isText;
  let marked = false;
  document.descendants((node) => {
    marked ||= isAtom(node) && node.marks.length > 0;
    return !marked;
  });
  if (!marked) return document;
  const blocks: PmNode[] = [];
  document.forEach((block) => {
    const children: PmNode[] = [];
    block.forEach((child) => children.push(isAtom(child) ? child.mark([]) : child));
    blocks.push(block.copy(Fragment.from(children)));
  });
  return document.copy(Fragment.from(blocks));
}

function* applyContentStep(
  version: EditStepsVersion,
  document: PmNode,
  step: ContentStep,
): Generator<RemovedRangeClaim, PmNode, void> {
  yield* checkStep(document, step);
  const pmJson = toPmJson(version, step) as Record<string, unknown>;
  delete pmJson.removedSha256;
  const pmStep = Step.fromJSON(editStepsSchema(version), pmJson);
  if (canonicalizeJcs(pmStep.toJSON()) !== canonicalizeJcs(pmJson as JcsJsonValue)) {
    refuse("step_reads_back_differently");
  }
  const result = pmStep.apply(document);
  if (result.failed !== null || !result.doc) {
    refuse("step_does_not_apply");
  }
  // Judged before the atoms are unmarked: where the text around an atom
  // already has a mark, ProseMirror's addMark writes a step for the atom
  // alone. That step is the editor's own and leaves the document as it was
  // (§5.1); one that changes nothing even to ProseMirror is still refused.
  if (result.doc.eq(document)) {
    refuse("step_changes_nothing");
  }
  const next = unmarkAtoms(result.doc);
  next.check();
  return next;
}

const sourceCanonical = (source: DocumentSource) =>
  canonicalizeJcs(source as unknown as JcsJsonValue);

function* applySourceStep(
  sources: readonly DocumentSource[],
  step: Extract<EditStepV3, { stepType: "sourceSet" | "sourceRemove" }>,
): Generator<RemovedRangeClaim, readonly DocumentSource[], void> {
  const id = step.stepType === "sourceSet" ? step.source.id : step.sourceId;
  const index = sources.findIndex((source) => source.id === id);
  if (step.stepType === "sourceRemove") {
    if (index < 0) refuse("unknown_source");
    yield { canonical: sourceCanonical(sources[index]!), recorded: step.removedSha256 };
    return sources.filter((_, i) => i !== index);
  }
  if (index < 0) {
    if ("removedSha256" in step) refuse("removed_range_record");
    if (sources.length >= MAX_DOCUMENT_SOURCES) refuse("too_many_sources");
    return [...sources, step.source];
  }
  if (!("removedSha256" in step)) refuse("removed_range_record");
  const old = sourceCanonical(sources[index]!);
  yield { canonical: old, recorded: step.removedSha256 };
  if (sourceCanonical(step.source) === old) refuse("step_changes_nothing");
  return sources.map((source, i) => (i === index ? step.source : source));
}

/** Every node and mark type the replayer of the version knows, in any position. */
function isKnownType(version: EditStepsVersion, value: string): boolean {
  return (
    value === "heading" ||
    value === "text" ||
    isAtomType(version, value) ||
    isPlainBlockType(value) ||
    isMark(value)
  );
}

const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * As in v1 (F-150): true when the refused steps name a node or mark type this
 * replayer knows nowhere. Besides attribute values, a source record is also
 * skipped: its `type` is a source type (`book`, ...), never a node type.
 */
function namesUnknownType(version: EditStepsVersion, steps: unknown): boolean {
  const pending: unknown[] = [steps];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    for (const key of Object.keys(value)) {
      const own = Object.getOwnPropertyDescriptor(value, key);
      if (
        key === "attrs" ||
        key === "value" ||
        key === "source" ||
        own === undefined ||
        !("value" in own)
      )
        continue;
      if (key !== "type") pending.push(own.value);
      else if (
        typeof own.value === "string" &&
        TYPE_NAME.test(own.value) &&
        !isKnownType(version, own.value)
      )
        return true;
    }
  }
  return false;
}

/** The steps of `event` applied to `state` in order, one claim per removed range or record. */
export function* runEditSteps(
  version: EditStepsVersion,
  state: EditStepsV2Document,
  event: EvidenceEventV3,
): EditStepsV2Run {
  const parsed = parseEditSteps(FORMAT[version], event.steps);
  if (!parsed.ok) {
    if (namesUnknownType(version, event.steps)) {
      throw new EvidenceContentNotSupportedV2(parsed.code);
    }
    refuse(parsed.code);
  }
  let { doc, sources } = state;
  for (const step of parsed.steps) {
    if (step.stepType === "sourceSet" || step.stepType === "sourceRemove") {
      sources = yield* applySourceStep(sources, step);
    } else {
      doc = yield* applyContentStep(version, doc, step);
    }
  }
  return { doc, sources };
}

export const runEditStepsV2 = (state: EditStepsV2Document, event: EvidenceEventV3) =>
  runEditSteps(2, state, event);
export const runEditStepsV3 = (state: EditStepsV2Document, event: EvidenceEventV3) =>
  runEditSteps(3, state, event);

function inlineToPm(version: EditStepsVersion, child: InlineNodeV3): Record<string, unknown> {
  if (child.type !== "text") {
    return atomToPm(version, child);
  }
  return child.marks.length > 0
    ? { type: "text", text: child.text, marks: child.marks.map((mark) => ({ type: mark })) }
    : { type: "text", text: child.text };
}

/**
 * `load` of the replayer: reads a canonical document of `version`, or refuses
 * a document of any other version (§5.4; v3 §5 point 7).
 */
export function loadEditStepsDocument(
  version: EditStepsVersion,
  canonical: JcsJsonValue,
): EditStepsV2Document {
  const valid = validateVersionedDocument(canonical);
  if (!valid.ok || valid.doc.schemaVersion !== version) {
    refuse("invalid_document");
  }
  const content = valid.doc.nodes.map((node) => {
    const attrs =
      node.type === "heading" ? { level: node.level, nodeId: node.id } : { nodeId: node.id };
    const children = (node.children as InlineNodeV3[]).map((child) => inlineToPm(version, child));
    return children.length > 0
      ? { type: node.type, attrs, content: children }
      : { type: node.type, attrs };
  });
  const doc = editStepsSchema(version).nodeFromJSON({ type: "doc", content });
  doc.check();
  return { doc, sources: valid.doc.sources };
}

export const loadEditStepsV2Document = (canonical: JcsJsonValue) =>
  loadEditStepsDocument(2, canonical);
export const loadEditStepsV3Document = (canonical: JcsJsonValue) =>
  loadEditStepsDocument(3, canonical);

function inlineToCanonical(child: PmNode): InlineNodeV3 {
  if (!child.isText) {
    return atomFromPm(child.type.name, child.attrs) as InlineNodeV3;
  }
  return {
    type: "text",
    text: child.text ?? "",
    marks: canonicalMarks(child.marks.map((mark) => mark.type.name as Mark)),
  };
}

/** `toCanonical` of the replayer: the canonical document of `version`, or refuses. */
export function editStepsCanonical(
  version: EditStepsVersion,
  state: EditStepsV2Document,
): JcsJsonValue {
  const seen = new Set<string>();
  const nodes: unknown[] = [];
  state.doc.forEach((block) => {
    const id: unknown = block.attrs.nodeId;
    if (typeof id !== "string" || seen.has(id.toLowerCase())) {
      refuse("block_identity");
    }
    seen.add(id.toLowerCase());
    const children: InlineNodeV3[] = [];
    block.forEach((child) => children.push(inlineToCanonical(child)));
    nodes.push(
      block.type.name === "heading"
        ? { type: "heading", id, level: block.attrs.level, children }
        : { type: block.type.name, id, children },
    );
  });
  const valid = validateVersionedDocument({
    schemaVersion: version,
    nodes,
    sources: state.sources,
  });
  if (!valid.ok || valid.doc.schemaVersion !== version) {
    refuse("invalid_document");
  }
  return valid.doc as unknown as JcsJsonValue;
}

export const editStepsV2Canonical = (state: EditStepsV2Document) => editStepsCanonical(2, state);
export const editStepsV3Canonical = (state: EditStepsV2Document) => editStepsCanonical(3, state);
