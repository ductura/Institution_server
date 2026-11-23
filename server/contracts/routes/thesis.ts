// SRV-MENTOR-2 mentorstvo-obrasci-suglasnost (Ductus#2055; the owner's
// decisions of 23. 11. 2026 for NF-6, MK-12 and MK-14): the forms of the
// faculty for a thesis with versions and the state of each form on one work,
// the mentor's consent to the submission, and the stage after the submission
// (to the office, defense scheduled, defended). None of it enters a grade; a
// submission without consent is not blocked (the faculty's switch is off by
// default). Access is decided by the database (app.* RPCs in
// 20261216120000_thesis_forms_consent.sql): the student owner, the mentor of
// the work and the administrator of its institution.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
export const ThesisFormCode = Type.String({ pattern: `^[a-z][a-z0-9-]{1,47}${END}` });
const Instant = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});
const UserId = Type.String({ pattern: `^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}${END}` });
const Version = Type.Integer({ minimum: 1, maximum: 10_000 });
/** One line a person wrote: no control character; the database also asks for NFC. */
const Title = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,200}${END}`,
});
/** A short text a person wrote: newline and tab allowed, no other control character. */
const Comment = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|[^\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,1000}${END}`,
});
export const THESIS_WORK_TYPES = [
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
] as const;
const WorkType = Type.Union(THESIS_WORK_TYPES.map((type) => Type.Literal(type)));
export const THESIS_FORM_STATES = ["not_submitted", "submitted", "accepted"] as const;
const FormState = Type.Union(THESIS_FORM_STATES.map((state) => Type.Literal(state)));
export const THESIS_STAGES = [
  "none",
  "submitted_to_office",
  "defense_scheduled",
  "defended",
] as const;
const Stage = Type.Union(THESIS_STAGES.map((stage) => Type.Literal(stage)));
const Part = <const P extends readonly string[]>(parts: P) =>
  Type.Union([...parts.map((part) => Type.Literal(part)), Type.Null()]);

const ThesisForm = closed({
  code: ThesisFormCode,
  version: Version,
  title: Title,
  workTypes: Type.Array(WorkType, { minItems: 1, maxItems: 4 }),
  active: Type.Boolean(),
  publishedAt: Instant,
});
export const ThesisFormInput = closed({
  code: ThesisFormCode,
  title: Title,
  workTypes: Type.Array(WorkType, { minItems: 1, maxItems: 4 }),
  active: Type.Boolean(),
});
const ThesisSetting = closed({
  mentorConsentRequired: Type.Boolean(),
  changedAt: Type.Union([Instant, Type.Null()]),
});
export const ThesisSettingInput = closed({ mentorConsentRequired: Type.Boolean() });

const WorkThesisForm = closed({
  code: ThesisFormCode,
  version: Version,
  title: Title,
  state: FormState,
  /** The version of the form in force when the state was last set; null while never set. */
  stateFormVersion: Type.Union([Version, Type.Null()]),
  changedAt: Type.Union([Instant, Type.Null()]),
  changedBy: Type.Union([UserId, Type.Null()]),
  changedByPart: Part(["student", "mentor", "faculty"] as const),
});
export const WorkThesisFormInput = closed({ state: FormState });

const ConsentChange = closed({
  given: Type.Boolean(),
  changedBy: UserId,
  changedAt: Instant,
  comment: Type.Union([Comment, Type.Null()]),
});
const MentorConsent = closed({
  state: Type.Union([Type.Literal("none"), Type.Literal("given"), Type.Literal("withdrawn")]),
  changedBy: Type.Union([UserId, Type.Null()]),
  changedAt: Type.Union([Instant, Type.Null()]),
  comment: Type.Union([Comment, Type.Null()]),
  /** The faculty's switch; off by default. Off: a submission without consent is not blocked. */
  requiredForSubmission: Type.Boolean(),
  history: Type.Array(ConsentChange, { maxItems: 1000 }),
});
export const MentorConsentInput = closed({
  given: Type.Boolean(),
  comment: Type.Optional(Comment),
});

