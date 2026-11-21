import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  displayedPasteOriginV1,
  eventTextBytes,
  eventTextOf,
  PASTE_ORIGIN_VERDICTS_V1,
  PasteOriginVerdictRecordV1,
  pasteOriginVerdictV1,
  type PasteOriginVerdictInputV1,
} from "./event-text.ts";

// SRV-1809 (plan M9.0-S1; Ductus docs/contracts/evidence-segment-v4.md, "Tekst
// događaja", "Djelomično lijepljenje" and "Presuda i brisanje izvora"; tests
// C6, D1 to D3, D9, K14, E5). The known answers were computed outside the code
// under test (A8). All data is invented.

type EventVector = { ranges: string[]; text: string; sha256: string };
const vectors = JSON.parse(
  readFileSync(new URL("./golden-vectors/ai-transfer-v1.json", import.meta.url), "utf8"),
) as { eventText: EventVector[] };
const hashOf = (text: string) => {
  const bytes = eventTextBytes(text);
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
};

describe("event text: known answers (A8, K14)", () => {
  it.each(vectors.eventText.map((v) => [JSON.stringify(v.ranges), v] as const))(
    "%s",
    (_name, vector) => {
      const text = eventTextOf(vector.ranges);
      expect(text).toBe(vector.text);
      expect(hashOf(text)).toBe(vector.sha256);
    },
  );

  it("NFC and NFD give different hashes: the text is never normalised", () => {
    const [nfc, nfd] = vectors.eventText.slice(2, 4);
    expect(nfc!.text.normalize("NFD")).toBe(nfd!.text);
    expect(nfc!.sha256).not.toBe(nfd!.sha256);
  });

  it("text with a lone surrogate has no bytes", () => {
    expect(eventTextBytes("Lorem \uD800")).toBeNull();
    expect(eventTextBytes("Lorem \uDC00 x")).toBeNull();
    expect(eventTextBytes("😀")).toEqual(new Uint8Array([0xf0, 0x9f, 0x98, 0x80]));
  });
});

const ANSWER = "Lorem odlomak 1 o gradskom vijeću. Drugi izmišljeni odlomak.";
function input(eventText: string, sourceText: string | null = ANSWER): PasteOriginVerdictInputV1 {
  const hash = hashOf(eventText);
  return {
    claimedTextSha256: hash ?? "0".repeat(64),
    eventText,
    eventTextSha256: hash,
    sourceText,
  };
}

describe("paste origin verdict (D1 to D3, D-58)", () => {
  it("is known for the whole answer and for a contiguous part of it", () => {
    expect(pasteOriginVerdictV1(input(ANSWER))).toBe("known");
    expect(pasteOriginVerdictV1(input("o gradskom vijeću."))).toBe("known");
  });

  it.each([
    ["text that is not a contiguous substring", input("Lorem vijeću")],
    ["a changed space", input("o  gradskom")],
    ["a changed line break", input("o gradskom\nvijeću")],
    ["NFD instead of NFC", input("vijeću".normalize("NFD"))],
    ["a missing or foreign source (C7)", input("Lorem", null)],
    ["empty event text", input("")],
    ["a lone surrogate", input("Lorem \uD800")],
    ["a source with a lone surrogate", input("Lorem", "Lorem \uD800")],
  ])("is not_observed for %s", (_name, value) => {
    expect(pasteOriginVerdictV1(value)).toBe("not_observed");
  });

  it("is not_observed when the claimed hash is not the hash of the event text", () => {
    const value = input("o gradskom");
    expect(pasteOriginVerdictV1({ ...value, claimedTextSha256: "f".repeat(64) })).toBe(
      "not_observed",
    );
  });

  it("returns only a verdict, never source text or a position (D9)", () => {
    expect(PASTE_ORIGIN_VERDICTS_V1).toEqual(["known", "not_observed"]);
    expect(typeof pasteOriginVerdictV1(input("Lorem"))).toBe("string");
  });
});

describe("stored verdict and projection (E5, D9)", () => {
  const record = {
    segmentHash: "a".repeat(64),
    sequence: 3,
    kind: "ai-response",
    refId: "00000000-0000-4000-8000-0000000000d1",
    textSha256: hashOf("o gradskom")!,
    verdict: "known",
  } as const;

  it("holds the claim and the verdict, nothing about the source", () => {
    expect(Value.Check(PasteOriginVerdictRecordV1, record)).toBe(true);
    for (const extra of ["sourceText", "offset", "sourceSha256"]) {
      expect(Value.Check(PasteOriginVerdictRecordV1, { ...record, [extra]: "x" })).toBe(false);
    }
  });

  it("shows known only for a known verdict whose replayed text hash matches", () => {
    expect(displayedPasteOriginV1(record, record.textSha256)).toBe("known");
    expect(displayedPasteOriginV1(record, "b".repeat(64))).toBe("not_observed");
    expect(displayedPasteOriginV1(record, null)).toBe("not_observed");
    expect(displayedPasteOriginV1({ ...record, verdict: "not_observed" }, record.textSha256)).toBe(
      "not_observed",
    );
    expect(displayedPasteOriginV1(null, record.textSha256)).toBe("not_observed");
  });

  it("keeps a known verdict after the source is deleted: the projection never reads the source", () => {
    // The verdict was taken at acceptance; deleting the answer later changes
    // no input of the projection.
    const atAcceptance = pasteOriginVerdictV1(input("o gradskom"));
    expect(atAcceptance).toBe("known");
    expect(displayedPasteOriginV1({ ...record, verdict: atAcceptance }, record.textSha256)).toBe(
      "known",
    );
    // A claim that reaches the server only after the deletion is not_observed.
    expect(pasteOriginVerdictV1(input("o gradskom", null))).toBe("not_observed");
  });
});
