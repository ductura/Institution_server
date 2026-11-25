// SRV-V16-POVJERENSTVO-ZAPIS (val16-razlika, Ductus#2058): the committee of a
// thesis as a list kept with the work: a chair and members, named by the
// administrator of the faculty. It is a list and nothing else: it gives no right
// to read the work (that waits for U-1) and it does not touch the work grants.
// Every change replaces the whole list and is only ever added, so the history
// stays. Access is decided by the database (app.* RPCs in
// 20261220130000_thesis_committee.sql): the student owner, the mentor and the
// administrator read; only the administrator writes.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END, Name } from "./teacher.ts";

const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const Instant = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});
/** A lowercase UUID, as PostgreSQL writes uuid. */
const UserId = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
export const THESIS_COMMITTEE_ROLES = ["chair", "member"] as const;
export const THESIS_COMMITTEE_MAX_MEMBERS = 5;
const Role = Type.Union(THESIS_COMMITTEE_ROLES.map((role) => Type.Literal(role)));

const CommitteeMember = closed({
  userId: UserId,
  /** The name pair the institution holds, or null when it holds none. */
  name: Type.Union([closed({ givenName: Name, familyName: Name }), Type.Null()]),
  role: Role,
});
const ThesisCommittee = closed({
  /** The chair first, then by user id; empty while there is no committee. */
  members: Type.Array(CommitteeMember, { maxItems: THESIS_COMMITTEE_MAX_MEMBERS }),
  /** When the list in force was written; null while it never was. */
  changedAt: Type.Union([Instant, Type.Null()]),
  /** Who wrote it: only the faculty does; null while it never was. */
  changedByPart: Type.Union([Type.Literal("faculty"), Type.Null()]),
});
export const ThesisCommitteeInput = closed({
  members: Type.Array(closed({ userId: UserId, role: Role }), {
    maxItems: THESIS_COMMITTEE_MAX_MEMBERS,
  }),
});

const readErrors = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];
const writeErrors = [
  ...MUTATION_GUARD,
  ...readErrors,
  error(400, "invalid_json"),
  error(403, "forbidden"),
  error(415, "unsupported_media_type"),
  error(422, "invalid_input"),
];
const noStore = ["cache-control"];
const work = closed({ documentId: DocumentId });

export const workThesisCommitteeGet = defineRoute({
  id: "work.thesis-committee.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/thesis-committee",
  inventory: "app/api/works/[documentId]/thesis-committee/route.ts",
  access: "owner_or_mentor",
  summary:
    "The committee of this thesis as the administrator named it: the members with their role (chair or member) and when the list was written. It is a list only and gives no access to the work. For the student owner, the mentor and the administrator of the faculty; anyone else, another faculty and a work that is not a mentored thesis read 404.",
  request: { params: work },
  responses: [
    { status: 200, description: "The committee in force", body: ThesisCommittee, headers: noStore },
  ],
  errors: readErrors,
});

export const workThesisCommitteePut = defineRoute({
  id: "work.thesis-committee.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/thesis-committee",
  inventory: "app/api/works/[documentId]/thesis-committee/route.ts",
  access: "institution_admin",
  summary:
    "The administrator of the faculty replaces the whole committee: at most 5 members, at most one chair, all different, each a teacher confirmed in the same faculty and not the student who writes the work (422 otherwise). The same list as the one in force writes nothing. Every change is kept as an event. The student and the mentor are 403.",
  request: {
    params: work,
    body: ThesisCommitteeInput,
    contentType: "application/json",
    maxBodyBytes: 4096,
  },
  responses: [
    { status: 200, description: "The committee in force", body: ThesisCommittee, headers: noStore },
  ],
  errors: writeErrors,
});

export const thesisCommitteeRoutes = [workThesisCommitteeGet, workThesisCommitteePut] as const;
