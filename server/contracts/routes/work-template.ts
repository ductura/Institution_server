import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-V17-TEMPLATE-ADMIN (val 17, predložak rada): the work template of an institution, one per
// work type. Like the milestone template (SRV-1521) it is versioned: only an administrator of the
// institution reads it or adds a version, a version is only ever added. A version holds the
// fields of the title page, the skeleton of sections and the citation style. Giving it to an
// assignment and to the student is SRV-V17-TEMPLATE-ASSIGN.

/** The work types of the institution (the same set as the faculty rules). */
export const WORK_TEMPLATE_TYPES = [
  "short_paper",
  "essay",
  "seminar_paper",
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
] as const;
export const WorkTemplateType = Type.Union(WORK_TEMPLATE_TYPES.map((type) => Type.Literal(type)));
export type WorkTemplateType = Static<typeof WorkTemplateType>;

/** The fields a title page may carry, in the order the administrator chose. */
export const WORK_TEMPLATE_TITLE_FIELDS = ["title", "author", "mentor", "course", "date"] as const;
const TitleField = Type.Union(WORK_TEMPLATE_TITLE_FIELDS.map((field) => Type.Literal(field)));

export const WORK_TEMPLATE_MAX_SECTIONS = 30;

/** One section of the skeleton: a title and a hint for the student (empty when none). */
export const WorkTemplateSection = closed({
  title: Type.String({ minLength: 1, maxLength: 120 }),
  hint: Type.String({ minLength: 0, maxLength: 400 }),
});
export type WorkTemplateSection = Static<typeof WorkTemplateSection>;

const TitlePage = Type.Array(TitleField, { maxItems: WORK_TEMPLATE_TITLE_FIELDS.length });
const Sections = Type.Array(WorkTemplateSection, { maxItems: WORK_TEMPLATE_MAX_SECTIONS });
const CitationStyle = Type.Literal("fpzg");

export const WorkTemplateVersion = closed({
  version: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  effectiveFrom: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
  titlePage: TitlePage,
  sections: Sections,
  citationStyle: CitationStyle,
});
export type WorkTemplateVersion = Static<typeof WorkTemplateVersion>;

export const WorkTemplateInput = closed({
  /** The latest version the administrator saw for this work type; 0 when there was none. */
  expectedVersion: Type.Integer({ minimum: 0, maximum: 2_147_483_646 }),
  titlePage: TitlePage,
  sections: Sections,
  citationStyle: CitationStyle,
});
export type WorkTemplateInput = Static<typeof WorkTemplateInput>;

const params = closed({ workType: WorkTemplateType });

export const workTemplateGet = defineRoute({
  id: "institution.work-template.get",
  method: "GET",
  path: "/api/v1/institution/work-templates/{workType}",
  inventory: "app/api/institution/work-templates/[workType]/route.ts",
  access: "institution_admin",
  summary:
    "The work template of one work type of the caller's institution, for an administrator of it: current is the latest version, or null while there is none, and versions is the whole history in ascending order. Each version is {version, effectiveFrom, titlePage, sections, citationStyle}: titlePage the fields of the title page in order (title, author, mentor, course, date), sections the skeleton {title, hint}, citationStyle fpzg. No query. A work type outside the set is 422 invalid_input. A teacher, a student and an account without a confirmed role are 403.",
  request: { params, query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the current version and the history",
      body: closed({
        current: Type.Union([WorkTemplateVersion, Type.Null()]),
        versions: Type.Array(WorkTemplateVersion),
      }),
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

export const workTemplatePut = defineRoute({
  id: "institution.work-template.put",
  method: "PUT",
  path: "/api/v1/institution/work-templates/{workType}",
  inventory: "app/api/institution/work-templates/[workType]/route.ts",
  access: "institution_admin",
  summary:
    "An administrator of the institution replaces the work template of one work type with a new version: exactly {expectedVersion, titlePage, sections, citationStyle}, at most 64 KiB, sent as application/json. expectedVersion is the latest version the administrator saw for this work type (0 when none); another version added in between is 409 conflict. titlePage is at most 5 distinct fields out of title, author, mentor, course, date, in the order of the page. sections is at most 30 objects, each exactly {title, hint}: a title of 1 to 120 characters, a hint of 0 to 400 characters, neither with control characters; citationStyle is fpzg; anything else, including an unknown key and a work type outside the set, is 422 invalid_input. Works and assignments that already exist are not changed. A teacher, a student and an account without a confirmed role are 403. The institution and the author come from the session, never from the body.",
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: 65536,
    body: WorkTemplateInput,
  },
  responses: [
    {
      status: 200,
      description: "the new version",
      body: WorkTemplateVersion,
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const workTemplateRoutes = [workTemplateGet, workTemplatePut] as const;
