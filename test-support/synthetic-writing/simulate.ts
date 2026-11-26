// DAN-1566: simulated writing of an invented paper, recorded as evidence
// segments v2 in `ductus-edit-steps-v1`. The writer below keeps its own flat
// list of blocks and emits only four step forms (insert text, delete inside
// one block, split a block, change a block's type). It is a generator of
// test data, not a replayer: it cannot read steps it did not write.
import {
  canonicalizeJcs,
  type CanonicalDocument,
  digestCanonicalDocumentV2,
  digestEvidenceSegmentV2,
  DOCUMENT_SCHEMA_VERSION,
  type EvidenceSegmentV2,
  headingNode,
  type JcsJsonValue,
  type NodeId,
  paragraphNode,
  REVISION_ZERO_NODE_ID,
  revisionZeroDocument,
  sha256WebCrypto,
  textNode,
} from "../../server/domain/index.ts";
import { createRandom, generateSyntheticPaper, type Random, type SyntheticPaper } from "./paper.ts";

export type SyntheticWritingOptions = {
  /** Same seed, same output, byte for byte. */
  seed: number;
  /** Sections of the paper, 1 to 5. Default 3. */
  sections?: number;
  /** Most events in one segment. Default 80. */
  segmentEvents?: number;
  /** Whole UTC minute at which the writing starts. */
  startAt?: string;
};

export type SyntheticWritingStats = {
  events: number;
  typedCharacters: number;
  deletedCharacters: number;
  pastedCharacters: number;
  sessions: number;
};

export type SyntheticWriting = {
  paper: SyntheticPaper;
  documentId: string;
  initialDocument: CanonicalDocument;
  finalDocument: CanonicalDocument;
  finalDocumentHash: string;
  segments: EvidenceSegmentV2[];
  /** Canonical JCS text of every segment, in chain order. */
  segmentTexts: string[];
  segmentHashes: string[];
  stats: SyntheticWritingStats;
};

type Block = { type: "paragraph" | "heading"; level: 1 | 2; id: string; text: string };
type Event = EvidenceSegmentV2["events"][number];
type Source = "editor" | "paste";
type Timed = { event: Event; at: number; sessionId: string };

const DEFAULT_START = "2026-10-12T08:00:00.000Z";
const MINUTE = 60_000;
const wholeMinute = (ms: number) => new Date(Math.floor(ms / MINUTE) * MINUTE).toISOString();

const toDocument = (blocks: readonly Block[]): CanonicalDocument => ({
  schemaVersion: DOCUMENT_SCHEMA_VERSION,
  nodes: blocks.map((block) => {
    const children = block.text === "" ? [] : [textNode(block.text)];
    const id = block.id as NodeId;
    return block.type === "heading"
      ? headingNode(id, block.level, children)
      : paragraphNode(id, children);
  }),
});
const hashOf = async (blocks: readonly Block[]) =>
  (await digestCanonicalDocumentV2(toDocument(blocks) as unknown as JcsJsonValue)).sha256;

