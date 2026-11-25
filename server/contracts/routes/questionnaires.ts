import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-V18-UPITNIK-AUTOR (Ductus#2058, val 18; docs/contracts/questionnaire-v1.md): the teacher of a
// course makes a questionnaire for it, edits it while it is a draft, opens it and closes it. The
// students enrolled in the course answer it (SRV-V18-UPITNIK-ISPUNJAVANJE) and the answers carry no
// person. There is no delete: a closed questionnaire stays. Who may is the database's, from the
// relation (the teacher of the course, C-23); the institution and the author come from the session,
// never from the request. Database: app.create_questionnaire, update_questionnaire,
// set_questionnaire_state, teacher_questionnaires and teacher_questionnaire (20261219380000).

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const Uuid = Type.String({ pattern: UUID });

/** The most bytes of a POST or PATCH body: 40 questions of 500 characters and 20 options each fit. */
export const QUESTIONNAIRE_MAX_BYTES = 262_144;
export const QUESTIONNAIRE_KINDS = ["single", "multiple", "scale", "number", "text"] as const;
export const QUESTIONNAIRE_STATES = ["draft", "open", "closed"] as const;

const Kind = Type.Union(QUESTIONNAIRE_KINDS.map((kind) => Type.Literal(kind)));
const State = Type.Union(QUESTIONNAIRE_STATES.map((state) => Type.Literal(state)));
// Text lengths are counted in UTF-16 units here; the code points, the trimming and the control
// characters are the domain's check and then the database's (422 invalid_input).
const Title = Type.String({ minLength: 1, maxLength: 400 });
const Option = closed({
  /** A short word of a-z, 0-9 and "-"; unique in the question. */
  code: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$" }),
  label: Type.String({ minLength: 1, maxLength: 240 }),
});
const Scale = closed({
  min: Type.Integer({ minimum: 0, maximum: 10 }),
  max: Type.Integer({ minimum: 0, maximum: 10 }),
});

/**
 * A question as the teacher sends it; the order is the array's. The contract generator reads no
 * object nested inside an array item, so options ({code, label}) and scale ({min, max}) are left
 * open here and are checked exactly by the domain (isQuestionList) before the database: a shape
 * outside the rules is 422 invalid_input. The answers (Question) spell the shapes out.
 */
export const QuestionnaireQuestionInput = closed({
  kind: Kind,
  text: Type.String({ minLength: 1, maxLength: 1000 }),
  /** 2 to 20 {code, label} for single and multiple, absent otherwise. */
  options: Type.Optional(Type.Array(Type.Unknown(), { minItems: 2, maxItems: 20 })),
  /** {min, max} for scale only, absent otherwise. */
  scale: Type.Optional(Type.Unknown()),
});
export const QuestionnaireInput = closed({
  title: Title,
  questions: Type.Array(QuestionnaireQuestionInput, { minItems: 1, maxItems: 40 }),
});
export type QuestionnaireInput = Static<typeof QuestionnaireInput>;

const Question = closed({
  id: Uuid,
  order: Type.Integer({ minimum: 1, maximum: 40 }),
  kind: Kind,
  text: Type.String({ minLength: 1, maxLength: 1000 }),
  /** Null unless the kind is single or multiple. */
  options: Type.Union([Type.Array(Option, { minItems: 2, maxItems: 20 }), Type.Null()]),
  /** Null unless the kind is scale. */
  scale: Type.Union([Scale, Type.Null()]),
});
export const Questionnaire = closed({
  id: Uuid,
  courseId: Uuid,
  title: Title,
  state: State,
  questions: Type.Array(Question, { minItems: 1, maxItems: 40 }),
});
export type Questionnaire = Static<typeof Questionnaire>;
const ListItem = closed({
  id: Uuid,
  title: Title,
  state: State,
  /** The day it was made, YYYY-MM-DD. */
  createdOn: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  questionCount: Type.Integer({ minimum: 1, maximum: 40 }),
  /** How many sheets came in, never who sent them. */
  responseCount: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
});
const List = closed({ questionnaires: Type.Array(ListItem) });
const StateAnswer = closed({
  id: Uuid,
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
});

const CourseParams = closed({ courseId: Uuid });
const IdParams = closed({ id: Uuid });
const COURSE_PATH = "/api/v1/teacher/courses/{courseId}/questionnaires";
const COURSE_INVENTORY = "app/api/teacher/courses/[courseId]/questionnaires/route.ts";
const PATH = "/api/v1/teacher/questionnaires/{id}";
const INVENTORY = "app/api/teacher/questionnaires/[id]/route.ts";
const NOT_THERE =
  "A teacher of another course, another institution, a student, an unknown and a malformed id all read the same 404.";
const body = { contentType: "application/json", maxBodyBytes: QUESTIONNAIRE_MAX_BYTES } as const;
const mutationErrors = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
  error(404, "not_found"),
  error(503, "unavailable"),
];