const ThesisStage = closed({
  stage: Stage,
  defenseAt: Type.Union([Instant, Type.Null()]),
  changedBy: Type.Union([UserId, Type.Null()]),
  changedAt: Type.Union([Instant, Type.Null()]),
  changedByPart: Part(["mentor", "faculty"] as const),
});
export const ThesisStageInput = closed({
  stage: Stage,
  defenseAt: Type.Optional(Instant),
});

const readErrors = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];
const writeErrors = [
  ...MUTATION_GUARD,
  ...readErrors,
  error(400, "invalid_json"),
  error(403, "forbidden"),
  error(409, "conflict"),
  error(415, "unsupported_media_type"),
  error(422, "invalid_input"),
];
const noStore = ["cache-control"];
const work = closed({ documentId: DocumentId });

export const thesisFormsGet = defineRoute({
  id: "institution.thesis-forms.get",
  method: "GET",
  path: "/api/v1/institution/thesis-forms",
  inventory: "app/api/institution/thesis-forms/route.ts",
  access: "signed_in",
  summary:
    "The forms of the caller's faculty for a thesis (for example the topic application, the statement of originality as the official name of the form, the statement of deposit): the newest version of each code. Retired forms are listed for the administrator only.",
  request: {},
  responses: [
    {
      status: 200,
      description: "The forms in force, by code",
      body: closed({ forms: Type.Array(ThesisForm, { maxItems: 200 }) }),
      headers: noStore,
    },
  ],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

export const thesisFormsPost = defineRoute({
  id: "institution.thesis-forms.post",
  method: "POST",
  path: "/api/v1/institution/thesis-forms",
  inventory: "app/api/institution/thesis-forms/route.ts",
  access: "institution_admin",
  summary:
    "The administrator of the faculty publishes a new version of a form (version 1 for a new code). A version is only ever added; active = false retires the form.",
  request: {
    body: ThesisFormInput,
    contentType: "application/json",
    maxBodyBytes: 4096,
  },
  responses: [
    { status: 201, description: "The published version", body: ThesisForm, headers: noStore },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(503, "unavailable"),
    error(400, "invalid_json"),
    error(403, "forbidden"),
    error(409, "conflict"),
    error(415, "unsupported_media_type"),
    error(422, "invalid_input"),
  ],
});

export const thesisSettingsGet = defineRoute({
  id: "institution.thesis-settings.get",
  method: "GET",
  path: "/api/v1/institution/thesis-settings",
  inventory: "app/api/institution/thesis-settings/route.ts",
  access: "institution_admin",
  summary:
    "The faculty's switch for the mentor's consent to a submission (off by default: no row) and when it was last set.",
  request: {},
  responses: [
    { status: 200, description: "The switch in force", body: ThesisSetting, headers: noStore },
  ],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});

export const thesisSettingsPut = defineRoute({
  id: "institution.thesis-settings.put",
  method: "PUT",
  path: "/api/v1/institution/thesis-settings",
  inventory: "app/api/institution/thesis-settings/route.ts",
  access: "institution_admin",
  summary:
    "The administrator sets the faculty's switch. Setting the value in force writes nothing.",
  request: {
    body: ThesisSettingInput,
    contentType: "application/json",
    maxBodyBytes: 256,
  },
  responses: [
    { status: 200, description: "The switch in force", body: ThesisSetting, headers: noStore },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(503, "unavailable"),
    error(400, "invalid_json"),
    error(403, "forbidden"),
    error(415, "unsupported_media_type"),
    error(422, "invalid_input"),
  ],
});

export const workThesisFormsGet = defineRoute({
  id: "work.thesis-forms.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/thesis-forms",
  inventory: "app/api/works/[documentId]/thesis-forms/route.ts",
  access: "owner_or_mentor",
  summary:
    "The forms in force for the type of this thesis with the state of each (not_submitted, submitted, accepted), for the student owner, the mentor and the administrator of the faculty. A form whose state was set stays listed after it is retired.",
  request: { params: work },
  responses: [
    {
      status: 200,
      description: "The forms of this work",
      body: closed({ forms: Type.Array(WorkThesisForm, { maxItems: 200 }) }),
      headers: noStore,
    },
  ],
  errors: readErrors,
});

export const workThesisFormPut = defineRoute({
  id: "work.thesis-form.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/thesis-forms/{code}",
  inventory: "app/api/works/[documentId]/thesis-forms/[code]/route.ts",
  access: "owner_or_mentor",
  summary:
    "Sets the state of one form of this work. The student owner moves between not_submitted and submitted and cannot touch an accepted form (403 for accepted, 409 on an accepted form); the mentor and the administrator set any state. The state in force writes nothing.",
  request: {
    params: closed({ documentId: DocumentId, code: ThesisFormCode }),
    body: WorkThesisFormInput,
    contentType: "application/json",
    maxBodyBytes: 256,
  },
  responses: [
    { status: 200, description: "The form of this work", body: WorkThesisForm, headers: noStore },
  ],
  errors: writeErrors,
});

export const workMentorConsentGet = defineRoute({
  id: "work.mentor-consent.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/mentor-consent",
  inventory: "app/api/works/[documentId]/mentor-consent/route.ts",
  access: "owner_or_mentor",
  summary:
    "The mentor's consent to the submission of this thesis (none, given, withdrawn), who changed it, when and with what comment, every change in order, and the faculty's switch. The student sees what the mentor sees.",
  request: { params: work },
  responses: [
    { status: 200, description: "The consent in force", body: MentorConsent, headers: noStore },
  ],
  errors: readErrors,
});

export const workMentorConsentPut = defineRoute({
  id: "work.mentor-consent.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/mentor-consent",
  inventory: "app/api/works/[documentId]/mentor-consent/route.ts",
  access: "mentor_teacher",
  summary:
    "The mentor gives (given = true) or withdraws the consent, with an optional comment. Giving it while it is given, or withdrawing it while it is not, is 409. Anyone else is 403.",
  request: {
    params: work,
    body: MentorConsentInput,
    contentType: "application/json",
    maxBodyBytes: 8192,
  },
  responses: [
    { status: 200, description: "The consent in force", body: MentorConsent, headers: noStore },
  ],
  errors: writeErrors,
});

export const workThesisStageGet = defineRoute({
  id: "work.thesis-stage.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/thesis-stage",
  inventory: "app/api/works/[documentId]/thesis-stage/route.ts",
  access: "owner_or_mentor",
  summary:
    "The stage of this thesis after the submission: none, submitted_to_office (predano referadi), defense_scheduled (with its date) or defended.",
  request: { params: work },
  responses: [
    { status: 200, description: "The stage in force", body: ThesisStage, headers: noStore },
  ],
  errors: readErrors,
});

export const workThesisStagePut = defineRoute({
  id: "work.thesis-stage.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/thesis-stage",
  inventory: "app/api/works/[documentId]/thesis-stage/route.ts",
  access: "mentor_teacher",
  summary:
    "The mentor or the administrator of the faculty sets the stage; any stage may follow any other (a correction too). defense_scheduled needs defenseAt; none and submitted_to_office take none. The student owner is 403.",
  request: {
    params: work,
    body: ThesisStageInput,
    contentType: "application/json",
    maxBodyBytes: 512,
  },
  responses: [
    { status: 200, description: "The stage in force", body: ThesisStage, headers: noStore },
  ],
  errors: writeErrors.filter((spec) => spec.status !== 409),
});

export const thesisRoutes = [
  thesisFormsGet,
  thesisFormsPost,
  thesisSettingsGet,
  thesisSettingsPut,
  workThesisFormsGet,
  workThesisFormPut,
  workMentorConsentGet,
  workMentorConsentPut,
  workThesisStageGet,
  workThesisStagePut,
] as const;
