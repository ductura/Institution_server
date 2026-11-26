import { describe, expect, it } from "vitest";

import {
  QUESTIONNAIRE_EXPORT_MIN_RESPONSES,
  areValidAnswers,
  buildQuestionnaireExport,
  isAnswerValue,
  isQuestionList,
  nextState,
  type AnswerValue,
  type ExportQuestion,
} from "./index.ts";

const yesNo = [
  { code: "da", label: "Da" },
  { code: "ne", label: "Ne" },
];
const QUESTIONS: ExportQuestion[] = [
  { id: "q1", order: 1, text: "Kompostirate li?", kind: "single", options: yesNo },
  { id: "q2", order: 2, text: "Što stavljate?", kind: "multiple", options: [...yesNo] },
  { id: "q3", order: 3, text: "Napor?", kind: "scale", scale: { min: 1, max: 5 } },
  { id: "q4", order: 4, text: "Kilograma?", kind: "number" },
  { id: "q5", order: 5, text: "Primjedba?", kind: "text" },
];

describe("question list", () => {
  const ok = [{ kind: "text", text: "Primjedba?" }];
  it("accepts a valid list", () => {
    expect(isQuestionList(ok)).toBe(true);
    expect(isQuestionList([{ kind: "single", text: "A?", options: yesNo }])).toBe(true);
    expect(isQuestionList([{ kind: "scale", text: "A?", scale: { min: 0, max: 10 } }])).toBe(true);
  });
  it.each([
    ["empty", []],
    ["not a list", {}],
    ["blank text", [{ kind: "text", text: " " }]],
    ["control character", [{ kind: "text", text: "a\nb" }]],
    ["unknown kind", [{ kind: "date", text: "A?" }]],
    ["extra key", [{ kind: "text", text: "A?", extra: 1 }]],
    ["one option", [{ kind: "single", text: "A?", options: [yesNo[0]] }]],
    ["repeated code", [{ kind: "single", text: "A?", options: [yesNo[0], yesNo[0]] }]],
    [
      "bad code",
      [{ kind: "single", text: "A?", options: [{ code: "Da", label: "Da" }, yesNo[1]] }],
    ],
    ["number with options", [{ kind: "number", text: "A?", options: yesNo }]],
    ["scale min = max", [{ kind: "scale", text: "A?", scale: { min: 2, max: 2 } }]],
    ["scale above 10", [{ kind: "scale", text: "A?", scale: { min: 1, max: 11 } }]],
    [
      "scale with options",
      [{ kind: "scale", text: "A?", scale: { min: 1, max: 3 }, options: yesNo }],
    ],
    ["41 questions", Array.from({ length: 41 }, () => ok[0])],
  ])("refuses %s", (_name, value) => {
    expect(isQuestionList(value)).toBe(false);
  });
});

describe("answers", () => {
  const [q1, q2, q3, q4, q5] = QUESTIONS as [
    ExportQuestion,
    ExportQuestion,
    ExportQuestion,
    ExportQuestion,
    ExportQuestion,
  ];
  it.each([
    [q1, "da", true],
    [q1, "mozda", false],
    [q1, ["da"], false],
    [q2, ["da", "ne"], true],
    [q2, [], false],
    [q2, ["da", "da"], false],
    [q3, 5, true],
    [q3, 6, false],
    [q3, 0, false],
    [q3, 2.5, false],
    [q4, -3.25, true],
    [q4, 1e12, false],
    [q4, Number.NaN, false],
    [q5, "bilješka", true],
    [q5, "", false],
    [q5, "a\u0000b", false],
    [q5, null, false],
  ])("%j %j -> %s", (question, value, expected) => {
    expect(isAnswerValue(question, value)).toBe(expected);
  });
  it("checks a sheet", () => {
    expect(areValidAnswers(QUESTIONS, [{ questionId: "q1", value: "da" }])).toBe(true);
    expect(areValidAnswers(QUESTIONS, [])).toBe(false);
    expect(areValidAnswers(QUESTIONS, [{ questionId: "q9", value: "da" }])).toBe(false);
    expect(
      areValidAnswers(QUESTIONS, [
        { questionId: "q1", value: "da" },
        { questionId: "q1", value: "ne" },
      ]),
    ).toBe(false);
    expect(areValidAnswers(QUESTIONS, [{ questionId: "q1", value: "da", extra: 1 }])).toBe(false);
  });
});

describe("state", () => {
  it("moves one way", () => {
    expect(nextState("draft")).toBe("open");
    expect(nextState("open")).toBe("closed");
    expect(nextState("closed")).toBeNull();
  });
});

describe("export", () => {
  const sheet = (id: string, text: string): { id: string; answers: Map<string, AnswerValue> } => ({
    id,
    answers: new Map<string, AnswerValue>([
      ["q1", "da"],
      ["q5", text],
    ]),
  });
  const sheets = ["a", "b", "c", "d", "e"].map((id) => sheet(id, `tekst ${id}`));
  const input = { questionnaireId: "u1", questions: QUESTIONS, sheets, includeText: false };

  it("refuses below the least number of sheets", () => {
    expect(QUESTIONNAIRE_EXPORT_MIN_RESPONSES).toBe(5);
    expect(buildQuestionnaireExport({ ...input, sheets: sheets.slice(0, 4) })).toEqual({
      ok: false,
      reason: "too_few_responses",
    });
  });
  it("leaves free text out unless confirmed", () => {
    const result = buildQuestionnaireExport(input);
    if (!result.ok) throw new Error("expected an export");
    expect(result.export.includesText).toBe(false);
    expect(result.export.variables.map((variable) => variable.questionId)).toEqual([
      "q1",
      "q2",
      "q3",
      "q4",
    ]);
    expect(JSON.stringify(result.export)).not.toContain("tekst a");
    const withText = buildQuestionnaireExport({ ...input, includeText: true });
    if (!withText.ok) throw new Error("expected an export");
    expect(withText.export.variables).toHaveLength(5);
    expect(withText.export.rows.every((row) => typeof row.values["q5"] === "string")).toBe(true);
  });
  it("gives the same bytes for the same sheets in any arrival order, with empty as null", () => {
    const one = buildQuestionnaireExport(input);
    const other = buildQuestionnaireExport({ ...input, sheets: sheets.toReversed() });
    expect(JSON.stringify(one)).toBe(JSON.stringify(other));
    if (!one.ok) throw new Error("expected an export");
    expect(one.export.rows.map((row) => row.n)).toEqual([1, 2, 3, 4, 5]);
    expect(one.export.rows[0]?.values["q2"]).toBeNull();
    expect(one.export.responseCount).toBe(5);
  });
  it("orders by a hash of the id, not by arrival", () => {
    const result = buildQuestionnaireExport({ ...input, includeText: true });
    if (!result.ok) throw new Error("expected an export");
    const order = result.export.rows.map((row) => String(row.values["q5"]).slice(-1));
    expect(order).not.toEqual(["a", "b", "c", "d", "e"]);
  });
});
