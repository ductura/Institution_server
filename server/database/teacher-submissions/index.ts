import {
  createLiveStates,
  submissionOf,
  type AssignmentSubmission,
  type WithActor,
} from "../index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

// Preserve the roster's scope. The receipt supplies an ID only after it is
// bound, and the stored flag already reflects the deadline pinned by SRV-1108C.
const SQL = `WITH roster AS MATERIALIZED (
  SELECT s.student_id, w.document_id, s.submitted, s.revision::text,
         s.requested_minute, s.after_deadline,
         CASE WHEN s.submitted THEN (
           SELECT p.receipt_payload::jsonb
           FROM app.teacher_submission_state($1::uuid, s.student_id) p
         ) END AS receipt
    FROM app.assignment_submissions($1::uuid) s
    LEFT JOIN app.assignment_works($1::uuid) w USING (student_id)
)
SELECT * FROM roster
 WHERE $2::uuid IS NULL OR receipt ->> 'submissionId' = $2::text
 ORDER BY student_id`;

type SubmissionVersion = {
  studentId: string;
  submissionId: string | null;
  revision: number;
  late: boolean;
};

type Refusal = { status: "unauthenticated" | "not_found" | "unavailable" };
type Read<Body> = { status: "ok"; body: Body } | Refusal;
type Row = {
  submission: AssignmentSubmission;
  version?: SubmissionVersion;
  artifactHash?: string;
};

function rowOf(raw: Record<string, unknown>, assignmentId: string): Row | null {
  const submission = submissionOf(raw);
  if (submission === null) return null;
  if (submission.revision === null || submission.afterDeadline === null) return { submission };
  const { studentId, documentId, revision, afterDeadline: late } = submission;
  if (raw.receipt === null) {
    return { submission, version: { studentId, submissionId: null, revision, late } };
  }
  if (typeof raw.receipt !== "object" || raw.receipt === null) return null;
  const receipt = raw.receipt as Record<string, unknown>;
  if (
    documentId === null ||
    receipt.documentId !== documentId ||
    receipt.assignmentId !== assignmentId ||
    receipt.principalId !== studentId ||
    receipt.revision !== revision ||
    receipt.afterDeadline !== late ||
    typeof receipt.submissionId !== "string" ||
    !UUID.test(receipt.submissionId) ||
    typeof receipt.artifactSha256 !== "string" ||
    !HASH.test(receipt.artifactSha256)
  ) {
    return null;
  }
  return {
    submission,
    version: { studentId, submissionId: receipt.submissionId, revision, late },
    artifactHash: receipt.artifactSha256,
  };
}

export function createTeacherSubmissions(withActor: WithActor) {
  const live = createLiveStates(withActor);

  async function read(
    token: string,
    assignmentId: string,
    submissionId: string | null,
  ): Promise<Read<Row[]>> {
    try {
      const { rows } = await withActor(token, (tx) =>
        tx.query<Record<string, unknown>>(SQL, [assignmentId, submissionId]),
      );
      const result: Row[] = [];
      const students = new Set<string>();
      for (const raw of rows) {
        const row = rowOf(raw, assignmentId);
        if (row === null || students.has(row.submission.studentId))
          return { status: "unavailable" };
        students.add(row.submission.studentId);
        result.push(row);
      }
      return { status: "ok", body: result };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ZD401") return { status: "unauthenticated" };
      if (code === "ZD403") return { status: "not_found" };
      return { status: "unavailable" };
    }
  }

  return {
    async list(
      token: string,
      assignmentId: string,
    ): Promise<
      Read<{
        submissions: AssignmentSubmission[];
        submittedVersions?: SubmissionVersion[];
      }>
    > {
      assignmentId = assignmentId.toLowerCase();
      if (!UUID.test(assignmentId)) return { status: "ok", body: { submissions: [] } };
      const result = await read(token, assignmentId, null);
      if (result.status === "not_found") return { status: "ok", body: { submissions: [] } };
      if (result.status !== "ok") return result;
      const submissions = result.body.map((row) => row.submission);
      const submittedVersions = result.body.flatMap((row) => row.version ?? []);
      return {
        status: "ok",
        body: submittedVersions.length === 0 ? { submissions } : { submissions, submittedVersions },
      };
    },

    async detail(
      token: string,
      assignmentId: string,
      submissionId: string,
    ): Promise<
      Read<Omit<SubmissionVersion, "submissionId"> & { submissionId: string; document: string }>
    > {
      assignmentId = assignmentId.toLowerCase();
      submissionId = submissionId.toLowerCase();
      if (!UUID.test(assignmentId) || !UUID.test(submissionId)) return { status: "not_found" };
      const result = await read(token, assignmentId, submissionId);
      if (result.status !== "ok") return result;
      if (result.body.length === 0) return { status: "not_found" };
      const row = result.body[0];
      if (
        result.body.length !== 1 ||
        row?.version?.submissionId !== submissionId ||
        row.submission.documentId === null
      ) {
        return { status: "unavailable" };
      }
      // This rechecks access and logs the opening. It also verifies the bytes
      // against the checkpoint's hash, which must match the bound receipt.
      const content = await live.read(token, row.submission.documentId, null);
      if (content.status === "not_found" || content.status === "unauthenticated")
        return { status: content.status };
      if (content.status !== "state" || !content.submitted || content.hash !== row.artifactHash) {
        return { status: "unavailable" };
      }
      return {
        status: "ok",
        body: {
          ...row.version,
          submissionId,
          document: Buffer.from(content.bytes).toString("utf8"),
        },
      };
    },
  };
}

export type TeacherSubmissions = ReturnType<typeof createTeacherSubmissions>;
