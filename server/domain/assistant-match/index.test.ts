// SRV-1230: the deterministic match with an answer of the assistant. All texts invented.
import { describe, expect, it } from "vitest";

import { longestSharedRun, matchSegment, matchWords, MIN_MATCH_WORDS } from "./index.ts";

const ANSWER =
  "Izmišljeni odgovor: kišobrani na tramvajskoj stanici čuvaju putnike od kiše, a vjetar ih ponekad prevrne.";
const answers = [{ id: "m-1", conversationId: "c-1", text: ANSWER }];

describe("normalization", () => {
  it("folds case, spaces, punctuation, quotes and dashes", () => {
    expect(matchWords("  Kišobrani,\n„na“ — TRAMVAJSKOJ  stanici! ")).toEqual([
      "kišobrani",
      "na",
      "tramvajskoj",
      "stanici",
    ]);
  });
  it("keeps numbers as words and splits at a hyphen", () => {
    expect(matchWords("pola-puta 2026")).toEqual(["pola", "puta", "2026"]);
  });
  it("normalizes composed and decomposed letters to the same words", () => {
    expect(matchWords("čas")).toEqual(matchWords("čas"));
  });
});

describe("the match", () => {
  it("the minimum is 8 words", () => expect(MIN_MATCH_WORDS).toBe(8));

  it("matches 8 words in a row, whatever the spacing, case and punctuation", () => {
    const text =
      "Moja rečenica: KIŠOBRANI na tramvajskoj   stanici čuvaju putnike od kiše; dalje je moje.";
    expect(matchSegment(text, answers)).toEqual([
      { messageId: "m-1", conversationId: "c-1", runWords: 8 },
    ]);
  });

  it("reports the longest run, not the first", () => {
    const text =
      "kišobrani na tramvajskoj stanici čuvaju putnike od kiše a vjetar ih ponekad prevrne";
    expect(matchSegment(text, answers)[0]!.runWords).toBe(13);
  });

  it("does not match 7 words in a row", () => {
    expect(matchSegment("kišobrani na tramvajskoj stanici čuvaju putnike od", answers)).toEqual([]);
  });

  it("does not join two runs of fewer words that a different word separates", () => {
    const text = "kišobrani na tramvajskoj stanici ZAMIJENJENO čuvaju putnike od kiše a vjetar ih";
    expect(matchSegment(text, answers)).toEqual([]);
  });

  it("the same words in another order do not match", () => {
    const text = "od kiše putnike čuvaju stanici tramvajskoj na kišobrani a vjetar ih ponekad";
    expect(matchSegment(text, answers)).toEqual([]);
  });

  it("finds a run that starts after other words and ends before others", () => {
    expect(
      longestSharedRun(matchWords("a b c d e f g h i j"), matchWords("x c d e f g h i j y")),
    ).toBe(8);
    expect(
      longestSharedRun(matchWords("x a b c d e f g h y"), matchWords("q a b c d e f g h z")),
    ).toBe(8);
  });

  it("finds each answer that matches, in the order given", () => {
    const two = [
      { id: "m-1", conversationId: "c-1", text: ANSWER },
      { id: "m-2", conversationId: "c-2", text: "sasvim drugi tekst bez ičega zajedničkog s time" },
      { id: "m-3", conversationId: "c-3", text: "uvod " + ANSWER },
    ];
    const text = "kišobrani na tramvajskoj stanici čuvaju putnike od kiše";
    expect(matchSegment(text, two).map((m) => m.messageId)).toEqual(["m-1", "m-3"]);
  });

  it("a repeated phrase in the segment is found once, with the longest of its runs", () => {
    const phrase = "kišobrani na tramvajskoj stanici čuvaju putnike od kiše";
    expect(
      matchSegment(`${phrase} pa opet ${phrase} a vjetar ih ponekad prevrne`, answers)[0]!.runWords,
    ).toBe(13);
  });

  it("an empty segment, an empty answer and no answers match nothing", () => {
    expect(matchSegment("", answers)).toEqual([]);
    expect(matchSegment("kišobrani na tramvajskoj stanici čuvaju putnike od kiše", [])).toEqual([]);
    expect(
      matchSegment("kišobrani na tramvajskoj stanici čuvaju putnike od kiše", [
        { id: "m", conversationId: "c", text: "" },
      ]),
    ).toEqual([]);
  });

  it("is deterministic and carries no text of either side", () => {
    const text = "kišobrani na tramvajskoj stanici čuvaju putnike od kiše";
    const first = matchSegment(text, answers);
    expect(matchSegment(text, answers)).toEqual(first);
    expect(Object.keys(first[0]!).sort()).toEqual(["conversationId", "messageId", "runWords"]);
  });
});
