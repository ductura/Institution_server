// SRV-1809: the links the service hands to the 10-argument acceptance, taken
// from the domain's invented golden vectors (read as bytes: another area may
// import only server/domain/index.ts).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { type EvidenceSegment, isEvidenceSegment } from "../domain/index.ts";

import { aiTransferLinksOf } from "./service.ts";

type Vector = { name: string; segment: EvidenceSegment };
const read = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`../domain/forensics/golden-vectors/${file}`, import.meta.url), "latin1"),
  ) as { accepted?: Vector[]; chain?: { segments: { segment: EvidenceSegment }[] } };

const v4 = read("evidence-v4.json").accepted ?? [];
const vector = (name: string) => {
  const found = v4.find((v) => v.name === name)?.segment;
  if (found === undefined || !isEvidenceSegment(found)) throw new Error(`no vector ${name}`);
  return found;
};
const transfer = vector("v4-ai-transfer");
const LINK = { aiTransferId: "00000000-0000-4000-8000-0000000000a2" };

describe("aiTransferLinksOf", () => {
  it("names the transfer of a v4 segment's ai-transfer event, with its hash", () => {
    const event = transfer.events.find((e) => e.source === "ai-transfer") as {
      aiTransferSha256: string;
    };
    expect(aiTransferLinksOf(transfer)).toEqual([
      { ...LINK, aiTransferSha256: event.aiTransferSha256 },
    ]);
  });

  it("is an empty array for a v4 segment without an ai-transfer event", () => {
    expect(aiTransferLinksOf(vector("v4-import"))).toEqual([]);
  });

  it("is null for a v2 segment", () => {
    const v2 = read("evidence-v2.json").chain?.segments[0]?.segment;
    expect(v2?.evidenceSchema).toBe("ductus-evidence-segment-v2");
    expect(aiTransferLinksOf(v2!)).toBeNull();
  });

  it("keeps the event order and a record named twice, for the database to refuse", () => {
    const event = transfer.events.find((e) => e.source === "ai-transfer")!;
    const other = { ...event, aiTransferId: "00000000-0000-4000-8000-0000000000a3" };
    const twice = { ...transfer, events: [event, other, event] } as EvidenceSegment;
    expect(aiTransferLinksOf(twice)?.map((l) => l.aiTransferId)).toEqual([
      LINK.aiTransferId,
      other.aiTransferId,
      LINK.aiTransferId,
    ]);
  });

  it("copies only the id and the hash of an event", () => {
    const links = aiTransferLinksOf(transfer) ?? [];
    for (const link of links)
      expect(Object.keys(link).sort()).toEqual(["aiTransferId", "aiTransferSha256"]);
  });
});
