// SRV-V18-UPITNIK-BAZA (Ductus#2055; val 18): the adapter of the questionnaires.
// Every call is one withActor transaction with the app.* RPCs of migration
// 20261219370000 (questionnaire): the client never writes a table. Who may do
// what is decided by the RPCs from the relation (teacher of the course, student
// enrolled in it), never from a role alone; another's, an unknown, a malformed
// and (for a student) a not open questionnaire all come back as ZD404. The
// sheets carry no person: this adapter reads them without one and the answers
// are grouped by the random id of the sheet only. The routes come with
// SRV-V18-UPITNIK-AUTOR, -ISPUNJAVANJE and -IZVOZ.
import {
  buildQuestionnaireExport,
  isQuestionList,
  isTitle,
  type AnswerValue,
  type ExportQuestion,
  type QuestionDefinition,
  type QuestionKind,
  type QuestionOption,
  type QuestionScale,
  type QuestionnaireState,
} from "../../domain/index.ts";
import type { ActorTransaction, WithActor } from "../index.ts";

export type QuestionnaireQuestion = {
  id: string;
  order: number;
  kind: QuestionKind;
  text: string;
  options: QuestionOption[] | null;
  scale: QuestionScale | null;
};
export type QuestionnaireForm = {
  id: string;
  courseId: string;
  title: string;
  state: QuestionnaireState;
  participated: boolean;
  questions: QuestionnaireQuestion[];
};
export type QuestionnaireListItem = {
  id: string;
  title: string;
  state: QuestionnaireState;
  createdOn: string;
  questionCount: number;
  responseCount: number;
};
export type StudentQuestionnaireItem = {
  id: string;
  courseId: string;
  title: string;
  participated: boolean;
};

type FormRow = {
  questionnaireId: string;
  courseId: string;
  title: string;
  state: QuestionnaireState;
  participated?: boolean;
  questionId: string;
  ord: number;
  kind: QuestionKind;
  body: string;
  options: QuestionOption[] | null;
  scale: QuestionScale | null;
};

const CREATE = "SELECT app.create_questionnaire($1::uuid, $2::text, $3::jsonb) AS id";
const UPDATE = "SELECT app.update_questionnaire($1::uuid, $2::text, $3::jsonb) AS id";
const SET_STATE = "SELECT app.set_questionnaire_state($1::uuid, $2::text) AS state";
const LIST = `SELECT id, title, state, to_char(created_on, 'YYYY-MM-DD') AS "createdOn",
    question_count AS "questionCount", response_count AS "responseCount"
  FROM app.teacher_questionnaires($1::uuid)`;
const TEACHER_FORM = `SELECT questionnaire_id AS "questionnaireId", course_id AS "courseId", title, state,
    question_id AS "questionId", ord, kind, body, options, scale
  FROM app.teacher_questionnaire($1::uuid) ORDER BY ord`;
const STUDENT_LIST = `SELECT id, course_id AS "courseId", title, participated
  FROM app.student_questionnaires()`;
const STUDENT_FORM = `SELECT questionnaire_id AS "questionnaireId", course_id AS "courseId", title,
    'open'::text AS state, participated, question_id AS "questionId", ord, kind, body, options, scale
  FROM app.student_questionnaire($1::uuid) ORDER BY ord`;
const SUBMIT = "SELECT app.submit_questionnaire_response($1::uuid, $2::jsonb)";
const MANUAL = "SELECT app.manual_questionnaire_response($1::uuid, $2::jsonb)";
const ANSWER_ROWS = `SELECT response_id AS "responseId", question_id AS "questionId", value
  FROM app.questionnaire_answer_rows($1::uuid)`;
const SHEET_IDS = `SELECT response_id AS "responseId" FROM app.questionnaire_response_ids($1::uuid)`;

/** The refusal the RPCs give for an input they would not accept, so a route answers 422 before a round trip. */
function invalidInput(): never {
  throw Object.assign(new Error("invalid input"), { code: "ZD422" });
}
function notFound(): never {
  throw Object.assign(new Error("not found"), { code: "ZD404" });
}