/** The writer: one document, one clock, and the events written so far. */
async function createWriter(random: Random, startMs: number) {
  const blocks: Block[] = [{ type: "paragraph", level: 1, id: REVISION_ZERO_NODE_ID, text: "" }];
  const timed: Timed[] = [];
  const stats: SyntheticWritingStats = {
    events: 0,
    typedCharacters: 0,
    deletedCharacters: 0,
    pastedCharacters: 0,
    sessions: 1,
  };
  let clock = startMs;
  let sessionId = random.uuid();
  let hash = await hashOf(blocks);

  /** Position of the opening token of block `index`. */
  const startOf = (index: number) =>
    blocks.slice(0, index).reduce((sum, block) => sum + block.text.length + 2, 0);
  const attrsOf = (block: Block, nodeId: string | null) =>
    block.type === "heading" ? { level: block.level, nodeId } : { nodeId };

  async function record(source: Source, steps: unknown[], touched: string[]): Promise<void> {
    const after = await hashOf(blocks);
    clock += 150 + random.int(900);
    timed.push({
      at: clock,
      sessionId,
      event: {
        sequence: timed.length + 1,
        source,
        steps,
        touchedNodeIds: [...new Set(touched)].sort(),
        beforeDocumentHash: hash,
        afterDocumentHash: after,
      } as Event,
    });
    hash = after;
    stats.events += 1;
  }

  async function insert(index: number, offset: number, text: string, source: Source = "editor") {
    const block = blocks[index]!;
    const pos = startOf(index) + 1 + offset;
    block.text = block.text.slice(0, offset) + text + block.text.slice(offset);
    if (source === "paste") stats.pastedCharacters += text.length;
    else stats.typedCharacters += text.length;
    await record(
      source,
      [{ stepType: "replace", from: pos, to: pos, slice: { content: [{ type: "text", text }] } }],
      [block.id],
    );
  }

  async function remove(index: number, offset: number, length: number) {
    const block = blocks[index]!;
    const from = startOf(index) + 1 + offset;
    const removed = block.text.slice(offset, offset + length);
    const removedSha256 = await sha256WebCrypto(
      canonicalizeJcs({ content: [{ type: "text", text: removed }] }),
    );
    block.text = block.text.slice(0, offset) + block.text.slice(offset + length);
    stats.deletedCharacters += length;
    await record(
      "editor",
      [{ stepType: "replace", from, to: from + length, removedSha256 }],
      [block.id],
    );
  }

  /** Types `text` at the end of block `index` in short bursts, with a rare typo. */
  async function type(index: number, text: string) {
    for (let done = 0; done < text.length;) {
      const burst = text.slice(done, done + 1 + random.int(5));
      const end = blocks[index]!.text.length;
      if (random.int(25) === 0) {
        await insert(index, end, "q");
        await remove(index, end, 1);
      }
      await insert(index, end, burst);
      done += burst.length;
    }
  }

  /** Enter at the end of block `index`: a new empty paragraph with a new id. */
  async function enter(index: number) {
    const block = blocks[index]!;
    const pos = startOf(index) + 1 + block.text.length;
    const id = random.uuid();
    blocks.splice(index + 1, 0, { type: "paragraph", level: 1, id, text: "" });
    await record(
      "editor",
      [
        {
          stepType: "replace",
          from: pos,
          to: pos,
          slice: {
            content: [
              { type: block.type, attrs: attrsOf(block, block.id) },
              { type: "paragraph", attrs: { nodeId: null } },
            ],
            openStart: 1,
            openEnd: 1,
          },
          structure: true,
        },
        { stepType: "attr", pos: pos + 1, attr: "nodeId", value: id },
      ],
      [block.id, id],
    );
  }

  async function toHeading(index: number, level: 1 | 2) {
    const block = blocks[index]!;
    const from = startOf(index);
    const to = from + block.text.length + 2;
    block.type = "heading";
    block.level = level;
    await record(
      "editor",
      [
        {
          stepType: "replaceAround",
          from,
          to,
          gapFrom: from + 1,
          gapTo: to - 1,
          insert: 1,
          slice: { content: [{ type: "heading", attrs: attrsOf(block, block.id) }] },
          structure: true,
        },
      ],
      [block.id],
    );
  }

  return {
    blocks,
    timed,
    stats,
    insert,
    remove,
    type,
    enter,
    toHeading,
    pause(ms: number) {
      clock += ms;
    },
    newSession(ms: number) {
      clock += ms;
      sessionId = random.uuid();
      stats.sessions += 1;
    },
  };
}

/**
 * Writes `paper` from an empty document: the title, then every section as a
 * heading and its paragraphs. Once per section the writer goes back, deletes
 * the last word of a paragraph and types it again; the first section ends
 * with one pasted paragraph. Each later section is a new session.
 */
