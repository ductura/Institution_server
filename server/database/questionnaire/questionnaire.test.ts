// The questionnaire adapter (SRV-V18-UPITNIK-BAZA) over a fake withActor: the
// statements and parameters, refused input before a round trip, a form that is
// not there as ZD404 and the export built from sheets that carry no person.
// All values are invented.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";
import { createQuestionnaireStore } from "./index.ts";

const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const COURSE = "7e1a2b3c-4d5e-4f60-8a71-b2c3d4e5f601";
const ID = "5d1c2b3a-4f5e-4a6b-9c7d-8e9f0a1b2c31";
const QUESTIONS = [{ kind: "text" as const, text: "Primjedba?" }];

const seen: { text: string; values: readonly unknown[] }[] = [];
const fake =
  (answer: (text: string) => unknown[]): WithActor =>
  async (_token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        seen.push({ text, values });
        const rows = answer(text);
        return { rows: rows as never[], rowCount: rows.length };
      },
    });
const snake = (pairs: [string, unknown][]): Record<string, unknown> => Object.fromEntries(pairs);

describe("questionnaire store", () => {
  it("creates with the json of the questions", async () => {
    seen.length = 0;
    const store = createQuestionnaireStore(fake(() => [{ id: ID }]));
    await expect(store.create(TOKEN, COURSE, "Izmišljeno istraživanje", QUESTIONS)).resolves.toBe(
      ID,
    );
    expect(seen[0]?.text).toContain("app.create_questionnaire");
    expect(seen[0]?.values).toEqual([COURSE, "Izmišljeno istraživanje", JSON.stringify(QUESTIONS)]);
  });
  it("refuses a bad title or list before a round trip", async () => {
    seen.length = 0;
    const store = createQuestionnaireStore(fake(() => [{ id: ID }]));
    await expect(store.create(TOKEN, COURSE, " ", QUESTIONS)).rejects.toMatchObject({
      code: "ZD422",
    });
    await expect(store.update(TOKEN, ID, "Naslov", [])).rejects.toMatchObject({ code: "ZD422" });
    expect(seen).toHaveLength(0);
  });
  it("reads no form that is not there as ZD404", async () => {
    const store = createQuestionnaireStore(fake(() => []));
    await expect(store.read(TOKEN, ID)).rejects.toMatchObject({ code: "ZD404" });
    await expect(store.readForStudent(TOKEN, ID)).rejects.toMatchObject({ code: "ZD404" });
  });
  it("shapes a form", async () => {
    const row = snake([
      ["questionnaireId", ID],
      ["courseId", COURSE],
      ["title", "Naslov"],
      ["state", "open"],
      ["participated", true],
      ["questionId", "q1"],
      ["ord", 1],
      ["kind", "text"],
      ["body", "Primjedba?"],
      ["options", null],
      ["scale", null],
    ]);
    const store = createQuestionnaireStore(fake(() => [row]));
    await expect(store.readForStudent(TOKEN, ID)).resolves.toEqual({
      id: ID,
      courseId: COURSE,
      title: "Naslov",
      state: "open",
      participated: true,
      questions: [
        { id: "q1", order: 1, kind: "text", text: "Primjedba?", options: null, scale: null },
      ],
    });
  });
  it("exports sheets without a person and refuses a thin export", async () => {
    const form = snake([
      ["questionnaireId", ID],
      ["courseId", COURSE],
      ["title", "Naslov"],
      ["state", "closed"],
      ["questionId", "q1"],
      ["ord", 1],
      ["kind", "number"],
      ["body", "Kilograma?"],
      ["options", null],
      ["scale", null],
    ]);
    const build = (sheets: number) =>
      createQuestionnaireStore(
        fake((text) =>
          text.includes("app.teacher_questionnaire(")
            ? [form]
            : text.includes("questionnaire_response_ids")
              ? Array.from({ length: sheets }, (_, i) => snake([["responseId", `s${i}`]]))
              : Array.from({ length: sheets }, (_, i) =>
                  snake([
                    ["responseId", `s${i}`],
                    ["questionId", "q1"],
                    ["value", i],
                  ]),
                ),
        ),
      ).exportOf(TOKEN, ID, false);
    await expect(build(4)).resolves.toEqual({ ok: false, reason: "too_few_responses" });
    const result = await build(5);
    if (!result.ok) throw new Error("expected an export");
    expect(result.export.responseCount).toBe(5);
    expect(result.export.rows.map((row) => row.n)).toEqual([1, 2, 3, 4, 5]);
    expect(Object.keys(result.export.rows[0] ?? {}).sort()).toEqual(["n", "values"]);
  });
});