function formOf(rows: FormRow[]): QuestionnaireForm {
  const first = rows[0];
  if (!first) return notFound();
  return {
    id: first.questionnaireId,
    courseId: first.courseId,
    title: first.title,
    state: first.state,
    participated: first.participated ?? false,
    questions: rows.map((row) => ({
      id: row.questionId,
      order: row.ord,
      kind: row.kind,
      text: row.body,
      options: row.options,
      scale: row.scale,
    })),
  };
}

async function idOf(tx: ActorTransaction, sql: string, values: unknown[]): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(sql, values);
  if (rows.length !== 1 || !rows[0]) throw new Error("expected one questionnaire id");
  return rows[0].id;
}

export function createQuestionnaireStore(withActor: WithActor) {
  return {
    create: async (
      token: string,
      courseId: string,
      title: string,
      questions: QuestionDefinition[],
    ) => {
      if (!isTitle(title) || !isQuestionList(questions)) return invalidInput();
      return withActor(token, (tx) =>
        idOf(tx, CREATE, [courseId, title, JSON.stringify(questions)]),
      );
    },
    update: async (token: string, id: string, title: string, questions: QuestionDefinition[]) => {
      if (!isTitle(title) || !isQuestionList(questions)) return invalidInput();
      return withActor(token, (tx) => idOf(tx, UPDATE, [id, title, JSON.stringify(questions)]));
    },
    setState: (token: string, id: string, state: "open" | "closed") =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<{ state: QuestionnaireState }>(SET_STATE, [id, state]);
        if (rows.length !== 1 || !rows[0]) throw new Error("expected one state");
        return rows[0].state;
      }),
    listForCourse: (token: string, courseId: string) =>
      withActor(
        token,
        async (tx) => (await tx.query<QuestionnaireListItem>(LIST, [courseId])).rows,
      ),
    read: (token: string, id: string) =>
      withActor(token, async (tx) => formOf((await tx.query<FormRow>(TEACHER_FORM, [id])).rows)),
    listForStudent: (token: string) =>
      withActor(
        token,
        async (tx) => (await tx.query<StudentQuestionnaireItem>(STUDENT_LIST, [])).rows,
      ),
    readForStudent: (token: string, id: string) =>
      withActor(token, async (tx) => formOf((await tx.query<FormRow>(STUDENT_FORM, [id])).rows)),
    /** Once per student; the sheet gets no person (ZD409 already_answered the second time). */
    submit: (token: string, id: string, answers: { questionId: string; value: unknown }[]) =>
      withActor(token, async (tx) => {
        await tx.query(SUBMIT, [id, JSON.stringify(answers)]);
      }),
    /** A sheet a teacher enters by hand; no person, no participation. */
    enterByHand: (token: string, id: string, answers: { questionId: string; value: unknown }[]) =>
      withActor(token, async (tx) => {
        await tx.query(MANUAL, [id, JSON.stringify(answers)]);
      }),
    /**
     * questionnaire-export-v1 of one questionnaire, read in one transaction
     * (the form, the sheets and their answers) so they agree. Below the least
     * number of sheets the answer is `too_few_responses`, not a thin export.
     */
    exportOf: (token: string, id: string, includeText: boolean) =>
      withActor(token, async (tx) => {
        const form = formOf((await tx.query<FormRow>(TEACHER_FORM, [id])).rows);
        const sheetIds = (await tx.query<{ responseId: string }>(SHEET_IDS, [id])).rows;
        const answerRows = (
          await tx.query<{ responseId: string; questionId: string; value: AnswerValue }>(
            ANSWER_ROWS,
            [id],
          )
        ).rows;
        const answers = new Map<string, Map<string, AnswerValue>>(
          sheetIds.map((sheet) => [sheet.responseId, new Map()]),
        );
        for (const row of answerRows) answers.get(row.responseId)?.set(row.questionId, row.value);
        const questions: ExportQuestion[] = form.questions.map((question) => ({
          id: question.id,
          order: question.order,
          text: question.text,
          kind: question.kind,
          options: question.options ?? undefined,
          scale: question.scale ?? undefined,
        }));
        return buildQuestionnaireExport({
          questionnaireId: form.id,
          questions,
          sheets: [...answers].map(([sheetId, values]) => ({ id: sheetId, answers: values })),
          includeText,
        });
      }),
  };
}
