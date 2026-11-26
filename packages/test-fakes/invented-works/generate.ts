// Deterministic generator of invented seminar papers with a simulated writing
// process (DAN-1566). The same seed gives byte-identical output.
//
// The output is a chain of unsigned `ductus-evidence-segment-v2` segments of
// `ductus-edit-steps-v1` steps, from revision zero to a finished paper:
// typing, corrections, pastes, cuts, pauses and several sessions. Nothing is
// signed here (no key of any institution is read); signing is the caller's
// business and uses a test key from a fixture. Every name, text and address
// is invented, addresses are on `.invalid`.
import { createHash } from "node:crypto";

import {
  canonicalEvidenceSegmentV2,
  canonicalizeJcs,
  EDIT_STEP_FORMAT_V1,
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  REVISION_ZERO_NODE_ID,
  revisionZeroDocument,
  type EvidenceEventV2,
  type EvidenceSegmentV2,
  type JcsJsonValue,
} from "../../../server/domain/index.ts";
import {
  CITY,
  FIRST_NAMES,
  INVALID_HOST,
  MAIL_HOST,
  MIDDLE_HEADINGS,
  PUBLISHERS,
  SENTENCES,
  SOURCE_TITLES,
  SURNAMES,
  TITLES,
} from "./corpus.ts";
import { createRandom, randomUuid, type Random } from "./random.ts";

export type InventedWorkOptions = {
  /** Any non-empty text. The same seed always gives the same bytes. */
  seed: string;
  /** Chapters between the introduction and the literature, 0 to 6. Default 2. */
  chapters?: number;
  /** Writing sessions, 1 to 8. Default 3. */
  sessions?: number;
};

export type InventedSource = {
  surname: string;
  year: number;
  title: string;
  /** The reference as written in the literature list. */
  reference: string;
};

export type InventedWork = {
  seed: string;
  documentId: string;
  author: { displayName: string; email: string };
  title: string;
  sources: InventedSource[];
  /** Revision zero as a canonical document (the document before the first step). */
  initialDocument: JcsJsonValue;
  /** The finished paper as a canonical document. */
  finalDocument: JcsJsonValue;
  finalDocumentSha256: string;
  /** Unsigned segments in chain order, each linked to the one before. */
  segments: EvidenceSegmentV2[];
  /** SHA-256 of the canonical bytes of each segment, same order as `segments`. */
  segmentHashes: string[];
};

type Block = { id: string; type: "heading" | "paragraph"; level: 1 | 2 | 3; text: string };