async function write(paper: SyntheticPaper, random: Random, startMs: number) {
  const writer = await createWriter(random, startMs);
  let last = 0;
  await writer.type(last, paper.title);
  await writer.toHeading(last, 1);
  for (const [number, section] of paper.sections.entries()) {
    if (number > 0) writer.newSession((2 + random.int(20)) * 60 * MINUTE);
    await writer.enter(last++);
    await writer.type(last, section.heading);
    await writer.toHeading(last, 2);
    const written: number[] = [];
    for (const paragraph of section.paragraphs) {
      await writer.enter(last++);
      await writer.type(last, paragraph);
      written.push(last);
      writer.pause((20 + random.int(70)) * 1000);
    }
    // A revision: the last word before the full stop, removed and typed again.
    const revised = random.pick(written);
    const text = writer.blocks[revised]!.text;
    const wordStart = text.lastIndexOf(" ") + 1;
    const word = text.slice(wordStart, -1);
    await writer.remove(revised, wordStart, word.length);
    await writer.insert(revised, wordStart, word);
    if (number === 0) {
      await writer.enter(last++);
      await writer.insert(last, 0, paper.pastedSentence, "paste");
    }
  }
  return writer;
}

/**
 * An invented paper and the evidence record of its simulated writing. Nothing
 * here is signed: receipts need a key, and a test makes its own.
 */
export async function generateSyntheticWriting(
  options: SyntheticWritingOptions,
): Promise<SyntheticWriting> {
  const segmentEvents = options.segmentEvents ?? 80;
  const startMs = Date.parse(options.startAt ?? DEFAULT_START);
  if (!Number.isInteger(segmentEvents) || segmentEvents < 1 || segmentEvents > 5000) {
    throw new RangeError(`segmentEvents must be 1 to 5000: ${segmentEvents}`);
  }
  if (Number.isNaN(startMs) || startMs % MINUTE !== 0) {
    throw new RangeError("startAt must be a whole UTC minute");
  }
  const random = createRandom(options.seed);
  const paper = generateSyntheticPaper(random, options.sections ?? 3);
  const documentId = random.uuid();
  const initialDocument = revisionZeroDocument();
  const writer = await write(paper, random, startMs);

  const segments: EvidenceSegmentV2[] = [];
  const segmentTexts: string[] = [];
  const segmentHashes: string[] = [];
  const { timed } = writer;
  for (let from = 0; from < timed.length;) {
    const first = timed[from]!;
    let to = from + 1;
    while (
      to < timed.length &&
      to - from < segmentEvents &&
      timed[to]!.sessionId === first.sessionId
    ) {
      to += 1;
    }
    const events = timed.slice(from, to).map((entry) => entry.event);
    const segment = {
      evidenceSchema: "ductus-evidence-segment-v2",
      canonicalization: "RFC8785-JCS",
      hashAlgorithm: "sha256",
      documentId,
      sessionId: first.sessionId,
      segmentId: random.uuid(),
      sequenceFrom: events[0]!.sequence,
      sequenceTo: events.at(-1)!.sequence,
      observedStartedAt: wholeMinute(first.at),
      observedEndedAt: wholeMinute(timed[to - 1]!.at),
      initialDocumentHash: events[0]!.beforeDocumentHash,
      finalDocumentHash: events.at(-1)!.afterDocumentHash,
      predecessorSegmentHash: segmentHashes.at(-1) ?? null,
      events,
      captureContext: { editorModel: "prosemirror", transactionFormat: "ductus-edit-steps-v1" },
      evidenceProfileId: "standard-v1",
    } as EvidenceSegmentV2;
    const digest = await digestEvidenceSegmentV2(segment);
    segments.push(segment);
    segmentTexts.push(digest.canonical);
    segmentHashes.push(digest.sha256);
    from = to;
  }

  return {
    paper,
    documentId,
    initialDocument,
    finalDocument: toDocument(writer.blocks),
    finalDocumentHash: segments.at(-1)!.finalDocumentHash,
    segments,
    segmentTexts,
    segmentHashes,
    stats: writer.stats,
  };
}
