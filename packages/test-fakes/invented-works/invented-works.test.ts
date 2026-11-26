// @vitest-environment node
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  findForbiddenTerms,
  unreadableCharacters,
} from "../../../scripts/forbidden-terms/index.ts";
import {
  canonicalEvidenceSegmentV2,
  findEvidenceStartBreakV2,
  isEvidenceSegmentV2,
  replayEvidenceSegmentsV2,
  verifyEvidenceChainV2,
  type JcsJsonValue,
} from "../../../server/domain/index.ts";
import { createEditStepsV1Replayer } from "../../../server/external/storage/index.ts";
import {
  generateInventedWork,
  serializeInventedWork,
  type InventedWork,
  type InventedWorkOptions,
} from "./index.ts";
import { createRandom } from "./random.ts";

const replayer = createEditStepsV1Replayer();

const CASES: InventedWorkOptions[] = [
  { seed: "sjeme-1" },
  { seed: "sjeme-2", chapters: 0, sessions: 1 },
  { seed: "sjeme-3", chapters: 4, sessions: 5 },
  { seed: "Čćšžđ sjeme", chapters: 6, sessions: 8 },
];

/** Every text node of a canonical document, and its headings. */
function textsOf(document: JcsJsonValue): string[] {
  const nodes = (document as { nodes: { children: { text: string }[] }[] }).nodes;
  return nodes.flatMap((node) => node.children.map((child) => child.text));
}

function allText(work: InventedWork): string[] {
  const steps = work.segments.flatMap((segment) =>
    segment.events.flatMap((event) => JSON.stringify(event.steps)),
  );
  return [
    work.title,
    work.author.displayName,
    work.author.email,
    ...work.sources.map((source) => source.reference),
    ...textsOf(work.finalDocument),
    ...steps,
  ];
}

describe("generateInventedWork: determinism", () => {
  it.each(CASES)("the same seed gives byte-identical output ($seed)", (options) => {
    expect(serializeInventedWork(generateInventedWork(options))).toBe(
      serializeInventedWork(generateInventedWork({ ...options })),
    );
  });

  it("different seeds give different papers", () => {
    const outputs = new Set(
      ["a", "b", "c", "d"].map((seed) => serializeInventedWork(generateInventedWork({ seed }))),
    );
    expect(outputs.size).toBe(4);
  });

  it("pins the bytes of one seed, so a change of the generator is a visible decision", () => {
    const bytes = serializeInventedWork(generateInventedWork({ seed: "zlatno-sjeme" }));
    // When the generator changes on purpose, put the new value below in the same PR.
    expect(createHash("sha256").update(bytes, "utf8").digest("hex")).toBe(GOLDEN_SHA256);
  });

  it("the random numbers do not depend on anything but the seed", () => {
    const numbers = (seed: string) => Array.from({ length: 5 }, () => createRandom(seed).next());
    expect(numbers("x")).toEqual(numbers("x"));
    expect(createRandom("x").next()).not.toBe(createRandom("y").next());
  });

  it("refuses a blank seed and out-of-range sizes", () => {
    expect(() => generateInventedWork({ seed: "" })).toThrow("seed");
    expect(() => generateInventedWork({ seed: "   " })).toThrow("seed");
    expect(() => generateInventedWork({ seed: "s", chapters: 7 })).toThrow("chapters");
    expect(() => generateInventedWork({ seed: "s", chapters: 1.5 })).toThrow("chapters");
    expect(() => generateInventedWork({ seed: "s", sessions: 0 })).toThrow("sessions");
    expect(() => generateInventedWork({ seed: "s", sessions: 9 })).toThrow("sessions");
  });
});

