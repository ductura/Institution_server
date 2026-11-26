import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

// SRV-V18-KODIRANJE-GRADIVO (Ductus#2055, val 18; docs/nalazi/val18-razlika.md in
// the web repo, finding V18-7 and V18-9): the material a student codes, an
// interview or a note typed or pasted, no sound and no automatic transcript. It
// is the student's own and nobody else's: a teacher, a mentor and another
// student read the same 404 as for an unknown id (C-23). No route here calls
// the assistant. Database: app.create_qual_material, app.qual_materials,
// app.qual_material and app.delete_qual_material (20261219390000).

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Title = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,200}(?<!\\s)${END}`,
});
const Kind = Type.Union([Type.Literal("interview"), Type.Literal("note")]);
// The text itself (1..100 000 characters, no control character but a line break
// and a tab) is checked by the domain, which counts characters, not UTF-16 units.
const Text = Type.String({ minLength: 1, maxLength: 200_000 });
const Count = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });
const Day = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });

export const QualMaterialListItem = closed({
  id: Uuid,
  title: Title,
  kind: Kind,
  createdOn: Day,
  charCount: Count,
  segmentCount: Count,
  locked: Type.Boolean(),
});
export const QualMaterial = closed({
  id: Uuid,
  title: Title,
  kind: Kind,
  text: Text,
  createdOn: Day,
  segmentCount: Count,
  locked: Type.Boolean(),
});
const Materials = closed({ materials: Type.Array(QualMaterialListItem, { maxItems: 200 }) });
const NewMaterial = closed({ title: Title, kind: Kind, text: Text });
const params = closed({ id: Uuid });

const LIST_PATH = "/api/v1/student/qual/materials";
const ONE_PATH = "/api/v1/student/qual/materials/{id}";
const LIST_INVENTORY = "app/api/student/qual/materials/route.ts";
const ONE_INVENTORY = "app/api/student/qual/materials/[id]/route.ts";
const READ_ERRORS = [error(401, "unauthorized"), error(503, "unavailable")] as const;
const ONE_ERRORS = [...READ_ERRORS, error(404, "not_found")] as const;

export const studentQualMaterialsGet = defineRoute({
  id: "student.qual-materials.get",
  method: "GET",
  path: LIST_PATH,
  inventory: LIST_INVENTORY,
  access: "student",
  request: {},
  summary:
    "Lists the caller's own materials for qualitative coding, newest first and without the text: title, kind (interview or note), the day it was kept, its length in characters, the number of marked passages and whether it is locked (it has a marked passage). Nobody else's material is ever listed. No route of this family calls the assistant.",
  responses: [{ status: 200, description: "the caller's materials", body: Materials }],
  errors: READ_ERRORS,
});

export const studentQualMaterialsPost = defineRoute({
  id: "student.qual-materials.post",
  method: "POST",
  path: LIST_PATH,
  inventory: LIST_INVENTORY,
  access: "student",
  summary:
    "Keeps a typed or pasted text as the caller's own material: exactly {title, kind, text}. The title is one line of 1..200 characters, kind is interview or note, the text is 1..100 000 characters with something visible and no control character but a line break and a tab (a pasted \\r\\n is kept as \\n). There is no sound and no automatic transcript. A person keeps up to 200 materials (409 conflict beyond that). A text cannot be changed after it is kept: a change is a new material. Answers 201 with the material. A body that is not exactly this is 422.",
  request: { contentType: "application/json", maxBodyBytes: 524_288, body: NewMaterial },
  responses: [{ status: 201, description: "the kept material", body: QualMaterial }],
  errors: [
    ...MUTATION_GUARD,
    ...READ_ERRORS,
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(409, "conflict"),
    error(422, "invalid_input"),
  ],
});

export const studentQualMaterialGet = defineRoute({
  id: "student.qual-material.get",
  method: "GET",
  path: ONE_PATH,
  inventory: ONE_INVENTORY,
  access: "student",
  request: { params },
  summary:
    "Reads one of the caller's own materials with its text, the number of marked passages (segmentCount) and whether it is locked. A material of someone else, an unknown id and a malformed id are the same 404.",
  responses: [{ status: 200, description: "the material", body: QualMaterial }],
  errors: ONE_ERRORS,
});

export const studentQualMaterialDelete = defineRoute({
  id: "student.qual-material.delete",
  method: "DELETE",
  path: ONE_PATH,
  inventory: ONE_INVENTORY,
  access: "student",
  request: { params },
  summary:
    "Deletes one of the caller's own materials together with its marked passages. A material of someone else, an unknown id and a malformed id are the same 404.",
  responses: [{ status: 204, description: "removed" }],
  errors: [...MUTATION_GUARD, ...ONE_ERRORS],
});

export const qualitativeMaterialsRoutes = [
  studentQualMaterialsGet,
  studentQualMaterialsPost,
  studentQualMaterialGet,
  studentQualMaterialDelete,
] as const;
