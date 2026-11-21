import { describe, expect, it } from "vitest";

import { compareAssistantResponses, readFakeAssistantResponses } from "./index.ts";
import { normalizeMatchText } from "./normalization.ts";

const PASSAGE = "Kompost nastaje razgradnjom organske tvari uz prisutnost kisika";
const SCOPE = {
  principalId: "demo-student",
  assignmentId: "demo-assignment",
  requestedAt: "2026-11-21T10:15:00.123456Z",
};

function compare(text: string, ...answers: string[]) {
  return compareAssistantResponses(
    [{ blockId: "demo-block", text }],
    answers.map((answer, index) => ({ messageId: `demo-message-${index}`, text: answer })),
  );
}

describe("ductura-match-norm-v1", () => {
  it("matches the normalization vector and all punctuation aliases", () => {
    expect(
      normalizeMatchText("  Ｋompost\u00adiranje — „Zreli”\u200b kompost\tiz VRTA  ").points.join(
        "",
      ),
    ).toBe('kompostiranje - "zreli" kompost iz vrta');
    expect(
      normalizeMatchText("‘’‚‛′ “”„‟″«» ‐‑‒–—―− čÓ a\u200c\u200d\u2060\ufeffb").points.join(""),
    ).toBe('\'\'\'\'\' """"""" ------- čó ab');
  });

  it("maps NFKC expansion, collapsed space, and NFC composition to source code points", () => {
    expect(normalizeMatchText(" 🪴ﬀ\t  c\u030c ")).toEqual({
      points: ["🪴", "f", "f", " ", "č"],
      sourceRanges: [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
        { from: 2, to: 3 },
        { from: 3, to: 6 },
        { from: 6, to: 8 },
      ],
      sourceLength: 9,
    });
    expect(normalizeMatchText("a\u0315\u0300").sourceRanges).toEqual([
      { from: 0, to: 3 },
      { from: 1, to: 2 },
    ]);
  });
});

