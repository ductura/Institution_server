// Copy of the route inventory the server takes over: Ductus
// docs/backend/server-route-inventory.md at main d52a92c (DAN-714, 38 route.ts).
// A contract route outside this list, or a file here with neither a contract nor
// a place in PENDING, fails server/contracts/contracts.test.ts.
import type { Method } from "./schema/index.ts";

export const INVENTORY_SOURCE =
  "danielrisavi77-create/Ductus@d52a92c:docs/backend/server-route-inventory.md";

export const INVENTORY: Readonly<Record<string, readonly Method[]>> = {
  "app/api/[...path]/route.ts": ["GET", "POST", "PUT", "PATCH", "DELETE"],
  "app/api/auth/backchannel-logout/route.ts": ["POST"],
  "app/api/auth/callback/route.ts": ["GET"],
  "app/api/auth/login/route.ts": ["GET"],
  "app/api/auth/logout-all/route.ts": ["POST"],
  "app/api/auth/logout/route.ts": ["POST"],
  "app/api/comments/[action]/route.ts": ["POST"],
  "app/api/evidence/commit/route.ts": ["POST"],
  "app/api/evidence/open/route.ts": ["POST"],
  "app/api/evidence/replay/route.ts": ["POST"],
  "app/api/health/route.ts": ["GET"],
  "app/api/institution/assignments/[assignmentId]/acknowledgment/route.ts": ["POST"],
  "app/api/institution/assignments/[assignmentId]/students/[studentId]/work-language/route.ts": [
    "POST",
  ],
  "app/api/institution/assignments/[assignmentId]/versions/route.ts": ["POST"],
  "app/api/institution/assignments/[assignmentId]/work-language/route.ts": ["POST"],
  "app/api/institution/assignments/[assignmentId]/works/[documentId]/work-language/route.ts": [
    "GET",
    "POST",
  ],
  "app/api/institution/courses/[courseId]/assignments/route.ts": ["POST"],
  "app/api/institution/courses/[courseId]/enrollment-code/revocation/route.ts": ["POST"],
  "app/api/institution/courses/[courseId]/enrollment-code/route.ts": ["POST"],
  "app/api/institution/courses/[courseId]/students/[studentId]/removal/route.ts": ["POST"],
  "app/api/institution/courses/[courseId]/students/[studentId]/return-permission/route.ts": [
    "POST",
  ],
  "app/api/institution/courses/route.ts": ["POST"],
  "app/api/institution/enrollments/route.ts": ["POST"],
  "app/api/institution/teachers/[teacherId]/role-confirmation/route.ts": ["POST"],
  "app/api/institution/teachers/[teacherId]/role-revocation/route.ts": ["POST"],
  "app/api/live/[documentId]/route.ts": ["GET", "PUT"],
  "app/api/process-summary/route.ts": ["POST"],
  "app/api/profile/interface-locale/route.ts": ["GET", "POST"],
  "app/api/ready/route.ts": ["GET"],
  "app/api/revision-requests/[action]/route.ts": ["POST"],
  "app/api/status/route.ts": ["GET"],
  "app/api/submission/route.ts": ["POST"],
  "app/api/support/problem-report/route.ts": ["POST"],
  "app/api/teacher/assignments/[assignmentId]/submissions/route.ts": ["GET"],
  "app/api/teacher/courses/route.ts": ["GET"],
  "app/api/teacher/fast-path/route.ts": ["POST"],
  "app/api/teacher/mentorships/[mentorshipId]/route.ts": ["GET"],
  "app/api/teacher/mentorships/route.ts": ["GET"],
};

/**
 * Routes born on the server (DAN-803, Ductus#1836 c.6905207008 t. 0.2): Ductus
 * serves the data from a file that is not a route.ts, so the route has no row
 * in INVENTORY, which stays a copy of the 38 files. The key is the route.ts it
 * would be (pathOf gives its path), `source` the Ductus file of its shape.
 */
const WEBAUTHN_SOURCE = "danielrisavi77-create/Ductus@b36c82b:docs/DECISIONS.md#D-297";

const STUDENT_SUBMISSION_SOURCE = "danielrisavi77-create/Ductus#2028:issuecomment-7009405737";

export const SERVER_SOURCES: Readonly<
  Record<string, { readonly methods: readonly Method[]; readonly source: string }>
