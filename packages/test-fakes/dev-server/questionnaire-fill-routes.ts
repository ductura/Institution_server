// SRV-V18-UPITNIK-ISPUNJAVANJE: the questionnaire routes in the dev fake server.
// One invented open questionnaire of the starting course ("Izmišljeno
// istraživanje"). A student of the course reads it and answers once; a teacher
// of the course enters a sheet by hand; anyone else reads 404. As in the real
// server, a sheet is stored without a person: only that the student took part.
import type { Handlers } from "./server.ts";
import { IDS, teachesCourse, type State } from "./state.ts";

const QUESTIONNAIRE_ID = "b0000000-0000-4000-8000-000000000001";
const Q_COMPOST = "b1000000-0000-4000-8000-000000000001";
const Q_IMPORTANCE = "b1000000-0000-4000-8000-000000000002";

type Sheet = { questionId: string; value: unknown }[];
type Store = { taken: Set<string>; sheets: Sheet[] };
const STORES = new WeakMap<State, Store>();
function storeOf(state: State): Store {
  let store = STORES.get(state);
  if (store === undefined) {
    store = { taken: new Set(), sheets: [] };
    STORES.set(state, store);
  }
  return store;
}

const FORM = {
  id: QUESTIONNAIRE_ID,
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

function valid(answers: Sheet): boolean {
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

export const QUESTIONNAIRE_FILL_HANDLERS: Handlers = {
  "student.questionnaires.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const enrolled = state.courses.some(
      (c) => c.id === IDS.course && c.studentIds.includes(account.id),
    );
    const taken = storeOf(state).taken.has(account.id);
    const { id, courseId, title } = FORM;
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
    if (!enrolled || params.id.toLowerCase() !== QUESTIONNAIRE_ID) return { error: "not_found" };
    return {
      status: 200,
      body: { ...FORM, participated: storeOf(state).taken.has(account.id) },
    };
  },
  "student.questionnaire-responses.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const enrolled = state.courses.some(
      (c) => c.id === IDS.course && c.studentIds.includes(account.id),
    );
    if (!enrolled || params.id.toLowerCase() !== QUESTIONNAIRE_ID) return { error: "not_found" };
    if (!valid(body.answers)) return { error: "invalid_input" };
    const store = storeOf(state);
    if (store.taken.has(account.id)) return { error: "conflict" };
    store.taken.add(account.id);
    store.sheets.push(body.answers);
    return { status: 204 };
  },
  "teacher.questionnaire-manual-responses.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const course = state.courses.find((c) => c.id === IDS.course);
    if (course === undefined || !teachesCourse(course, account)) return { error: "not_found" };
    if (params.id.toLowerCase() !== QUESTIONNAIRE_ID) return { error: "not_found" };
    if (!valid(body.answers)) return { error: "invalid_input" };
    storeOf(state).sheets.push(body.answers);
    return { status: 204 };
  },
};