describe("provenance-share-v1 AI match", () => {
  it("reproduces the contract spans, in submitted block order, without message metadata", () => {
    const { aiMatch, witnesses } = compareAssistantResponses(
      [
        { blockId: "b1", text: `Kućno kompostiranje smanjuje količinu otpada. ${PASSAGE}.` },
        {
          blockId: "b2",
          text: "Prema izmišljenom istraživanju, četvrti s kompostištima imaju manje otpada.",
        },
        { blockId: "b3", text: "Uvezeni odlomak iz ranijeg nacrta. (dopuna)" },
        {
          blockId: "b4",
          text: "„Zreli kompost” ima miris šumskog tla i tamnu boju te se koristi kao gnojivo u vrtu.",
        },
        { blockId: "b5", text: "Proces obično traje nekoliko mjeseci, ovisno o vlazi." },
      ],
      [
        { messageId: "demo-o1", text: `${PASSAGE}. Proces obično traje nekoliko mjeseci.` },
        {
          messageId: "demo-o2",
          text: '"Zreli kompost" ima miris šumskog tla i tamnu boju te se koristi kao gnojivo. Može se miješati sa zemljom.',
        },
      ],
    );
    expect(aiMatch).toStrictEqual({
      normalization: "ductura-match-norm-v1",
      minMatchCodePoints: 60,
      spans: [
        { blockId: "b1", from: 46, to: 109 },
        { blockId: "b4", from: 1, to: 76 },
      ],
      notice: "not_authorship_evidence",
    });
    expect(witnesses.map(({ messageId }) => messageId)).toEqual(["demo-o1", "demo-o2"]);
  });

  it("uses 60 code points and selects endpoints on submitted words", () => {
    const threshold = "𐐀".repeat(60);
    expect(compare(`🪴 ${threshold}.`, `x${threshold}x`).aiMatch.spans).toEqual([
      { blockId: "demo-block", from: 2, to: 62 },
    ]);
    expect(compare(threshold.slice(2), threshold).aiMatch.spans).toEqual([]);
    expect(compare(`x${threshold}`, threshold).aiMatch.spans).toEqual([]);
    expect(compare(`${threshold}x`, threshold).aiMatch.spans).toEqual([]);
    expect(compare(`${PASSAGE} rotkvica`, `${PASSAGE} rotk`).aiMatch.spans).toEqual([
      { blockId: "demo-block", from: 0, to: 63 },
    ]);
  });

  it("does not stitch a match across submitted blocks or across messages", () => {
    const first = "a".repeat(30);
    const second = "b".repeat(30);
    const text = `${first} ${second}`;
    expect(compare(text, first, second).aiMatch.spans).toEqual([]);
    expect(
      compareAssistantResponses(
        [
          { blockId: "b1", text: first },
          { blockId: "b2", text: second },
        ],
        [{ messageId: "demo-message", text }],
      ).aiMatch.spans,
    ).toEqual([]);
  });

  it("unions overlapping matches and leaves disjoint ones separate", () => {
    const first = "a".repeat(35);
    const middle = "b".repeat(35);
    const last = "c".repeat(35);
    const text = `${first} ${middle} ${last}! ${PASSAGE}`;
    const result = compare(text, `${first} ${middle}`, `${middle} ${last}`, PASSAGE);
    expect(result.aiMatch.spans).toEqual([
      { blockId: "demo-block", from: 0, to: 107 },
      { blockId: "demo-block", from: 109, to: 172 },
    ]);
    expect(result.witnesses).toEqual([
      { blockId: "demo-block", normalizedFrom: 0, normalizedTo: 71, messageId: "demo-message-0" },
      { blockId: "demo-block", normalizedFrom: 36, normalizedTo: 107, messageId: "demo-message-1" },
      {
        blockId: "demo-block",
        normalizedFrom: 109,
        normalizedTo: 172,
        messageId: "demo-message-2",
      },
    ]);
  });

  it("includes skipped interior points, retains punctuation and accents, and always carries the notice", () => {
    const text = `🪴 ${PASSAGE.replace("organske", "organ\u200bske").replace("tvari uz", "tvari\t  uz")}.`;
    expect(compare(text, PASSAGE).aiMatch.spans).toEqual([
      { blockId: "demo-block", from: 2, to: [...text].length - 1 },
    ]);
    expect(compare(PASSAGE.replace("tvari uz", "tvari, uz"), PASSAGE).aiMatch.spans).toEqual([]);
    expect(compare(PASSAGE.replace("tvari", "tvári"), PASSAGE).aiMatch.spans).toEqual([]);
    expect(compare(PASSAGE).aiMatch).toEqual(
      compare(PASSAGE, "izmišljeni nepodudarni odgovor").aiMatch,
    );
    expect(compare(PASSAGE).aiMatch.notice).toBe("not_authorship_evidence");
  });

  it("reads only still-available Ductura assistant replies before the microsecond cutoff", () => {
    const matchable = {
      ...SCOPE,
      source: "ductura",
      role: "assistant",
      recordedAt: "2026-11-21T10:15:00.123455Z",
      deleted: false,
      text: PASSAGE,
    } as const;
    const responses = readFakeAssistantResponses(SCOPE, [
      { ...matchable, messageId: "demo-in-scope" },
      { ...matchable, messageId: "demo-other-student", principalId: "demo-student-2" },
      { ...matchable, messageId: "demo-other-assignment", assignmentId: "demo-assignment-2" },
      { ...matchable, messageId: "demo-at-cutoff", recordedAt: SCOPE.requestedAt },
      { ...matchable, messageId: "demo-after", recordedAt: "2026-11-21T10:15:00.123457Z" },
      { ...matchable, messageId: "demo-deleted", deleted: true },
      { ...matchable, messageId: "demo-user", role: "user" },
      { ...matchable, messageId: "demo-external", source: "external" },
    ]);
    expect(responses).toStrictEqual([{ messageId: "demo-in-scope", text: PASSAGE }]);
    const result = compareAssistantResponses([{ blockId: "demo-block", text: PASSAGE }], responses);
    expect(result.witnesses).toEqual([
      { blockId: "demo-block", normalizedFrom: 0, normalizedTo: 63, messageId: "demo-in-scope" },
    ]);
  });

  it("handles a 15,000-word work and 500 responses of 8,000 code points", () => {
    const text = `${PASSAGE} ${"biljka ".repeat(14_992)}`;
    const nearMiss = "biljka ".repeat(8).concat("vrt ").repeat(160).slice(0, 8_000);
    const matching = PASSAGE.padEnd(8_000, ".");
    const { aiMatch } = compare(text, ...Array.from({ length: 499 }, () => nearMiss), matching);
    expect(aiMatch.spans).toEqual([{ blockId: "demo-block", from: 0, to: 63 }]);
  }, 15_000);
});