describe("generateInventedWork: passes the evidence checks", () => {
  it.each(CASES)("every segment is valid and the chain verifies ($seed)", async (options) => {
    const work = generateInventedWork(options);
    expect(work.segments.length).toBeGreaterThan(0);
    for (const segment of work.segments) expect(isEvidenceSegmentV2(segment)).toBe(true);
    const payloads = work.segments.map((segment) => canonicalEvidenceSegmentV2(segment));
    const chain = await verifyEvidenceChainV2(payloads, {
      segmentHash: work.segmentHashes.at(-1)!,
      segmentCount: work.segments.length,
    });
    expect(chain).toMatchObject({ ok: true, discontinuities: [] });
  });

  it.each(CASES)("the steps replay from revision zero to the paper ($seed)", async (options) => {
    const work = generateInventedWork(options);
    const start = await findEvidenceStartBreakV2(work.initialDocument, work.segments[0]!, replayer);
    expect(start).toEqual({ ok: true, discontinuity: null });
    const result = await replayEvidenceSegmentsV2(work.initialDocument, work.segments, replayer);
    expect(result).toMatchObject({ ok: true, documentSha256: work.finalDocumentSha256 });
    if (result.ok) {
      expect(JSON.parse(result.canonicalDocument)).toEqual(work.finalDocument);
    }
  });

  it("a changed step no longer replays (the check is real)", async () => {
    const work = generateInventedWork({ seed: "sjeme-1" });
    const segments = structuredClone(work.segments);
    const removal = segments
      .flatMap((segment) => segment.events)
      .find((event) => event.steps.some((step) => "removedSha256" in step));
    expect(removal).toBeDefined();
    for (const step of removal!.steps) {
      if ("removedSha256" in step) step.removedSha256 = "0".repeat(64);
    }
    const result = await replayEvidenceSegmentsV2(work.initialDocument, segments, replayer);
    expect(result).toMatchObject({ ok: false, reason: "step_failed" });
  });

  it("a record that starts from another document does not replay", async () => {
    const one = generateInventedWork({ seed: "sjeme-1" });
    const two = generateInventedWork({ seed: "sjeme-2" });
    const result = await replayEvidenceSegmentsV2(two.finalDocument, one.segments, replayer);
    expect(result.ok).toBe(false);
  });
});

describe("generateInventedWork: simulated writing", () => {
  const work = generateInventedWork({ seed: "sjeme-3", chapters: 4, sessions: 5 });
  const events = work.segments.flatMap((segment) => segment.events);

  it("typing, deleting, pasting and cutting all happen", () => {
    const sources = new Set(events.map((event) => event.source));
    expect(sources).toContain("editor");
    expect(sources).toContain("cut");
    expect(sources).toContain("paste");
    const deletes = events.filter((event) =>
      event.steps.some((step) => "removedSha256" in step && !("slice" in step)),
    );
    expect(deletes.length).toBeGreaterThan(0);
  });

  it("there are several sessions, and pauses show as gaps between segments", () => {
    expect(new Set(work.segments.map((segment) => segment.sessionId)).size).toBe(5);
    const gaps = work.segments
      .slice(1)
      .map(
        (segment, at) =>
          Date.parse(segment.observedStartedAt) - Date.parse(work.segments[at]!.observedEndedAt),
      );
    expect(gaps.some((gap) => gap >= 60_000)).toBe(true);
    expect(gaps.every((gap) => gap >= 0)).toBe(true);
  });

  it.each([1, 2, 5, 8])(
    "gives exactly the %i sessions asked for, also in a short paper",
    (sessions) => {
      for (const chapters of [0, 2]) {
        const short = generateInventedWork({ seed: "kratko", chapters, sessions });
        expect(new Set(short.segments.map((segment) => segment.sessionId)).size).toBe(sessions);
      }
    },
  );

  it("sequence numbers run on without a gap across the segments", () => {
    events.forEach((event, at) => expect(event.sequence).toBe(at + 1));
  });

  it("the paper has a title, a literature list and the invented sources in it", () => {
    const texts = textsOf(work.finalDocument);
    expect(texts[0]).toBe(work.title);
    expect(texts).toContain("Literatura");
    for (const source of work.sources) {
      expect(texts.some((text) => text.startsWith(source.surname))).toBe(true);
    }
  });
});

describe("generateInventedWork: invented data only", () => {
  it.each(CASES)(
    "passes the forbidden terms check and has no unreadable characters ($seed)",
    (options) => {
      for (const text of allText(generateInventedWork(options))) {
        expect(findForbiddenTerms(text)).toEqual([]);
        expect(unreadableCharacters(text)).toEqual([]);
      }
    },
  );

  it.each(CASES)("every address is on .invalid ($seed)", (options) => {
    const work = generateInventedWork(options);
    const text = allText(work).join("\n");
    expect(work.author.email).toMatch(/^[a-z.]+@student\.invalid$/u);
    const hosts = [...text.matchAll(/https?:\/\/([^/\s"]+)/gu)].map((match) => match[1]);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).toMatch(/\.invalid$/u);
    const mails = [...text.matchAll(/[\w.]+@([\w.]+)/gu)].map((match) => match[1]);
    for (const host of mails) expect(host).toMatch(/\.invalid$/u);
  });

  it("signs nothing: no signature, receipt or key field anywhere", () => {
    const text = serializeInventedWork(generateInventedWork({ seed: "sjeme-1" }));
    expect(text).not.toMatch(/signature|receipt|privateKey|publicKey/iu);
  });
});

const GOLDEN_SHA256 = "22f529d96d11ce503589749827b843dd9a1dfb66356cde4fb96cec7016ae1d2c";
