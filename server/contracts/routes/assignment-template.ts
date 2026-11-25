import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { WorkTemplateSection } from "./work-template.ts";

// SRV-V17-TEMPLATE-ASSIGN (val 17, predložak rada): an assignment gets the work template of the
// institution (SRV-V17-TEMPLATE-ADMIN) and the student reads its skeleton when starting the
// work. The teacher switches the template on for an assignment: the latest version of the
// template of the assignment's work type is frozen on it, and a version added later changes
// nothing for that assignment. Database: app.set_assignment_template and
// app.read_assignment_template (20261219250000).

const TitleField = Type.Union(
  (["title", "author", "mentor", "course", "date"] as const).map((field) => Type.Literal(field)),
);
const TitlePage = Type.Array(TitleField, { maxItems: 5 });
const Sections = Type.Array(WorkTemplateSection, { maxItems: 30 });

export const AssignmentTemplateInput = closed({
  /** true: pin the latest version of the institution's template; false: remove the pin. */
  useInstitutionTemplate: Type.Boolean(),
});
export type AssignmentTemplateInput = Static<typeof AssignmentTemplateInput>;

export const AssignmentTemplateState = closed({
  useInstitutionTemplate: Type.Boolean(),
  /** The version frozen on the assignment; null while the template is off. */
  version: Type.Union([Type.Integer({ minimum: 1, maximum: 2_147_483_647 }), Type.Null()]),
});
export type AssignmentTemplateState = Static<typeof AssignmentTemplateState>;

export const StudentAssignmentTemplate = closed({
  version: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  titlePage: TitlePage,
  sections: Sections,
  citationStyle: Type.Literal("fpzg"),
});
export type StudentAssignmentTemplate = Static<typeof StudentAssignmentTemplate>;

const params = closed({ assignmentId: Type.String({ minLength: 1 }) });

export const teacherAssignmentTemplatePut = defineRoute({
  id: "teacher.assignment-template.put",
  method: "PUT",
  path: "/api/v1/teacher/assignments/{assignmentId}/template",
  inventory: "app/api/teacher/assignments/[assignmentId]/template/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of the assignment's course switches the institution's work template on or off for the assignment: exactly {useInstitutionTemplate}, at most 1 KiB, sent as application/json. true freezes the latest version of the institution's template for the assignment's work type on the assignment and answers {useInstitutionTemplate: true, version}; when a version is already frozen it stays and is answered (a later version is not taken over); when the institution has no template for the work type yet it is 409 conflict. false removes the pin and answers {useInstitutionTemplate: false, version: null}, also when there was none. A version added to the institution's template later does not change a pin that is kept; switching off and on again takes the latest version, also after students began work. An assignment the caller does not teach, a mentorship assignment, an unknown and a malformed id are the same 404 (C-23); a body outside the contract is 422 invalid_input. Success follows the database commit.",
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: AssignmentTemplateInput,
  },
  responses: [
    {
      status: 200,
      description: "the state of the template on the assignment",
      body: AssignmentTemplateState,
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(404, "not_found"),
    error(409, "conflict"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const studentAssignmentTemplateGet = defineRoute({
  id: "student.assignment-template.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/template",
  inventory: "app/api/student/assignments/[assignmentId]/template/route.ts",
  access: "student_enrolled",
  summary:
    "A student of the assignment's course reads the work template frozen on the assignment: {version, titlePage, sections, citationStyle}, titlePage the fields of the title page in order, sections the skeleton {title, hint}. No query. An assignment that uses no template, an assignment of a course the caller is not a student of, a mentorship assignment, an unknown and a malformed id are the same 404 (C-23).",
  request: { params, query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the frozen template",
      body: StudentAssignmentTemplate,
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const assignmentTemplateRoutes = [
  teacherAssignmentTemplatePut,
  studentAssignmentTemplateGet,
] as const;