type Draft = {
  source: EvidenceEventV2["source"];
  steps: JcsJsonValue[];
  touched: string[];
  before: string;
  after: string;
  startSec: number;
  endSec: number;
  session: number;
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function canonicalOf(blocks: readonly Block[]): JcsJsonValue {
  return {
    schemaVersion: 1,
    nodes: blocks.map((block) => ({
      type: block.type,
      id: block.id,
      ...(block.type === "heading" ? { level: block.level } : {}),
      children: block.text === "" ? [] : [{ type: "text", text: block.text, marks: [] }],
    })),
  };
}

const hashOf = (blocks: readonly Block[]): string => sha256(canonicalizeJcs(canonicalOf(blocks)));

/** A pause between two events at least this long ends the segment (seconds). */
const PAUSE_SPLIT_SECONDS = 120;
const MAX_EVENTS_PER_SEGMENT = 40;
const SECONDS_PER_CHARACTER = 0.3;

/** Records the writing: one method per kind of change, each one an event. */
class Writer {
  readonly blocks: Block[];
  readonly drafts: Draft[] = [];
  private clock = 0;
  private session = 0;

  constructor(
    private readonly random: Random,
    first: Block,
  ) {
    this.blocks = [first];
  }

  /** Seconds since the start of the paper's first session. */
  pause(seconds: number): void {
    this.clock += seconds;
  }

  newSession(gapSeconds: number): void {
    this.session += 1;
    this.clock += gapSeconds;
  }

  private position(index: number, offset: number): number {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += this.blocks[i]!.text.length + 2;
    return pos + 1 + offset;
  }

  private record(
    source: Draft["source"],
    steps: JcsJsonValue[],
    touched: string[],
    before: string,
    characters: number,
  ): void {
    const startSec = this.clock;
    this.clock += 1 + characters * SECONDS_PER_CHARACTER * (0.6 + this.random.next() * 0.8);
    this.drafts.push({
      source,
      steps,
      touched: [...new Set(touched)].sort(),
      before,
      after: hashOf(this.blocks),
      startSec,
      endSec: this.clock,
      session: this.session,
    });
  }

  insert(index: number, offset: number, text: string, source: Draft["source"] = "editor"): void {
    const block = this.blocks[index]!;
    const before = hashOf(this.blocks);
    const at = this.position(index, offset);
    const steps: JcsJsonValue[] = [
      { stepType: "replace", from: at, to: at, slice: { content: [{ type: "text", text }] } },
    ];
    block.text = block.text.slice(0, offset) + text + block.text.slice(offset);
    this.record(source, steps, [block.id], before, text.length);
  }

  remove(index: number, start: number, end: number, source: Draft["source"] = "editor"): void {
    const block = this.blocks[index]!;
    const before = hashOf(this.blocks);
    const removed = block.text.slice(start, end);
    const steps: JcsJsonValue[] = [
      {
        stepType: "replace",
        from: this.position(index, start),
        to: this.position(index, end),
        removedSha256: sha256(canonicalizeJcs({ content: [{ type: "text", text: removed }] })),
      },
    ];
    block.text = block.text.slice(0, start) + block.text.slice(end);
    this.record(source, steps, [block.id], before, Math.min(removed.length, 6));
  }

  /** Enter at the end of block `index`: a new paragraph, with its id, after it. */
  split(index: number, newId: string, heading?: 2 | 3): void {
    const block = this.blocks[index]!;
    const before = hashOf(this.blocks);
    const at = this.position(index, block.text.length);
    const open =
      block.type === "heading"
        ? { type: "heading", attrs: { level: block.level, nodeId: block.id } }
        : { type: "paragraph", attrs: { nodeId: block.id } };
    const steps: JcsJsonValue[] = [
      {
        stepType: "replace",
        from: at,
        to: at,
        structure: true,
        slice: {
          content: [open, { type: "paragraph", attrs: { nodeId: null } }],
          openStart: 1,
          openEnd: 1,
        },
      },
      { stepType: "attr", pos: at + 1, attr: "nodeId", value: newId },
    ];
    this.blocks.splice(index + 1, 0, { id: newId, type: "paragraph", level: 1, text: "" });
    if (heading !== undefined) steps.push(this.blockType(index + 1, heading));
    this.record("editor", steps, [block.id, newId], before, 1);
  }

  /** Turns the empty block `index` into a heading of `level` (the first block). */
  makeHeading(index: number, level: 1 | 2 | 3): void {
    const before = hashOf(this.blocks);
    const step = this.blockType(index, level);
    this.record("editor", [step], [this.blocks[index]!.id], before, 1);
  }

  private blockType(index: number, level: 1 | 2 | 3): JcsJsonValue {
    const block = this.blocks[index]!;
    const from = this.position(index, 0) - 1;
    block.type = "heading";
    block.level = level;
    return {
      stepType: "replaceAround",
      from,
      to: from + 2,
      gapFrom: from + 1,
      gapTo: from + 1,
      insert: 1,
      structure: true,
      slice: { content: [{ type: "heading", attrs: { level, nodeId: block.id } }] },
    };
  }
}

/** Words with their trailing space, a few at a time, as typing comes in bursts. */
function chunksOf(text: string, random: Random): string[] {
  const words = text.split(" ");
  const chunks: string[] = [];
  for (let at = 0; at < words.length;) {
    const count = Math.min(random.int(1, 3), words.length - at);
    const last = at + count >= words.length;
    chunks.push(words.slice(at, at + count).join(" ") + (last ? "" : " "));
    at += count;
  }
  return chunks;
}

/** A wrong version of `chunk` that is still plain text: two letters swapped. */
function mistyped(chunk: string): string {
  if (chunk.length >= 3 && chunk[0] !== chunk[1]) return chunk[1]! + chunk[0]! + chunk.slice(2);
  return `${chunk}x`;
}

type Section = { kind: "title" | "chapter" | "literature"; heading: string; paragraphs: string[] };

function plan(random: Random, options: Required<Omit<InventedWorkOptions, "seed">>) {
  const author = {
    displayName: `${random.pick(FIRST_NAMES)} ${random.pick(SURNAMES)}`,
    email: "",
  };
  author.email = `${author.displayName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z]+/gu, ".")}@${MAIL_HOST}`;
  const title = random.pick(TITLES);

  const sources: InventedSource[] = random
    .shuffle(SOURCE_TITLES)
    .slice(0, 4)
    .map((sourceTitle, at) => {
      const surname = random.pick(SURNAMES);
      const year = random.int(1998, 2024);
      const initial = random.pick(FIRST_NAMES)[0]!;
      return {
        surname,
        year,
        title: sourceTitle,
        reference: `${surname}, ${initial}. (${year}) ${sourceTitle}. ${CITY}: ${random.pick(PUBLISHERS)}. https://${INVALID_HOST}/izvor-${at + 1}`,
      };
    });

  const sentence = (): string => {
    const base = random.pick(SENTENCES);
    if (!random.chance(0.3)) return base;
    const source = random.pick(sources);
    return `${base.slice(0, -1)} (${source.surname}, ${source.year}).`;
  };
  const paragraph = (): string => Array.from({ length: random.int(2, 4) }, sentence).join(" ");

  const middle = random.shuffle(MIDDLE_HEADINGS).slice(0, options.chapters);
  const headings = ["Uvod", ...middle, ...(options.chapters > 0 ? ["Zaključak"] : [])];
  const sections: Section[] = [
    { kind: "title", heading: title, paragraphs: [] },
    ...headings.map<Section>((heading) => ({
      kind: "chapter",
      heading,
      paragraphs: Array.from({ length: random.int(1, 3) }, paragraph),
    })),
    { kind: "literature", heading: "Literatura", paragraphs: sources.map((s) => s.reference) },
  ];
  return { author, title, sources, sections };
}

/** Fills in the writing of one block's text, with the habits of a person typing. */
function write(
  writer: Writer,
  random: Random,
  index: number,
  text: string,
  careful: boolean,
): void {
  const block = writer.blocks[index]!;
  const sentences = text.split(/(?<=\.\)?) (?=\p{Lu})/u);
  for (const [at, sentenceText] of sentences.entries()) {
    const lead = at === 0 ? "" : " ";
    const piece = lead + sentenceText;
    if (!careful && sentenceText.length > 40 && random.chance(0.12)) {
      // Pasted in one go, after a pause (for example from the writer's own notes).
      writer.pause(random.int(30, 240));
      writer.insert(index, block.text.length, piece, "paste");
      continue;
    }
    const chunks = chunksOf(piece, random);
    for (const chunk of chunks) {
      if (!careful && random.chance(0.12)) {
        const wrong = mistyped(chunk);
        writer.insert(index, block.text.length, wrong);
        writer.remove(index, block.text.length - wrong.length, block.text.length);
      }
      writer.insert(index, block.text.length, chunk);
    }
    if (!careful && random.chance(0.15)) writer.pause(random.int(60, 900));
    if (!careful && at > 0 && sentenceText.length > 40 && random.chance(0.2)) {
      // Cut the sentence just written and put it back after a pause.
      writer.remove(index, block.text.length - piece.length, block.text.length, "cut");
      writer.pause(random.int(20, 180));
      writer.insert(index, block.text.length, piece, "paste");
    }
  }
}

