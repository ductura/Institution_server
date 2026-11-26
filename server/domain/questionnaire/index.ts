// Public interface of server/domain/questionnaire; other folders import only this file.
export {
  MAX_NUMBER_MAGNITUDE,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MAX_SCALE,
  MAX_TEXT_ANSWER_LENGTH,
  MAX_TITLE_LENGTH,
  QUESTIONNAIRE_STATES,
  QUESTION_KINDS,
  isLine,
  isQuestionDefinition,
  isQuestionList,
  isShape,
  isTitle,
  nextState,
  type QuestionDefinition,
  type QuestionKind,
  type QuestionOption,
  type QuestionScale,
  type QuestionnaireState,
} from "./definition.ts";
export {
  areValidAnswers,
  isAnswerValue,
  type Answer,
  type AnswerValue,
  type QuestionShape,
} from "./answers.ts";
export {
  QUESTIONNAIRE_EXPORT_MIN_RESPONSES,
  QUESTIONNAIRE_EXPORT_SCHEMA,
  buildQuestionnaireExport,
  type ExportQuestion,
  type ExportResult,
  type ExportSheet,
  type ExportVariable,
  type QuestionnaireExport,
} from "./export.ts";