> = {
  // SRV-MENTOR-1 (NF-6, MK-7, MK-3, MK-10, MK-5): opening, slot details and moves, agreed tasks.
  "app/api/mentorships/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116183714",
  },
  "app/api/student/mentorships/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116183714",
  },
  "app/api/notifications/mentorship-opened/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116183714",
  },
  "app/api/works/[documentId]/consultation-slot-details/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116183714",
  },
  "app/api/works/[documentId]/consultation-slot-requests/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116183714",
  },
  "app/api/works/[documentId]/consultation-slots/[slotId]/close/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116183714",
  },
  "app/api/works/[documentId]/consultation-tasks/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116183714",
  },
  "app/api/works/[documentId]/consultation-records/[recordId]/tasks/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116183714",
  },
  "app/api/works/[documentId]/consultation-tasks/[taskId]/mark/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116183714",
  },
  "app/api/problem-reports/route.ts": {
    methods: ["POST", "GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064518328",
  },
  "app/api/teacher/assignments/[assignmentId]/grade/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064534090",
  },
  "app/api/courses/[id]/team/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063989130",
  },
  // SRV-V19-GRUPA-UGOVOR (Ductus#2055, val 19): work teams on an assignment; Ductus has no such route.
  "app/api/institution/assignments/[assignmentId]/team-setting/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7147669559",
  },
  "app/api/student/assignments/[assignmentId]/team/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7147669559",
  },
  "app/api/student/assignments/[assignmentId]/team/contribution/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7147669559",
  },
  "app/api/teacher/assignments/[assignmentId]/teams/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7147669559",
  },
  "app/api/teacher/assignments/[assignmentId]/teams/[teamId]/members/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7147669559",
  },
  "app/api/teacher/assignments/[assignmentId]/teams/[teamId]/contribution/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7147669559",
  },
  "app/api/courses/[id]/team/view/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7076689558",
  },
  // DEMO-POP-4-SRV (Ductus#2058): candidates for the assistant roster; Ductus has no such route.
  "app/api/courses/[id]/team/candidates/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7179269005",
  },
  "app/api/courses/[id]/groups/[groupId]/members/route.ts": {
    methods: ["PUT"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063989130",
  },
  "app/api/mentorships/[id]/notes/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064009405",
  },
  "app/api/mentorships/[id]/key-dates/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064828009",
  },
  // SRV-1412 (Plan M2.1 to M2.3): the student starts the own work and reads the own works.
  "app/api/assignments/[assignmentId]/start/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7066995409",
  },
  "app/api/student/works/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7066995409",
  },
  // SRV-1414 (Plan M2, D-204): the student's side of mentorship.
  "app/api/student/mentorship-requests/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7066242474",
  },
  "app/api/student/mentor-candidates/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7066242474",
  },
  // SRV-1407 (Plan M2, D-204): the moves of one mentorship request.
  "app/api/mentorship-requests/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063357354",
  },
  "app/api/mentorship-requests/[requestId]/approve/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063357354",
  },
  "app/api/mentorship-requests/[requestId]/decline/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063357354",
  },
  "app/api/mentorship-requests/[requestId]/withdraw/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063357354",
  },
  "app/api/works/[id]/sources/[sourceId]/notes/route.ts": {
    methods: ["GET", "POST", "PATCH", "DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063426191",
  },
  "app/api/notifications/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063562265",
  },
  // SRV-1607 (Ductus#2052): notifications of work returned for revision, a list of its own.
  "app/api/notifications/returned-for-revision/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7082147227",
  },
  "app/api/notifications/[id]/read/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063562265",
  },
  "app/api/assignments/[assignmentId]/works/[documentId]/export/pdf/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063084126",
  },
  "app/api/student/assistant/requests/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7056107180",
  },
  "app/api/student/assistant/conversations/[conversationId]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7056107180",
  },
  "app/api/works/[documentId]/consultation-slots/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7044073682",
  },
  "app/api/works/[documentId]/consultation-slots/[slotId]/route.ts": {
    methods: ["PATCH"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7044073682",
  },
  "app/api/works/[documentId]/interview/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/interview/questions/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/interview/questions/[questionId]/route.ts": {
    methods: ["DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/interview/invite/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/interview/appointment/route.ts": {
    methods: ["PUT"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/interview/held/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/interview/explanations/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/interview/notes/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7088640732",
  },
  "app/api/works/[documentId]/interview/pdf/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/process-summary/details/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7041269693",
  },
  "app/api/student/assignments/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus@078c780:src/components/student/my-assignments-read.ts",
  },
  // DAN-806 (c.6906291102): Ductus has no settings route; the shape is D-298.
  "app/api/settings/catalogue/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus@078c780:docs/DECISIONS.md#D-298",
  },
  // DAN-846: Ductus has no client context route; the shape is D-300.
  "app/api/client-context/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus@333e163:docs/DECISIONS.md#D-300",
  },
  // DAN-840: Ductus has no WebAuthn route; the network engineer signs in with
  // AAI@EduHr and FIDO2 (D-297), the second factor of an AAI@EduHr session.
  "app/api/auth/webauthn/challenge/route.ts": { methods: ["POST"], source: WEBAUTHN_SOURCE },
  "app/api/auth/webauthn/registration/route.ts": { methods: ["POST"], source: WEBAUTHN_SOURCE },
  "app/api/auth/webauthn/assertion/route.ts": { methods: ["POST"], source: WEBAUTHN_SOURCE },
  // DAN-903-1: Ductus reads it in its teacher page, not in a route.
  "app/api/teacher/assignment-submissions/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus@4eaa776:src/server/evidence/assignment-submissions.ts",
  },
  "app/api/teacher/assignments/[assignmentId]/submissions/[studentId]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063450904",
  },
  // DAN-903-2: Ductus reads it in its teacher pages, not in a route.
  "app/api/teacher/access/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus@4eaa776:src/components/teacher/teacher-access.ts",
  },
  // DAN-904: Ductus reads it in its page app/rad/[assignmentId]/dnevnik-pristupa;
  // the route names the work by documentId, as the port server/database/my-access-log.ts.
  "app/api/student/works/[documentId]/access-log/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus@4eaa776:src/server/privacy/my-access-log-pages.ts",
  },
  // DAN-989-1: Ductus has no work state per assignment; the set of
  // assignments is that of my-assignments-read.ts.
  "app/api/student/assignment-work/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus@9c45857:src/components/student/my-assignments-read.ts",
  },
  // INT-31 (Ductus#2055): Ductus has no mentored-work list; the set is that
  // of app.lock_student_assignment's mentorship branch.
  "app/api/student/mentored-assignments/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7140530208",
  },
  // SRV-NF1-PREDANO (Ductus#2055 c.7145546227, NF-1 P-6): when each own submission was
  // confirmed, for the same set of assignments; Ductus has no such route.
  "app/api/student/assignment-submissions/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7145546227",
  },
  // DAN-931: Ductus has no download route; the place is D-306 t. 1.
  "app/api/downloads/manifest/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus@9c45857:docs/DECISIONS.md#D-306",
  },
  "app/api/student/assignments/[assignmentId]/submission/pdf/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7041269693",
  },
  "app/api/teacher/assignments/[assignmentId]/submissions/[studentId]/pdf/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7041269693",
  },
  // Ductus#2028 c.6993786629 §3.3: Ductus reads the account in its pages; the
  // front of the institution asks for it after the AAI@EduHr login.
  "app/api/me/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-6993786629",
  },
  // SRV-1403 (M1.3, DAN-304): the caller's own staff affiliation; Ductus has no such route.
  "app/api/me/staff-affiliation/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7062876936",
  },
  // SRV-02 (Ductus#2028 c.7008147932, A-2): the outcomes of enrolment told apart.
  "app/api/student/enrollments/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7008147932",
  },
  // SRV-02 (Ductus#2028 c.7008147932, PO-7): Ductus has no record of reading a notice.
  "app/api/student/assignments/[assignmentId]/notice-read/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7008147932",
  },
  "app/api/student/assignments/[assignmentId]/submission/route.ts": {
    methods: ["GET"],
    source: STUDENT_SUBMISSION_SOURCE,
  },
  "app/api/student/assignments/[assignmentId]/requirements/route.ts": {
    methods: ["GET"],
    source: STUDENT_SUBMISSION_SOURCE,
  },
  "app/api/student/assignments/[assignmentId]/submission-notes/route.ts": {
    methods: ["GET"],
    source: STUDENT_SUBMISSION_SOURCE,
  },
  "app/api/student/submission-notes/route.ts": {
    methods: ["POST"],
    source: STUDENT_SUBMISSION_SOURCE,
  },
  // SRV-7C (Ductus#2028, wave 7): the work's source list; Ductus has no such routes.
  "app/api/student/assignments/[assignmentId]/sources/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7037456743",
  },
  "app/api/student/assignments/[assignmentId]/sources/[sourceId]/route.ts": {
    methods: ["PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7037456743",
  },
  // SRV-1102 (Ductus#2051, Val 11, E§3.4 proofs, B-8): excerpts attached to a source; Ductus has no such routes.
  "app/api/student/assignments/[assignmentId]/sources/[sourceId]/proofs/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7047672399",
  },
  "app/api/student/assignments/[assignmentId]/sources/[sourceId]/proofs/[proofId]/image/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7047672399",
  },
  // SRV-1101 (Val 11, C-12): the text checks and Lekta profile of the institution; Ductus has no such route.
  "app/api/student/assignments/[assignmentId]/text-check-config/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7043116568",
  },
  // SRV-2003 (Ductus#2028 c.7024185874): the teacher's read of one work by its document id; Ductus has no such route.
  "app/api/teacher/works/[documentId]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7024185874",
  },
  // SRV-1605 (Ductus#2052 c.7081590679, WEB-2133): the guidance of a teacher on sources (recommendations, required literature, proof requests, the literature mark, the proofs); Ductus has no such route.
  "app/api/teacher/works/[documentId]/source-guidance/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  "app/api/teacher/works/[documentId]/source-recommendations/[sourceId]/route.ts": {
    methods: ["PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  "app/api/teacher/works/[documentId]/sources/[sourceId]/proof-request/route.ts": {
    methods: ["PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  "app/api/teacher/works/[documentId]/literature-seen/route.ts": {
    methods: ["PUT"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  "app/api/teacher/works/[documentId]/sources/[sourceId]/proofs/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  "app/api/teacher/works/[documentId]/sources/[sourceId]/proofs/[proofId]/image/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  "app/api/teacher/courses/[courseId]/required-literature/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  "app/api/teacher/courses/[courseId]/required-literature/[sourceId]/route.ts": {
    methods: ["PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  "app/api/student/courses/[courseId]/required-literature/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  "app/api/student/assignments/[assignmentId]/source-proof-requests/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081590679",
  },
  // SRV-1230 (Ductus#2052 c.7079306579, P-1, rule 13): the match of a segment with the answers of the assistant; Ductus has no such route.
  "app/api/works/[documentId]/assistant-match/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  // PIL-P1-PODUDARANJE-OBJASNJENJE-SRV (Ductus#2052 c.7092390512, P-1, rule 13): the student's explanation of a finding; Ductus has no such route.
  // SRV-V19-DNEVNIK-UGOVOR (Ductus#2055 c.7146962118, val 19): the practice journal beside a mentorship; Ductus has no such route.
  "app/api/practice/placements/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7146962118",
  },
  "app/api/practice/placements/[placementId]/entries/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7146962118",
  },
  "app/api/practice/placements/[placementId]/signoffs/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7146962118",
  },
  // SRV-V18-KODIRANJE-SIFRARNIK (Ductus#2058 c.7173077456, val 18): the codebook of a student's own qualitative coding; Ductus has no such route.
  "app/api/student/qual/codes/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173077456",
  },
  "app/api/student/qual/codes/[id]/route.ts": {
    methods: ["PATCH", "DELETE"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173077456",
  },
  // SRV-V19-RECENZIJA-UGOVOR (Ductus#2055 c.7149250861, val 19): anonymous peer review among students; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/peer-review/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7149250861",
  },
  "app/api/teacher/assignments/[assignmentId]/peer-review/allocations/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7149250861",
  },
  "app/api/teacher/assignments/[assignmentId]/peer-review/overview/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7149250861",
  },
  "app/api/teacher/assignments/[assignmentId]/peer-review/reviews/[reviewId]/withdrawal/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7149250861",
  },
  "app/api/student/assignments/[assignmentId]/peer-review/tasks/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7149250861",
  },
  "app/api/student/peer-review/tasks/[taskId]/work/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7149250861",
  },
  "app/api/student/peer-review/tasks/[taskId]/review/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7149250861",
  },
  "app/api/student/assignments/[assignmentId]/peer-review/received/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7149250861",
  },
  // SRV-V15-UGOVOR (Ductus#2055 c.7163756092, val 15): a small calculation in the request, no stored dataset; Ductus has no such route.
  "app/api/analysis/catalogue/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7163756092",
  },
  "app/api/analysis/runs/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7163756092",
  },
  // SRV-MENTOR-2 (NF-6, MK-12 and MK-14): thesis forms, mentor consent, stage after submission.
  "app/api/institution/thesis-forms/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116184562",
  },
  "app/api/institution/thesis-settings/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116184562",
  },
  "app/api/works/[documentId]/thesis-forms/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116184562",
  },
  "app/api/works/[documentId]/thesis-forms/[code]/route.ts": {
    methods: ["PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116184562",
  },
  "app/api/works/[documentId]/mentor-consent/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116184562",
  },
  "app/api/works/[documentId]/thesis-stage/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116184562",
  },
  // SRV-V16-TEMA-PRIJEDLOG (val16-razlika): the topic of a thesis, proposed by the student and decided by the mentor.
  "app/api/works/[documentId]/thesis-topic/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173074345",
  },
  "app/api/works/[documentId]/thesis-topic/decision/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173074345",
  },
  // SRV-V16-POVJERENSTVO-ZAPIS (val16-razlika): the committee of a thesis as a list kept with the work.
  "app/api/works/[documentId]/thesis-committee/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173852373",
  },
  // SRV-V16-POPIS-FAKULTET (val16-razlika): the theses of the faculty for the registrar's office, read only.
  "app/api/institution/thesis-overview/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7177488643",
  },
  "app/api/works/[documentId]/assistant-match/explanation/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7092390512",
  },
  // SRV-1111 (Ductus#2052 c.7079306579, P-1 rule 12): the thresholds of a faculty per kind of origin and the comparison of a work; Ductus has no such route.
  "app/api/institution/origin-thresholds/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/institution/origin-thresholds/[origin]/route.ts": {
    methods: ["PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/origin-thresholds/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  // PIL-P1-RITAM-SRV (Ductus#2052 c.7086920979, P-1 rule 4): the rhythm of typing and the teacher's switch; Ductus has no such route.
  "app/api/works/[documentId]/input-rhythm/route.ts": {
    methods: ["GET", "POST", "DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7086920979",
  },
  "app/api/works/[documentId]/input-rhythm/setting/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7086920979",
  },
  "app/api/teacher/assignments/[assignmentId]/input-rhythm/route.ts": {
    methods: ["GET", "PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7086920979",
  },
  // SRV-ASIST-PREKIDAC (Ductus#2055 c.7162920212): the assistant switch per course and
  // the availability of the assistant for a student of an assignment.
  "app/api/teacher/courses/[courseId]/assistant/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7162920212",
  },
  "app/api/student/assignments/[assignmentId]/assistant/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7162920212",
  },
  // SRV-ASIST-BROJAC (Ductus#2055 c.7162920212 T2): the daily request count of a student.
  "app/api/student/assignments/[assignmentId]/assistant/requests/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7162920212",
  },
  // SRV-V18-KODIRANJE-GRADIVO (Ductus#2055, val 18): the student's material for qualitative coding.
  "app/api/student/qual/materials/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173076650",
  },
  "app/api/student/qual/materials/[id]/route.ts": {
    methods: ["GET", "DELETE"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173076650",
  },
  // SRV-ASIST-LIMIT-ADMIN (Ductus#2055 T2, approved 25. 11.): the administrator's request limit.
  "app/api/institution/assistant/request-limit/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7162920212",
  },
  // SRV-V18-UPITNIK-ISPUNJAVANJE (Ductus#2058; val 18, V18-1): a student answers an open questionnaire once; a teacher enters a sheet by hand.
  "app/api/student/questionnaires/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173075839",
  },
  "app/api/student/questionnaires/[id]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173075839",
  },
  "app/api/student/questionnaires/[id]/responses/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173075839",
  },
  "app/api/teacher/questionnaires/[id]/responses/manual/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173075839",
  },
  // SRV-V18-UPITNIK-IZVOZ (Ductus#2058; val 18, V18-4): the author reads the answers as questionnaire-export-v1.
  "app/api/teacher/questionnaires/[id]/export/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173573927",
  },
  // PIL-P1-RITAM-PREDMET-SRV (Ductus#2052 c.7091841764): the switch of the rhythm per course; Ductus has no such route.
  "app/api/teacher/courses/[courseId]/input-rhythm/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7091841764",
  },
  // PIL-K-IZJAVA-SRV (Ductus#2052 c.7090494988, owner decision of 23. 11. 2026): the teacher's
  // required declaration and the second major of the submission (409 declaration_required).
  "app/api/teacher/assignments/[assignmentId]/declaration-required/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7090494988",
  },
  // SRV-NF4-KASNA-POLJE (Ductus#2055, orchestrator decision A): the teacher sets whether a
  // submission after the deadline is allowed, a student of the course reads it.
  "app/api/institution/assignments/[assignmentId]/late-submission/route.ts": {
    methods: ["PUT"],
    source: "danielrisavi77-create/Ductus#2055",
  },
  "app/api/student/assignments/[assignmentId]/late-submission/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055",
  },
  // SRV-IZJAVA-PITANJE (Ductus#2055 c.7114546002, owner decision of 23. 11. 2026): the
  // teacher's optional question with the declaration.
  "app/api/teacher/assignments/[assignmentId]/declaration-question/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7114546002",
  },
  "app/api/submission/v2/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7090494988",
  },
  // SRV-0910 (Ductus#2052 c.7079306579, P-1): the composition of a work by the kind of origin; Ductus has no such route.
  "app/api/works/[documentId]/origin-composition/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  // SRV-KARTA-RASPON (Ductus#2055 c.7140935386, NF-5 PG-2): the ranges of origin of a revision of a work; Ductus has no such route.
  // SRV-KARTA-RASPON-RUTA (Ductus#2055, variant A): POST, the owner records the ranges of a revision once.
  "app/api/works/[documentId]/origin-segments/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7140935386",
  },
  // SRV-1107 (Ductus#2051 c.7048423903, wave 11, B-9): the teacher's private working criteria; Ductus has no such route.
  "app/api/teacher/works/[documentId]/working-criteria/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7048423903",
  },
  "app/api/teacher/works/[documentId]/working-criteria/[criterionId]/route.ts": {
    methods: ["PUT"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7048423903",
  },
  // SRV-1304 (plan M10.2, M10.7): the administrator's retention dry run; no Ductus route.
  "app/api/institution/retention/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7069035579",
  },
  // SRV-ADMIN-1 (NF-7 OA-7, OA-3; owner decision 23. 11. 2026.): the state of a
  // routed problem report and the action log; no Ductus route.
  "app/api/problem-reports/[reference]/status/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116133441",
  },
  "app/api/institution/admin-actions/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116133441",
  },
  // SRV-1906 (plan P-D6): the operator's pilot numbers; no Ductus route.
  "app/api/ops/pilot-metrics/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064713035",
  },
  // SRV-1406: the versioned rules of the institution; no Ductus route.
  "app/api/institution/config/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7066464126",
  },
  "app/api/institution/config/versions/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7066464126",
  },
  // SRV-1706 (plan M10.4): the student's access log in days; no Ductus route.
  "app/api/works/[documentId]/access/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7069036189",
  },
  "app/api/courses/[id]/aggregate/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063562264",
  },
  // SRV-03 (Ductus#2028 c.7008147932, wave 4): Ductus has no administrator's
  // course and no group routes; the shapes are the plan's (A-7, C-7).
  // LOK-SRV-2: the administrator's reads of the courses (GET here), the
  // academic years and the teacher roles; Ductus read them in its pages
  // (DAN-313, DAN-581), the contracts are on #1091.
  "app/api/institution/admin/courses/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7008147932",
  },
  "app/api/institution/admin/academic-years/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#1091:issuecomment-6692590206",
  },
  "app/api/institution/teachers/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#1091:issuecomment-6674850230",
  },
  "app/api/institution/courses/[courseId]/groups/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7008147932",
  },
  "app/api/institution/groups/[groupId]/teachers/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7008147932",
  },
  // UGOVORI-API (Ductus#2028 c.7019543739, SRV-NG c.7019668458): Ductus reads
  // the notice in its page (readNotice), not in a route.
  "app/api/student/assignments/[assignmentId]/notice/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7019668458",
  },
  // SRV-ASIST-CITANJE (Ductus#2055 c.7142266537): Ductus has no list of the
  // student's assistant conversations.
  "app/api/student/assignments/[assignmentId]/assistant-conversations/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7142266537",
  },
  // UGOVORI-API (Ductus#2028 c.7020597404, SRV-AV): Ductus reads the current
  // version in its teacher page, not in a route.
  "app/api/institution/assignments/[assignmentId]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7020597404",
  },
  // UGOVORI-API (Ductus#2028 c.7019844365): Ductus has no read of the code's state.
  "app/api/institution/courses/[courseId]/enrollment-code/state/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7019844365",
  },
  "app/api/settings/values/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus@078c780:docs/DECISIONS.md#D-298",
  },
  "app/api/sources/lookup/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7036755565",
  },
  // SRV-9B (✓ C-6): Ductus has no public check of a receipt.
  "app/api/public/verification/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7041664094",
  },
  // SRV-9A (Ductus#2028 c.7041078855, wave 9): the versions of a work; Ductus has no such route.
  "app/api/works/[documentId]/versions/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7041078855",
  },
  // INT-21 C (red.json INT-21; database ductura/Institution_server#645): the owner records a restore; Ductus has no such route.
  "app/api/works/[documentId]/restores/route.ts": {
    methods: ["POST"],
    source: "ductura/Institution_server#645",
  },
  // SRV-1310 (plan M8.4, Ductus#2052 c.7063253708): the DOCX of a saved version of a work; Ductus has no such route.
  "app/api/works/[documentId]/export/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7063253708",
  },
  // SRV-V14-SHEET-CSV (val 14, docs/nalazi/val14-razlika.md decision 6): the CSV of one sheet of a spreadsheet work; Ductus has no such route.
  "app/api/works/[documentId]/export/csv/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173654054",
  },
  // SRV-V14-SHEET-XLSX (val 14 decision 6, Ductus#2058 c.7173654855): the .xlsx of a saved version of a spreadsheet work; Ductus has no such route.
  "app/api/works/[documentId]/export/xlsx/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173654855",
  },
  // SRV-1312 (plan M7.10, Ductus#2052 c.7069253604): the portable record of a submission; Ductus has no such route.
  "app/api/student/submissions/[submissionId]/portable-record/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7069253604",
  },
  // SRV-1807 (plan M8.6, Ductus#2052 c.7069763588): the 24 hour link to the export package and the confirmation for the registrar; Ductus has no such route.
  "app/api/student/submissions/[submissionId]/package-link/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7069763588",
  },
  "app/api/student/submissions/[submissionId]/package/[kind]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7069763588",
  },
  // SRV-1902 (plan P-D2, Ductus#2052 c.7069957833): the link to the ZIP of all submissions of an assignment and its download; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/submissions-bulk-link/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7069957833",
  },
  "app/api/teacher/assignments/[assignmentId]/submissions-bulk/[format]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7069957833",
  },
  "app/api/works/[documentId]/versions/[revision]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7062949322",
  },
  // SRV-1106 (Val 11, Ductus#2051 c.7048423523; E§3.5 mentor2, PO-22): the messages of a work; Ductus has no such route.
  "app/api/works/[documentId]/messages/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7048423523",
  },
  // SRV-MENTOR-3 (Ductus#2055 c.7116185492; NF-6 MK-8, MK-9, MK-11, NF-5 PG-9): note to self, reading place, seen marks and the mentor's overview; Ductus has no such routes.
  "app/api/works/[documentId]/self-note/route.ts": {
    methods: ["GET", "PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116185492",
  },
  // SRV-NF6-SIFRA (Ductus#2055 c.7120208960; owner decision B2 of 24 Nov 2026): the sealed note to self and the wrapped note key; Ductus has no such routes.
  "app/api/works/[documentId]/sealed-self-note/route.ts": {
    methods: ["GET", "PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7120208960",
  },
  "app/api/me/self-note-key/route.ts": {
    methods: ["GET", "PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7120208960",
  },
  // SRV-NF6-SIFRA-2 (Ductus#2055 c.7122106659; review of SRV #676, S2): starting over under the key named; Ductus has no such route.
  "app/api/me/self-note-key/[keyId]/route.ts": {
    methods: ["DELETE"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7122106659",
  },
  "app/api/works/[documentId]/reading-place/route.ts": {
    methods: ["PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116185492",
  },
  "app/api/works/[documentId]/seen/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116185492",
  },
  "app/api/works/[documentId]/seen-by-student/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116185492",
  },
  "app/api/teacher/mentorship-overview/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116185492",
  },
  // SRV-1703 (M6.7, Ductus#2052 c.7060877557; D-51, N-03, N-05): delayed comments, the comment bank and the changes since the last review; Ductus has no such routes.
  "app/api/works/[documentId]/comment-drafts/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060877557",
  },
  "app/api/comment-drafts/[commentId]/route.ts": {
    methods: ["DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060877557",
  },
  "app/api/works/[documentId]/comments/publish/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060877557",
  },
  "app/api/works/[documentId]/comments/publish-selected/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060877557",
  },
  "app/api/teacher/comment-bank/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060877557",
  },
  "app/api/teacher/comment-bank/[entryId]/route.ts": {
    methods: ["PUT", "DELETE"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060877557",
  },
  "app/api/works/[documentId]/review/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060877557",
  },
  "app/api/works/[documentId]/changes-since-review/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060877557",
  },
  // SRV-2004 (Faza 3; Ductus#2052 c.7074315040): the comparison of two revisions of a work; Ductus has no such route.
  "app/api/works/[documentId]/compare/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7074315040",
  },
  // SRV-1702 (M6.4, DAN-420; D-21, D-34, D-244; Ductus#2052 c.7060411190): the direct-edit setting of a work; Ductus has no such route.
  "app/api/works/[documentId]/direct-edit/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060411190",
  },
  // SRV-1803 (M8.2, DAN-396; D-282, D-290 to D-292; Ductus#2052 c.7062877544): a DOCX import and its confirmation; Ductus has no such route.
  "app/api/works/[documentId]/imports/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7062877544",
  },
  "app/api/works/[documentId]/imports/[importId]/confirm/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7062877544",
  },
  "app/api/student/assignments/[assignmentId]/attachments/route.ts": {
    methods: ["POST"],
    source: "ductura/Institution_server#471",
  },
  "app/api/work-attachments/[attachmentId]/route.ts": {
    methods: ["GET"],
    source: "ductura/Institution_server#471",
  },
  // SRV-1105 (Ductus#2051, wave 11): the shared record of a consultation and its additions; Ductus has no such route.
  "app/api/works/[documentId]/milestones/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7044073172",
  },
  "app/api/works/[documentId]/milestones/[milestoneId]/route.ts": {
    methods: ["PATCH", "DELETE"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7044073172",
  },
  // SRV-1520 (Ductus#2052, N-15 etape): the state of a milestone of one work; Ductus has no such route.
  "app/api/works/[documentId]/milestone-states/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/milestones/[milestoneId]/details/route.ts": {
    methods: ["PATCH"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/milestones/[milestoneId]/submit/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/milestones/[milestoneId]/request-revision/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/milestones/[milestoneId]/approve/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  // SRV-V17-RUBRIC-DEF (Ductus#2055, val 17): the rubric of an assignment; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/rubric/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7146991992",
  },
  "app/api/student/assignments/[assignmentId]/rubric/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7146991992",
  },
  // SRV-V21-KOD-TESTOVI-RUTA (Ductus#2058, val 21): the code tests of an assignment; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/code-tests/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7168911312",
  },
  "app/api/student/assignments/[assignmentId]/code-tests/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7168911312",
  },
  // SRV-V18-UPITNIK-AUTOR (Ductus#2058, val 18): the questionnaires of a course for its teacher; Ductus has no such route.
  "app/api/teacher/courses/[courseId]/questionnaires/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173075140",
  },
  "app/api/teacher/questionnaires/[id]/route.ts": {
    methods: ["GET", "PATCH"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173075140",
  },
  "app/api/teacher/questionnaires/[id]/state/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2058:issuecomment-7173075140",
  },
  // SRV-V17-RUBRIC-LEVEL (Ductus#2055, val 17): the teacher's mark of a level per rubric criterion on a work; Ductus has no such route.
  "app/api/teacher/works/[documentId]/rubric/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7153958168",
  },
  "app/api/teacher/works/[documentId]/rubric/[criterionId]/route.ts": {
    methods: ["PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7153958168",
  },
  // SRV-1521 (Ductus#2052, N-15 etape): the template of milestones and the plan of one work; Ductus has no such route.
  "app/api/institution/milestone-template/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/milestone-plan/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/milestone-plan/milestones/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  "app/api/works/[documentId]/milestone-plan/apply-template/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7079306579",
  },
  // SRV-V17-TEMPLATE-ADMIN (val 17): the work template of the institution per work type; Ductus has no such route.
  "app/api/institution/work-templates/[workType]/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7146993897",
  },
  // SRV-V17-TEMPLATE-ASSIGN (val 17): the work template frozen on an assignment; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/template/route.ts": {
    methods: ["PUT"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7147483503",
  },
  "app/api/student/assignments/[assignmentId]/template/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7147483503",
  },
  // SRV-V17-FORMAT-RULES (val 17): the format rules of an assignment for the check before submission; Ductus has no such route.
  "app/api/student/assignments/[assignmentId]/format-rules/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7149374472",
  },
  // SRV-1606 (Ductus#2052, WEB-2155): the teacher returns the whole submitted work for revision.
  "app/api/works/[documentId]/return-for-revision/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7081618556",
  },
  "app/api/works/[documentId]/consultation-records/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7047671233",
  },
  "app/api/works/[documentId]/consultation-records/[recordId]/additions/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7047671233",
  },
  // SRV-1315 (Ductus#2052; plan M7.8): amendments and disputes of process summary events; Ductus has no such route.
  "app/api/works/[documentId]/event-disputes/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7070817702",
  },
  // SRV-2001 (Ductus#2052; phase 3 web-server alignment): the faculty rules of an institution, read and published by its administrator; Ductus has no such route.
  "app/api/institution/faculty-rules/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7074314666",
  },
  // SRV-ADMIN-3 (Ductus#2055 c.7116134498; NF-7 OA-9, OC-1): the faculty's assistant setting, read only by its administrator; Ductus has no such route.
  "app/api/institution/assistant-setting/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116134498",
  },
  // SRV-27 (Ductus#2028 c.7009405737, wave 5): teacher reads of students, overview, receipt and mentorship requests.
  "app/api/teacher/courses/[courseId]/students/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7009405737",
  },
  "app/api/teacher/assignments/[assignmentId]/overview/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7009405737",
  },
  // SRV-NF4-POTVRDE-DORADE (Ductus#2055): notice and revision follow-up beside the overview; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/follow-up/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055",
  },
  "app/api/teacher/assignments/[assignmentId]/students/[studentId]/submission/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7009405737",
  },
  "app/api/teacher/assignments/[assignmentId]/students/[studentId]/declaration/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2051",
  },
  "app/api/teacher/mentorship-requests/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7009405737",
  },
  "app/api/teacher/mentorship-requests/decision/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7009405737",
  },
  // SRV-1108 (Val 11, N-13, C-15): deadline extensions; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/deadline-extensions/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2028:issuecomment-7009405737",
  },
  "app/api/student/assignments/[assignmentId]/deadline-extensions/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052",
  },
  // SRV-NF4-IZNIMKA-ZAPIS (Ductus#2055, plan NF-4, NZ-5 B): the late-submission exception of one student; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/late-submission-exceptions/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7153957738",
  },
  "app/api/student/assignments/[assignmentId]/late-submission-exceptions/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7153957738",
  },
  // SRV-1306 (plan M10.3): legal holds of the institution; Ductus has no such route.
  "app/api/institution/legal-holds/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052",
  },
  "app/api/institution/legal-holds/[holdId]/release/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052",
  },
  // SRV-1308 (plan M10.5): the student data export through the registry office; Ductus has no such route.
  "app/api/institution/student-data-exports/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052",
  },
  // SRV-NF7-IZVOZ-STUDENT (Ductus#2055): the person and state of each export beside the list; Ductus has no such route.
  "app/api/institution/student-data-export-students/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2055",
  },
  "app/api/institution/student-data-exports/[exportId]/approve/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052",
  },
  "app/api/student/data-export/[token]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052",
  },
  // SRV-1903 (P-D3): withdrawal of a submission and the history; Ductus has no such route.
  "app/api/student/assignments/[assignmentId]/submission/withdrawal/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064494920",
  },
  "app/api/student/assignments/[assignmentId]/submission/history/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064494920",
  },
  "app/api/teacher/assignments/[assignmentId]/students/[studentId]/submission-history/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064494920",
  },
  "app/api/teacher/assignments/[assignmentId]/submission-withdrawal/route.ts": {
    methods: ["GET", "POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064494920",
  },
  // SRV-1904 (P-D4): copying an assignment; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/copy/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7064495167",
  },
  // SRV-1109 (Val 11, N-18, C-16, D-286): the Merlin roster and its CSV; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/merlin/roster/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7048729191",
  },
  "app/api/teacher/assignments/[assignmentId]/merlin/csv/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7048729191",
  },
  // SRV-1110 (Val 11, N-18, C-16, D4): the Merlin package and its download; Ductus has no such route.
  "app/api/teacher/assignments/[assignmentId]/merlin/packages/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7049370945",
  },
  "app/api/teacher/assignments/[assignmentId]/merlin/packages/[packageId]/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7049370945",
  },
  "app/api/student/assignments/[assignmentId]/declaration/route.ts": {
    methods: ["GET", "PUT"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060488877",
  },
  "app/api/student/assignments/[assignmentId]/declaration-attachments/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2052:issuecomment-7060488877",
  },
  "app/api/teacher/assignments/[assignmentId]/merlin/packages/[packageId]/download/route.ts": {
    methods: ["GET"],
    source: "danielrisavi77-create/Ductus#2051:issuecomment-7049370945",
  },
  // SRV-ADMIN-2 (NF-7 OA-10): the administrator's import of a course's students; Ductus has no such route.
  "app/api/institution/admin/courses/[courseId]/roster-imports/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116133893",
  },
  "app/api/institution/admin/roster-imports/[importId]/confirm/route.ts": {
    methods: ["POST"],
    source: "danielrisavi77-create/Ductus#2055:issuecomment-7116133893",
  },
  // DAN-843-1: Ductus has no operator route; the rows are those of the
  // function public.operator_log of this repository (S-1K.5-a, DAN-835-1).
  "app/api/ops/events/route.ts": {
    methods: ["GET"],
    source: "ductura/server@ae3bf3c:db/logs/migrations/20261116190000_operator_log.sql",
  },
};

/**
 * Routes with a contract and no handler on this server yet ("ugovoreno, nije
 * implementirano"; DAN-803, c.6905207008 t. 0.1): clients build against the
 * fake server. This list may only shrink: an id leaves it when its handler is
 * mounted (tests/contracts/contract-only.test.ts).
 */
export const CONTRACT_ONLY: readonly string[] = [
  "institution.enrollments.post",
  "institution.role-confirmation.post",
  "institution.role-revocation.post",
  "ops.events.get",
];

/**
 * Inventory files whose contracts follow in the next PR (DAN-736, part 2). This
 * list may only shrink: a file moves out of it when its contract lands.
 */
export const PENDING: readonly string[] = [];
