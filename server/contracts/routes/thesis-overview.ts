// SRV-V16-POPIS-FAKULTET (val16-razlika, Ductus#2058): the administrator of a
// faculty reads the theses of the faculty for the registrar's office: kind of
// work, mentor, student, stage after the submission, date of the defence, state
// of the topic and size of the committee. Read only; nothing here enters a grade
// or an export. The order is the date of the defence (works with none last),
// then the id of the mentorship: no ranking of students. Access is decided by
// the database (app.read_thesis_overview in 20261220140000_thesis_overview.sql):
// the administrator of the faculty only, and only the works of that faculty.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { Name } from "./teacher.ts";

const DocumentId = Type.String({ minLength: 1, maxLength: 256 });
const Instant = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`,
});
export const THESIS_OVERVIEW_STAGES = [
  "none",
  "submitted_to_office",
  "defense_scheduled",
  "defended",
] as const;
export const THESIS_OVERVIEW_WORK_TYPES = [
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
] as const;
export const THESIS_OVERVIEW_TOPIC_STATES = ["none", "proposed", "approved", "returned"] as const;
export const THESIS_OVERVIEW_DEFAULT_LIMIT = 50;
export const THESIS_OVERVIEW_MAX_LIMIT = 200;

const Stage = Type.Union(THESIS_OVERVIEW_STAGES.map((stage) => Type.Literal(stage)));
const Person = Type.Union([closed({ givenName: Name, familyName: Name }), Type.Null()]);

const ThesisOverviewRow = closed({
  /** Null until the student opens the work. */
  documentId: Type.Union([DocumentId, Type.Null()]),
  workType: Type.Union(THESIS_OVERVIEW_WORK_TYPES.map((type) => Type.Literal(type))),
  /** Null when the account holds no name pair; never a stand-in. */
  mentorName: Person,
  studentName: Person,
  stage: Stage,
  defenseAt: Type.Union([Instant, Type.Null()]),
  topicState: Type.Union(THESIS_OVERVIEW_TOPIC_STATES.map((state) => Type.Literal(state))),
  committeeSize: Type.Integer({ minimum: 0, maximum: 5 }),
});

const ThesisOverview = closed({
  works: Type.Array(ThesisOverviewRow, { maxItems: THESIS_OVERVIEW_MAX_LIMIT }),
  /** The opaque key of the last row, or null on the last page. */
  next: Type.Union([Type.String({ pattern: "^[A-Za-z0-9_-]{1,120}$" }), Type.Null()]),
});

export const institutionThesisOverviewGet = defineRoute({
  id: "institution.thesis-overview.get",
  method: "GET",
  path: "/api/v1/institution/thesis-overview",
  inventory: "app/api/institution/thesis-overview/route.ts",
  access: "institution_admin",
  summary:
    "The theses of the administrator's faculty for the registrar's office: kind of work, mentor, student, stage after the submission, date of the defence, state of the topic and number of committee members. Read only, in the order of the date of the defence (works with none last), then the id of the mentorship: no ranking and no grade. Query: stage (one of none, submitted_to_office, defense_scheduled, defended), limit (1 to 200, default 50) and after (the next of the previous page, so no page skips or repeats a work). Any other parameter, a repeated one and a value that is none of these are 422. Another faculty's works are never seen. A teacher, a student and anyone else with a session are 403.",
  request: {
    query: closed({
      stage: Type.Optional(Stage),
      limit: Type.Optional(Type.String({ pattern: "^(?:[1-9]|[1-9]\\d|1\\d\\d|200)$" })),
      after: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,120}$" })),
    }),
  },
  responses: [
    {
      status: 200,
      description: "A page of theses, possibly none",
      body: ThesisOverview,
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const thesisOverviewRoutes = [institutionThesisOverviewGet] as const;
