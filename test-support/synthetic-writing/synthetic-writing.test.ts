import { describe, expect, it } from "vitest";

import { findForbiddenTerms } from "../../scripts/forbidden-terms/index.ts";
import {
  EDIT_STEP_FORMAT_V1,
  isEvidenceSegmentV2,
  parseEditSteps,
  REVISION_ZERO_SHA256,
  verifyEvidenceChainV2,
} from "../../server/domain/index.ts";
import { createRandom, generateSyntheticPaper, generateSyntheticWriting } from "./index.ts";

/**
 * DAN-1566. The record is checked with the same domain code the server uses
 * for a real one. That the steps replay to the recorded document hashes was
 * checked once against the editor's replayer in Ductus (README); this
 * repository has no replayer to repeat that check with.
 */

describe("generateSyntheticPaper", () => {
  it("gives the same paper for the same seed and another for another seed", () => {
    const paper = generateSyntheticPaper(createRandom(7));
    expect(generateSyntheticPaper(createRandom(7))).toEqual(paper);
    expect(generateSyntheticPaper(createRandom(8))).not.toEqual(paper);
  });

  it("is invented, marked as such, and free of forbidden terms", () => {
    for (let seed = 0; seed < 40; seed++) {
      const paper = generateSyntheticPaper(createRandom(seed), 5);
      expect(paper.author.email).toMatch(/@student\.example\.invalid$/u);
      expect(paper.author.name).toMatch(/^Izmišljen/u);
      expect(paper.title).toContain("izmišljen");
      const text = [
        paper.title,
        paper.pastedSentence,
        ...paper.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
      ].join("\n");
      expect(findForbiddenTerms(text)).toEqual([]);
    }
  });

  it("refuses a section count it cannot write", () => {
    expect(() => generateSyntheticPaper(createRandom(1), 0)).toThrow(RangeError);
    expect(() => generateSyntheticPaper(createRandom(1), 6)).toThrow(RangeError);
  });
});

describe("generateSyntheticWriting", () => {
  it("is byte-identical for the same seed and differs for another", async () => {
    const one = await generateSyntheticWriting({ seed: 11 });
    const again = await generateSyntheticWriting({ seed: 11 });
    const other = await generateSyntheticWriting({ seed: 12 });
    expect(again.segmentTexts).toEqual(one.segmentTexts);
    expect(again.segmentHashes).toEqual(one.segmentHashes);
    expect(other.segmentHashes).not.toEqual(one.segmentHashes);
  });

  it("writes a valid chain of segments from revision zero", async () => {
    const writing = await generateSyntheticWriting({ seed: 3, segmentEvents: 50 });
    const { segments, segmentTexts, segmentHashes } = writing;
    expect(segments.length).toBeGreaterThan(3);
    expect(segments.every(isEvidenceSegmentV2)).toBe(true);
    expect(segments[0]!.sequenceFrom).toBe(1);
    expect(segments[0]!.initialDocumentHash).toBe(REVISION_ZERO_SHA256);
    expect(segments.every((segment) => segment.events.length <= 50)).toBe(true);
    for (const event of segments.flatMap((segment) => segment.events)) {
      expect(parseEditSteps(EDIT_STEP_FORMAT_V1, event.steps).ok).toBe(true);
    }
    expect(
      await verifyEvidenceChainV2(segmentTexts, {
        segmentHash: segmentHashes.at(-1)!,
        segmentCount: segments.length,
      }),
    ).toMatchObject({ ok: true, discontinuities: [] });
    expect(writing.finalDocumentHash).toBe(segments.at(-1)!.finalDocumentHash);
  });

  it("ends with the paper, the pasted paragraph after the first section", async () => {
    const { paper, finalDocument, stats, segments } = await generateSyntheticWriting({
      seed: 5,
      sections: 2,
    });
    const [first, second] = paper.sections;
    expect(
      finalDocument.nodes.map((node) => [
        node.type,
        node.children.map((child) => ("text" in child ? child.text : "")).join(""),
      ]),
    ).toEqual([
      ["heading", paper.title],
      ["heading", first!.heading],
      ...first!.paragraphs.map((text) => ["paragraph", text]),
      ["paragraph", paper.pastedSentence],
      ["heading", second!.heading],
      ...second!.paragraphs.map((text) => ["paragraph", text]),
    ]);
    expect(new Set(finalDocument.nodes.map((node) => node.id)).size).toBe(
      finalDocument.nodes.length,
    );

    const events = segments.flatMap((segment) => segment.events);
    expect(stats.events).toBe(events.length);
    expect(stats.sessions).toBe(2);
    expect(new Set(segments.map((segment) => segment.sessionId)).size).toBe(2);
    expect(stats.pastedCharacters).toBe(paper.pastedSentence.length);
    expect(events.filter((event) => event.source === "paste")).toHaveLength(1);
    expect(stats.deletedCharacters).toBeGreaterThan(0);
    const typedAndKept = stats.typedCharacters - stats.deletedCharacters;
    const kept = finalDocument.nodes
      .flatMap((node) => node.children)
      .reduce((sum, child) => sum + ("text" in child ? child.text.length : 0), 0);
    expect(typedAndKept + stats.pastedCharacters).toBe(kept);
  });

  it("refuses options it cannot honour", async () => {
    await expect(generateSyntheticWriting({ seed: 1, segmentEvents: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      generateSyntheticWriting({ seed: 1, startAt: "2026-10-12T08:00:30.000Z" }),
    ).rejects.toThrow(RangeError);
  });
});
