// SRV-V18-UPITNIK-BAZA: the shape of questionnaire-export-v1 (val 18, V18-4):
// a description of the variables and one row per sheet. Pure and repeatable: the
// same input gives the same bytes. A row has no person and no time; the rows are
// in the order of a hash of the sheet id, never in the order they came in
// (V18-1). Free text stays out unless the author confirms it. Nothing here
// ranks, sums or compares people.
import { createHash } from "node:crypto";

import type { AnswerValue, QuestionShape } from "./answers.ts";
import type { QuestionOption } from "./definition.ts";

/** The fewest sheets for an export; the owner confirms the value (OP-V18-4). */
export const QUESTIONNAIRE_EXPORT_MIN_RESPONSES = 5;
export const QUESTIONNAIRE_EXPORT_SCHEMA = "questionnaire-export-v1";

export type ExportQuestion = QuestionShape & { order: number; text: string };
export type ExportSheet = { id: string; answers: ReadonlyMap<string, AnswerValue> };
export type ExportVariable = {
  questionId: string;
  order: number;
  kind: ExportQuestion["kind"];
  label: string;
  options: QuestionOption[];
};
export type QuestionnaireExport = {
  schema: typeof QUESTIONNAIRE_EXPORT_SCHEMA;
  questionnaireId: string;
  variables: ExportVariable[];
  rows: { n: number; values: Record<string, AnswerValue | null> }[];
  responseCount: number;
  includesText: boolean;
};
export type ExportResult =
  { ok: true; export: QuestionnaireExport } | { ok: false; reason: "too_few_responses" };

const digest = (id: string) => createHash("sha256").update(id, "utf8").digest("hex");

export function buildQuestionnaireExport(input: {
  questionnaireId: string;
  questions: readonly ExportQuestion[];
  sheets: readonly ExportSheet[];
  includeText: boolean;
}): ExportResult {
  const { questionnaireId } = input;
  const { includeText } = input;
  if (input.sheets.length < QUESTIONNAIRE_EXPORT_MIN_RESPONSES)
    return { ok: false, reason: "too_few_responses" };
  const questions = input.questions
    .filter((question) => includeText || question.kind !== "text")
    .toSorted((a, b) => a.order - b.order);
  const sheets = input.sheets.toSorted((a, b) => {
    const [x, y] = [digest(a.id), digest(b.id)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return {
    ok: true,
    export: {
      schema: QUESTIONNAIRE_EXPORT_SCHEMA,
      questionnaireId,
      variables: questions.map((question) => ({
        questionId: question.id,
        order: question.order,
        kind: question.kind,
        label: question.text,
        options: question.options ?? [],
      })),
      rows: sheets.map((sheet, index) => ({
        n: index + 1,
        values: Object.fromEntries(
          questions.map((question) => [question.id, sheet.answers.get(question.id) ?? null]),
        ),
      })),
      responseCount: sheets.length,
      includesText: includeText,
    },
  };
}
