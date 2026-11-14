// Copy of the route inventory the server takes over: Ductus
// docs/backend/server-route-inventory.md at main d52a92c (DAN-714, 38 route.ts).
// A contract route outside this list, or a file here with neither a contract nor
// a place in PENDING, fails server/contracts/contracts.test.ts.
import type { Method } from "./schema.ts";

export const INVENTORY_SOURCE = "danielrisavi77-create/Ductus@d52a92c:docs/backend/server-route-inventory.md";

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
  "app/api/institution/assignments/[assignmentId]/students/[studentId]/work-language/route.ts": ["POST"],
  "app/api/institution/assignments/[assignmentId]/versions/route.ts": ["POST"],
  "app/api/institution/assignments/[assignmentId]/work-language/route.ts": ["POST"],
  "app/api/institution/assignments/[assignmentId]/works/[documentId]/work-language/route.ts": ["POST"],
  "app/api/institution/courses/[courseId]/assignments/route.ts": ["POST"],
  "app/api/institution/courses/[courseId]/enrollment-code/revocation/route.ts": ["POST"],
  "app/api/institution/courses/[courseId]/enrollment-code/route.ts": ["POST"],
  "app/api/institution/courses/[courseId]/students/[studentId]/removal/route.ts": ["POST"],
  "app/api/institution/courses/[courseId]/students/[studentId]/return-permission/route.ts": ["POST"],
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
 * Inventory files whose contracts follow in the next PR (DAN-736, part 2). This
 * list may only shrink: a file moves out of it when its contract lands.
 */
export const PENDING: readonly string[] = [
  "app/api/comments/[action]/route.ts",
  "app/api/evidence/commit/route.ts",
  "app/api/evidence/open/route.ts",
  "app/api/evidence/replay/route.ts",
  "app/api/institution/assignments/[assignmentId]/acknowledgment/route.ts",
  "app/api/institution/assignments/[assignmentId]/students/[studentId]/work-language/route.ts",
  "app/api/institution/assignments/[assignmentId]/versions/route.ts",
  "app/api/institution/assignments/[assignmentId]/work-language/route.ts",
  "app/api/institution/assignments/[assignmentId]/works/[documentId]/work-language/route.ts",
  "app/api/institution/courses/[courseId]/assignments/route.ts",
  "app/api/institution/courses/[courseId]/enrollment-code/revocation/route.ts",
  "app/api/institution/courses/[courseId]/enrollment-code/route.ts",
  "app/api/institution/courses/[courseId]/students/[studentId]/removal/route.ts",
  "app/api/institution/courses/[courseId]/students/[studentId]/return-permission/route.ts",
  "app/api/institution/courses/route.ts",
  "app/api/institution/enrollments/route.ts",
  "app/api/institution/teachers/[teacherId]/role-confirmation/route.ts",
  "app/api/institution/teachers/[teacherId]/role-revocation/route.ts",
  "app/api/live/[documentId]/route.ts",
  "app/api/process-summary/route.ts",
  "app/api/revision-requests/[action]/route.ts",
  "app/api/submission/route.ts",
  "app/api/support/problem-report/route.ts",
  "app/api/teacher/assignments/[assignmentId]/submissions/route.ts",
  "app/api/teacher/courses/route.ts",
  "app/api/teacher/fast-path/route.ts",
  "app/api/teacher/mentorships/[mentorshipId]/route.ts",
  "app/api/teacher/mentorships/route.ts",
];
