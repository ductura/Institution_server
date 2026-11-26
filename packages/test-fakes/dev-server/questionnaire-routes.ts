import { createHash, randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import { IDS, teachesCourse, type Account, type Course, type State } from "./state.ts";

// SRV-V18-UPITNIK-AUTOR: the questionnaires of a course on the dev fake server. A teacher of the
// course makes a draft, changes it while it is a draft, and moves it open then closed (never
// back); a draft is the only state a change is allowed in (409 conflict otherwise). Anyone who
// does not teach the course (a student, another teacher, an unknown or a foreign id) reads the same
// 404. The one invented questionnaire below is in the starting data. The real rules are
// 20261219380000_questionnaire.sql; the fake keeps no sheet and no person.
type Option = { code: string; label: string };
type Scale = { min: number; max: number };
type Question = {
  id: string;
  order: number;
  kind: "single" | "multiple" | "scale" | "number" | "text";
  text: string;
  options: Option[] | null;
  scale: Scale | null;
};
type Questionnaire = {
  id: string;
  courseId: string;
  title: string;
  state: "draft" | "open" | "closed";
  questions: Question[];
};
type Sent = {
  title: string;
  questions: { kind: Question["kind"]; text: string; options?: Option[]; scale?: Scale }[];
};

/** The invented questionnaire of the starting data, in the draft state. */
export const FAKE_QUESTIONNAIRE_ID = "b1000000-0000-4000-8000-000000000001";

// Keyed by the courses array, which a reset of the state replaces (the State object itself is kept).
const all = new WeakMap<object, Questionnaire[]>();

function questionsOf(sent: Sent["questions"]): Question[] {
  return sent.map((q, i) => ({
    id: randomUUID(),
    order: i + 1,
    kind: q.kind,
    text: q.text,
    options: q.options ?? null,
    scale: q.scale ?? null,
  }));
}

function store(state: State): Questionnaire[] {
  let list = all.get(state.courses);
  if (list === undefined) {
    list = [
      {
        id: FAKE_QUESTIONNAIRE_ID,
        courseId: IDS.course,
        title: "Izmišljeno istraživanje: navike kompostiranja",
        state: "draft",
        questions: questionsOf([
          {
            kind: "single",
            text: "Kompostirate li kod kuće?",
            options: [
              { code: "da", label: "Da" },
              { code: "ne", label: "Ne" },
            ],
          },
          { kind: "text", text: "Što vas sprječava?" },
        ]),
      },
    ];
    all.set(state.courses, list);
  }
  return list;
}

function teachesIt(state: State, account: Account, courseId: string): Course | null {
  const course = state.courses.find((c) => c.id === courseId.toLowerCase());
  return course !== undefined && teachesCourse(course, account) ? course : null;
}

/** The questionnaire a teacher of its course may reach, or why there is none. */
function reach(
  state: State,
  account: Account | null,
  id: string,
): Questionnaire | "unauthorized" | "not_found" {
  if (account === null) return "unauthorized";
  const found = store(state).find((q) => q.id === id.toLowerCase());
  return found !== undefined && teachesIt(state, account, found.courseId) !== null
    ? found
    : "not_found";
}

const FILL_QUESTIONNAIRE_ID = "b0000000-0000-4000-8000-000000000001";
const Q_COMPOST = "b1000000-0000-4000-8000-000000000001";
const Q_IMPORTANCE = "b1000000-0000-4000-8000-000000000002";

type Sheet = { questionId: string; value: unknown }[];
type FillStore = { taken: Set<string>; sheets: Sheet[] };
const FILL_STORES = new WeakMap<State, FillStore>();
function fillStoreOf(state: State): FillStore {
  let store = FILL_STORES.get(state);
  if (store === undefined) {
    // Five invented sheets, the least number of an export (QUESTIONNAIRE_EXPORT_MIN_RESPONSES).
    const seeded: Sheet[] = [
      [
        { questionId: Q_COMPOST, value: "da" },
        { questionId: Q_IMPORTANCE, value: 5 },
      ],
      [
        { questionId: Q_COMPOST, value: "ne" },
        { questionId: Q_IMPORTANCE, value: 2 },
      ],
      [
        { questionId: Q_COMPOST, value: "da" },
        { questionId: Q_IMPORTANCE, value: 4 },
      ],
      [{ questionId: Q_COMPOST, value: "da" }],
      [{ questionId: Q_IMPORTANCE, value: 3 }],
    ];
    store = { taken: new Set(), sheets: seeded };
    FILL_STORES.set(state, store);
  }
  return store;
}

const FILL_FORM = {
  id: FILL_QUESTIONNAIRE_ID,
  courseId: IDS.course,
  title: "Izmišljeno istraživanje: navike kompostiranja",
  questions: [
    {
      id: Q_COMPOST,
      order: 1,
      kind: "single" as const,
      text: "Kompostirate li kod kuće?",
      options: [
        { code: "da", label: "Da" },
        { code: "ne", label: "Ne" },
      ],
      scale: null,
    },
    {
      id: Q_IMPORTANCE,
      order: 2,
      kind: "scale" as const,
      text: "Koliko vam je kompostiranje važno?",
      options: null,
      scale: { min: 1, max: 5 },
    },
  ],
};

function validSheet(answers: Sheet): boolean {
  const seen = new Set<string>();
  return answers.every(({ questionId, value }) => {
    if (seen.has(questionId)) return false;
    seen.add(questionId);
    if (questionId === Q_COMPOST) return value === "da" || value === "ne";
    if (questionId === Q_IMPORTANCE) {
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
    }
    return false;
  });
}

export const QUESTIONNAIRE_HANDLERS: Handlers = {
  "teacher.questionnaires.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (teachesIt(state, account, params.courseId) === null) return { error: "not_found" };
    const mine = store(state).filter((q) => q.courseId === params.courseId.toLowerCase());
    return {
      status: 200,
      body: {
        questionnaires: mine.map((q) => ({
          id: q.id,
          title: q.title,
          state: q.state,
          createdOn: "2026-11-02",
          questionCount: q.questions.length,
          responseCount: 0,
        })),
      },
    };
  },
  "teacher.questionnaires.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    if (teachesIt(state, account, params.courseId) === null) return { error: "not_found" };
    const sent = body as Sent;
    const made: Questionnaire = {
      id: randomUUID(),
      courseId: params.courseId.toLowerCase(),
      title: sent.title,
      state: "draft",
      questions: questionsOf(sent.questions),
    };
    store(state).push(made);
    return { status: 201, body: made };
  },
  "teacher.questionnaire.get": ({ state, account, params }) => {
    const found = reach(state, account, params.id);
    return typeof found === "string" ? { error: found } : { status: 200, body: found };
  },
  "teacher.questionnaire.patch": ({ state, account, params, body }) => {
    const found = reach(state, account, params.id);
    if (typeof found === "string") return { error: found };
    if (found.state !== "draft") return { error: "conflict" };
    const sent = body as Sent;
    found.title = sent.title;
    found.questions = questionsOf(sent.questions);
    return { status: 200, body: found };
  },
  "teacher.questionnaire-state.post": ({ state, account, params, body }) => {
    const found = reach(state, account, params.id);
    if (typeof found === "string") return { error: found };
    const next = (body as { state: "open" | "closed" }).state;
    if (!(
      (found.state === "draft" && next === "open") ||
      (found.state === "open" && next === "closed")
    )) {
      return { error: "conflict" };
    }
    found.state = next;
    return { status: 200, body: { id: found.id, state: next } };
  },
  "student.questionnaires.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const enrolled = state.courses.some(
      (c) => c.id === IDS.course && c.studentIds.includes(account.id),
    );
    const taken = fillStoreOf(state).taken.has(account.id);
    const { id, courseId, title } = FILL_FORM;
    return {
      status: 200,
      body: { questionnaires: enrolled ? [{ id, courseId, title, participated: taken }] : [] },
    };
  },
  "student.questionnaire.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const enrolled = state.courses.some(
      (c) => c.id === IDS.course && c.studentIds.includes(account.id),
    );
    if (!enrolled || params.id.toLowerCase() !== FILL_QUESTIONNAIRE_ID)
      return { error: "not_found" };
    return {
      status: 200,
      body: { ...FILL_FORM, participated: fillStoreOf(state).taken.has(account.id) },
    };
  },
  "student.questionnaire-responses.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const enrolled = state.courses.some(
      (c) => c.id === IDS.course && c.studentIds.includes(account.id),
    );
    if (!enrolled || params.id.toLowerCase() !== FILL_QUESTIONNAIRE_ID)
      return { error: "not_found" };
    if (!validSheet(body.answers)) return { error: "invalid_input" };
    const store = fillStoreOf(state);
    if (store.taken.has(account.id)) return { error: "conflict" };
    store.taken.add(account.id);
    store.sheets.push(body.answers);
    return { status: 204 };
  },
  "teacher.questionnaire-manual-responses.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const course = state.courses.find((c) => c.id === IDS.course);
    if (course === undefined || !teachesCourse(course, account)) return { error: "not_found" };
    if (params.id.toLowerCase() !== FILL_QUESTIONNAIRE_ID) return { error: "not_found" };
    if (!validSheet(body.answers)) return { error: "invalid_input" };
    fillStoreOf(state).sheets.push(body.answers);
    return { status: 204 };
  },
  "teacher.questionnaire-export.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const course = state.courses.find((c) => c.id === IDS.course);
    if (course === undefined || !teachesCourse(course, account)) return { error: "not_found" };
    if (params.id.toLowerCase() !== FILL_QUESTIONNAIRE_ID) return { error: "not_found" };
    const keys = Object.keys(query ?? {});
    const asked = query?.includeText;
    if (keys.length > 0 && (keys.length !== 1 || (asked !== "true" && asked !== "false"))) {
      return { error: "invalid_input" };
    }
    const sheets = fillStoreOf(state).sheets.map((answers, index) => ({
      answers,
      order: createHash("sha256").update(`izmisljeni-list-${index}`).digest("hex"),
    }));
    if (sheets.length < 5) return { error: "conflict" };
    sheets.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    const variables = FILL_FORM.questions.map((q) => ({
      questionId: q.id,
      order: q.order,
      kind: q.kind,
      label: q.text,
      options: q.options ?? [],
    }));
    return {
      status: 200,
      body: {
        schema: "questionnaire-export-v1" as const,
        questionnaireId: FILL_QUESTIONNAIRE_ID,
        variables,
        rows: sheets.map((sheet, index) => ({
          n: index + 1,
          values: Object.fromEntries(
            FILL_FORM.questions.map((q) => [
              q.id,
              (sheet.answers.find((a) => a.questionId === q.id)?.value ?? null) as
                string | number | null,
            ]),
          ),
        })),
        responseCount: sheets.length,
        includesText: false,
      },
    };
  },
};