export const teacherQuestionnairesGet = defineRoute({
  id: "teacher.questionnaires.get",
  method: "GET",
  path: COURSE_PATH,
  inventory: COURSE_INVENTORY,
  access: "course_teacher",
  summary: `The questionnaires of a course for its teacher, newest first: {questionnaires: [{id, title, state, createdOn, questionCount, responseCount}]}. responseCount is a number, never a list of people. ${NOT_THERE}`,
  request: { params: CourseParams },
  responses: [{ status: 200, description: "the list", body: List, headers: ["cache-control"] }],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherQuestionnairesPost = defineRoute({
  id: "teacher.questionnaires.post",
  method: "POST",
  path: COURSE_PATH,
  inventory: COURSE_INVENTORY,
  access: "course_teacher",
  summary: `A teacher of the course makes a questionnaire in the draft state: exactly {title, questions}, at most 256 KiB, application/json. title is one line of 1 to 200 characters; questions are 1 to 40, each exactly {kind, text, options?, scale?}: kind is single, multiple, scale, number or text; text is one line of 1 to 500 characters; options (2 to 20 of {code, label}, distinct codes) only for single and multiple; scale ({min, max}, whole numbers 0 to 10, min below max) only for scale. The order is the array's. The answer is the new questionnaire with the ids of its questions. A body outside this is 422 invalid_input. ${NOT_THERE}`,
  request: { params: CourseParams, ...body, body: QuestionnaireInput },
  responses: [
    { status: 201, description: "the new draft", body: Questionnaire, headers: ["cache-control"] },
  ],
  errors: mutationErrors,
});

export const teacherQuestionnaireGet = defineRoute({
  id: "teacher.questionnaire.get",
  method: "GET",
  path: PATH,
  inventory: INVENTORY,
  access: "course_teacher",
  summary: `One questionnaire with its questions in order, for a teacher of its course. ${NOT_THERE}`,
  request: { params: IdParams },
  responses: [
    {
      status: 200,
      description: "the questionnaire",
      body: Questionnaire,
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherQuestionnairePatch = defineRoute({
  id: "teacher.questionnaire.patch",
  method: "PATCH",
  path: PATH,
  inventory: INVENTORY,
  access: "course_teacher",
  summary: `A teacher of the course replaces the title and the questions of a questionnaire that is still a draft (the same {title, questions} as the POST). An open or closed questionnaire is 409 conflict and is not changed. ${NOT_THERE}`,
  request: { params: IdParams, ...body, body: QuestionnaireInput },
  responses: [
    {
      status: 200,
      description: "the changed draft",
      body: Questionnaire,
      headers: ["cache-control"],
    },
  ],
  errors: [...mutationErrors, error(409, "conflict")],
});

export const teacherQuestionnaireStatePost = defineRoute({
  id: "teacher.questionnaire-state.post",
  method: "POST",
  path: `${PATH}/state`,
  inventory: "app/api/teacher/questionnaires/[id]/state/route.ts",
  access: "course_teacher",
  summary: `A teacher of the course moves a questionnaire one step on: exactly {state}, open (from draft) or closed (from open); there is no way back. Any other step is 409 conflict. The answer is {id, state}. ${NOT_THERE}`,
  request: {
    params: IdParams,
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({ state: Type.Union([Type.Literal("open"), Type.Literal("closed")]) }),
  },
  responses: [
    { status: 200, description: "the new state", body: StateAnswer, headers: ["cache-control"] },
  ],
  errors: [...mutationErrors, error(409, "conflict")],
});

export const questionnaireRoutes = [
  teacherQuestionnairesGet,
  teacherQuestionnairesPost,
  teacherQuestionnaireGet,
  teacherQuestionnairePatch,
  teacherQuestionnaireStatePost,
] as const;
