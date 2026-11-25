// SRV-V18-UPITNIK-BAZA: the definition of a questionnaire (migration
// 20261219370000_questionnaire.sql, same rules). Pure functions, no I/O.
export const QUESTION_KINDS = ["single", "multiple", "scale", "number", "text"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const QUESTIONNAIRE_STATES = ["draft", "open", "closed"] as const;
export type QuestionnaireState = (typeof QUESTIONNAIRE_STATES)[number];

export const MAX_TITLE_LENGTH = 200;
export const MAX_QUESTION_LENGTH = 500;
export const MAX_QUESTIONS = 40;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 20;
export const MAX_OPTION_LABEL_LENGTH = 120;
export const MAX_SCALE = 10;
export const MAX_TEXT_ANSWER_LENGTH = 2000;
export const MAX_NUMBER_MAGNITUDE = 1_000_000_000;

export type QuestionOption = { code: string; label: string };
export type QuestionScale = { min: number; max: number };
export type QuestionDefinition = {
  kind: QuestionKind;
  text: string;
  options?: QuestionOption[];
  scale?: QuestionScale;
};

// A control character is any code point below U+0020 or U+007F to U+009F.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const CODE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const lengthOf = (text: string) => [...text].length;

/** One line of 1..max characters, trimmed, without control characters. */
export function isLine(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    lengthOf(value) >= 1 &&
    lengthOf(value) <= max &&
    value === value.trim() &&
    !CONTROL.test(value)
  );
}

export function isTitle(value: unknown): value is string {
  return isLine(value, MAX_TITLE_LENGTH);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isOptions(value: unknown): value is QuestionOption[] {
  if (!Array.isArray(value) || value.length < MIN_OPTIONS || value.length > MAX_OPTIONS)
    return false;
  const codes = new Set<string>();
  for (const option of value as unknown[]) {
    if (!isRecord(option) || Object.keys(option).length !== 2) return false;
    const { code, label } = option;
    if (typeof code !== "string" || !CODE.test(code) || !isLine(label, MAX_OPTION_LABEL_LENGTH))
      return false;
    codes.add(code);
  }
  return codes.size === value.length;
}

function isScale(value: unknown): value is QuestionScale {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  const { min, max } = value;
  return (
    Number.isInteger(min) &&
    Number.isInteger(max) &&
    (min as number) >= 0 &&
    (max as number) <= MAX_SCALE &&
    (min as number) < (max as number)
  );
}

/** Options for a choice, a scale for a scale, nothing for a number or a text. */
export function isShape(kind: unknown, options: unknown, scale: unknown): boolean {
  switch (kind) {
    case "single":
    case "multiple":
      return isOptions(options) && scale === undefined;
    case "scale":
      return isScale(scale) && options === undefined;
    case "number":
    case "text":
      return options === undefined && scale === undefined;
    default:
      return false;
  }
}

export function isQuestionDefinition(value: unknown): value is QuestionDefinition {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "text", "options", "scale"]) &&
    typeof value["kind"] === "string" &&
    isLine(value["text"], MAX_QUESTION_LENGTH) &&
    isShape(value["kind"], value["options"], value["scale"])
  );
}

/** The questions as a client sends them: 1..40, each valid. The order is the array's. */
export function isQuestionList(value: unknown): value is QuestionDefinition[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_QUESTIONS &&
    (value as unknown[]).every(isQuestionDefinition)
  );
}

/** The next state of a questionnaire; there is no way back. */
export function nextState(state: QuestionnaireState): QuestionnaireState | null {
  return state === "draft" ? "open" : state === "open" ? "closed" : null;
}
