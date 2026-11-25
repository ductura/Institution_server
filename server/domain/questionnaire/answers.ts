// SRV-V18-UPITNIK-BAZA: is a value an answer to a question (as
// institution.questionnaire_value_valid), and are the answers of a sheet valid.
import {
  MAX_NUMBER_MAGNITUDE,
  MAX_TEXT_ANSWER_LENGTH,
  type QuestionKind,
  type QuestionOption,
  type QuestionScale,
} from "./definition.ts";

export type AnswerValue = string | number | string[];
export type QuestionShape = {
  id: string;
  kind: QuestionKind;
  options?: QuestionOption[] | undefined;
  scale?: QuestionScale | undefined;
};
export type Answer = { questionId: string; value: unknown };

// A line break and a tab are allowed in a free text, other control characters are not.
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/u;

export function isAnswerValue(question: QuestionShape, value: unknown): value is AnswerValue {
  const codes = new Set((question.options ?? []).map((option) => option.code));
  switch (question.kind) {
    case "single":
      return typeof value === "string" && codes.has(value);
    case "multiple":
      return (
        Array.isArray(value) &&
        value.length >= 1 &&
        new Set(value as unknown[]).size === value.length &&
        (value as unknown[]).every((code) => typeof code === "string" && codes.has(code))
      );
    case "scale":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        question.scale !== undefined &&
        value >= question.scale.min &&
        value <= question.scale.max
      );
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Math.abs(value) <= MAX_NUMBER_MAGNITUDE
      );
    case "text":
      return (
        typeof value === "string" &&
        [...value].length >= 1 &&
        [...value].length <= MAX_TEXT_ANSWER_LENGTH &&
        !TEXT_CONTROL.test(value)
      );
  }
}

/**
 * The answers of one sheet: at least one, at most one per question, each for a
 * question of the questionnaire and with a value of its kind. A question left
 * out is a question not answered.
 */
export function areValidAnswers(
  questions: readonly QuestionShape[],
  answers: unknown,
): answers is Answer[] {
  if (!Array.isArray(answers) || answers.length < 1) return false;
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  for (const answer of answers as unknown[]) {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return false;
    const keys = Object.keys(answer).sort();
    if (keys.length !== 2 || keys[0] !== "questionId" || keys[1] !== "value") return false;
    const { questionId, value } = answer as Answer;
    const question = typeof questionId === "string" ? byId.get(questionId) : undefined;
    if (!question || seen.has(question.id) || !isAnswerValue(question, value)) return false;
    seen.add(question.id);
  }
  return true;
}