/** Back to earlier paragraphs: one word added in one, one word removed in another. */
function revise(writer: Writer, random: Random): void {
  const candidates = writer.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === "paragraph" && block.text.length >= 60);
  if (candidates.length === 0) return;
  const added = random.pick(candidates);
  const spaces = [...added.block.text.matchAll(/ /gu)].map((m) => m.index!);
  writer.pause(random.int(30, 300));
  writer.insert(added.index, random.pick(spaces) + 1, "zapravo ");
  const removed = random.pick(candidates);
  const inner = [...removed.block.text.matchAll(/ (\p{L}+) /gu)];
  if (inner.length > 0) {
    const hit = random.pick(inner);
    writer.pause(random.int(30, 300));
    writer.remove(removed.index, hit.index! + 1, hit.index! + 1 + hit[1]!.length + 1);
  }
}

const iso = (ms: number): string =>
  new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/u, ":00.000Z");

export function generateInventedWork(options: InventedWorkOptions): InventedWork {
  const { seed } = options;
  if (typeof seed !== "string" || seed.trim() === "") {
    throw new Error("invented-works: the seed must be non-empty text");
  }
  const chapters = options.chapters ?? 2;
  const sessions = options.sessions ?? 3;
  if (!Number.isInteger(chapters) || chapters < 0 || chapters > 6) {
    throw new Error("invented-works: chapters must be an integer from 0 to 6");
  }
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 8) {
    throw new Error("invented-works: sessions must be an integer from 1 to 8");
  }

  const random = createRandom(seed);
  const { author, title, sources, sections } = plan(random, { chapters, sessions });
  const initial = revisionZeroDocument() as unknown as JcsJsonValue;
  const writer = new Writer(random, {
    id: REVISION_ZERO_NODE_ID,
    type: "paragraph",
    level: 1,
    text: "",
  });

  // The blocks (title, headings, paragraphs) are shared out over the sessions
  // in order, so every requested session happens, short papers included; each
  // later session begins with a look back at what is already written.
  type Unit = { text: string; heading: boolean; careful: boolean };
  const units: Unit[] = sections.slice(1).flatMap((section) => [
    { text: section.heading, heading: true, careful: true },
    ...section.paragraphs.map((text) => ({
      text,
      heading: false,
      careful: section.kind === "literature",
    })),
  ]);
  const sessionOf = (unit: number): number => Math.floor((unit * sessions) / (units.length + 1));
  writer.makeHeading(0, 1);
  write(writer, random, 0, title, false);
  units.forEach((unit, at) => {
    if (sessionOf(at + 1) !== sessionOf(at)) {
      writer.newSession(random.int(3 * 3600, 3 * 86400));
      revise(writer, random);
    } else if (!unit.heading) {
      writer.pause(random.int(5, 40));
    }
    writer.split(writer.blocks.length - 1, randomUuid(random), unit.heading ? 2 : undefined);
    write(writer, random, writer.blocks.length - 1, unit.text, unit.careful);
  });

  const documentId = `dokument-izmisljeni-${sha256(seed).slice(0, 12)}`;
  const epoch = Date.UTC(2026, 2, 2, 9, 0, 0) + random.int(0, 60) * 86_400_000;
  const segments: EvidenceSegmentV2[] = [];
  const segmentHashes: string[] = [];
  let sequence = 1;
  let group: Draft[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const segment: EvidenceSegmentV2 = {
      evidenceSchema: EVIDENCE_SEGMENT_SCHEMA_V2,
      canonicalization: EVIDENCE_CANONICALIZATION_V2,
      hashAlgorithm: EVIDENCE_HASH_ALGORITHM_V2,
      documentId,
      sessionId: `sesija-izmisljena-${first.session + 1}`,
      segmentId: `odsjecak-${segments.length + 1}`,
      sequenceFrom: sequence,
      sequenceTo: sequence + group.length - 1,
      observedStartedAt: iso(epoch + first.startSec * 1000),
      observedEndedAt: iso(epoch + last.endSec * 1000),
      initialDocumentHash: first.before,
      finalDocumentHash: last.after,
      predecessorSegmentHash: segmentHashes.at(-1) ?? null,
      events: group.map((draft, at) => ({
        sequence: sequence + at,
        source: draft.source,
        steps: draft.steps as EvidenceEventV2["steps"],
        touchedNodeIds: draft.touched,
        beforeDocumentHash: draft.before,
        afterDocumentHash: draft.after,
      })),
      captureContext: { editorModel: "prosemirror", transactionFormat: EDIT_STEP_FORMAT_V1 },
      evidenceProfileId: "standard-v1",
    };
    sequence += group.length;
    segments.push(segment);
    segmentHashes.push(sha256(canonicalEvidenceSegmentV2(segment)));
    group = [];
  };
  for (const draft of writer.drafts) {
    const previous = group.at(-1);
    if (
      previous !== undefined &&
      (previous.session !== draft.session ||
        draft.startSec - previous.endSec >= PAUSE_SPLIT_SECONDS ||
        group.length >= MAX_EVENTS_PER_SEGMENT)
    ) {
      flush();
    }
    group.push(draft);
  }
  flush();

  const finalDocument = canonicalOf(writer.blocks);
  return {
    seed,
    documentId,
    author,
    title,
    sources,
    initialDocument: initial,
    finalDocument,
    finalDocumentSha256: sha256(canonicalizeJcs(finalDocument)),
    segments,
    segmentHashes,
  };
}

/** The whole output as one canonical (RFC 8785) text: equal seeds give equal bytes. */
export function serializeInventedWork(work: InventedWork): string {
  return canonicalizeJcs(work as unknown as JcsJsonValue);
}
