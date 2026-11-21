import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const NoteId = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${END}`,
});
const textOrNull = (max: number) =>
  Type.Union([
    Type.String({
      pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|[^\\u0000\\uD800-\\uDFFF]){1,${max}}${END}`,
    }),
    Type.Null(),
  ]);
const fields = { quote: textOrNull(4000), page: textOrNull(80), note: textOrNull(4000) };
const optionalFields = {
  quote: Type.Optional(fields.quote),
  page: Type.Optional(fields.page),
  note: Type.Optional(fields.note),
};
export const SourceNote = closed({ id: NoteId, ...fields });
export const SourceNotes = closed({ notes: Type.Array(SourceNote, { maxItems: 100 }) });

const params = closed({ id: Type.String({ minLength: 1, maxLength: 256 }), sourceId: NoteId });
const base = {
  path: "/api/v1/works/{id}/sources/{sourceId}/notes",
  inventory: "app/api/works/[id]/sources/[sourceId]/notes/route.ts",
  access: "student_enrolled",
} as const;
const readErrors = [
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;
const invalidInput = error(422, "invalid_input");
const writeErrors = [
  ...MUTATION_GUARD,
  ...readErrors,
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  invalidInput,
] as const;
const json = { params, contentType: "application/json", maxBodyBytes: 65536 } as const;

export const sourceNotebookRoutes = [
  defineRoute({
    ...base,
    id: "work.source-notes.get",
    method: "GET",
    summary:
      "Lists the student's private notes on one source of the document identified by the work id.",
    request: { params },
    responses: [{ status: 200, description: "notes ordered by id", body: SourceNotes }],
    errors: readErrors,
  }),
  defineRoute({
    ...base,
    id: "work.source-notes.post",
    method: "POST",
    summary: "Creates a private note with at least one text field. A source holds up to 100 notes.",
    request: { ...json, body: closed(optionalFields) },
    responses: [{ status: 201, description: "created note", body: SourceNote }],
    errors: writeErrors,
  }),
  defineRoute({
    ...base,
    id: "work.source-notes.patch",
    method: "PATCH",
    summary: "Updates supplied fields. Null clears a field. At least one text field must remain.",
    request: { ...json, body: closed({ noteId: NoteId, ...optionalFields }) },
    responses: [{ status: 200, description: "updated note", body: SourceNote }],
    errors: writeErrors,
  }),
  defineRoute({
    ...base,
    id: "work.source-notes.delete",
    method: "DELETE",
    summary: "Deletes the private note selected by the noteId query parameter.",
    request: { params, query: closed({ noteId: NoteId }) },
    responses: [{ status: 204, description: "removed" }],
    errors: [...MUTATION_GUARD, ...readErrors, invalidInput],
  }),
] as const;
