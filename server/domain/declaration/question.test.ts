// SRV-IZJAVA-PITANJE: the closed parse of the optional answer and the text
// rule of the teacher's question. Invented texts only.
import { describe, expect, it } from "vitest";

import {
  MAX_DECLARATION_ANSWER_CODE_POINTS,
  MAX_DECLARATION_QUESTION_CODE_POINTS,
  isDeclarationQuestion,
  parseDeclarationQuestionAnswer,
} from "./index.ts";

const QID = "00000000-0000-4000-8000-0000000000e1";

describe("parseDeclarationQuestionAnswer", () => {
  it.each([undefined, null])("%s is no answer", (value) => {
    expect(parseDeclarationQuestionAnswer(value)).toEqual({ ok: true, answer: null });
  });

  it("takes exactly questionId and text", () => {
    expect(
      parseDeclarationQuestionAnswer({ questionId: QID, text: "Izmišljeni\nodgovor." }),
    ).toEqual({ ok: true, answer: { questionId: QID, text: "Izmišljeni\nodgovor." } });
  });

  it("takes 2000 code points and refuses one more", () => {
    const at = "ž".repeat(MAX_DECLARATION_ANSWER_CODE_POINTS);
    expect(parseDeclarationQuestionAnswer({ questionId: QID, text: at }).ok).toBe(true);
    expect(parseDeclarationQuestionAnswer({ questionId: QID, text: `${at}ž` }).ok).toBe(false);
  });

  it.each([
    ["a string", "odgovor"],
    ["an array", [QID, "odgovor"]],
    ["an unknown key", { questionId: QID, text: "odgovor", reason: "x" }],
    ["no text", { questionId: QID }],
    ["an empty text", { questionId: QID, text: "" }],
    ["a leading space", { questionId: QID, text: " odgovor" }],
    ["a control character", { questionId: QID, text: "od\u0007govor" }],
    ["a direction override", { questionId: QID, text: "od‮govor" }],
    ["text that is not NFC", { questionId: QID, text: "č" }],
    ["an upper-case id", { questionId: QID.toUpperCase(), text: "odgovor" }],
    ["an id that is no uuid", { questionId: "pitanje-1", text: "odgovor" }],
    ["a number as text", { questionId: QID, text: 1 }],
  ])("refuses %s", (_name, value) => {
    expect(parseDeclarationQuestionAnswer(value)).toEqual({ ok: false });
  });
});

describe("isDeclarationQuestion", () => {
  it("takes a multiline question of 500 code points and refuses one more", () => {
    expect(isDeclarationQuestion("Koji izvor?\nZašto?")).toBe(true);
    expect(isDeclarationQuestion("ž".repeat(MAX_DECLARATION_QUESTION_CODE_POINTS))).toBe(true);
    expect(isDeclarationQuestion("ž".repeat(MAX_DECLARATION_QUESTION_CODE_POINTS + 1))).toBe(false);
  });

  it.each(["", " pitanje", "pitanje ", "pi\u0000tanje", null, 7])("refuses %j", (value) => {
    expect(isDeclarationQuestion(value)).toBe(false);
  });
});
