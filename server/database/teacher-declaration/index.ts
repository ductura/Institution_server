// SRV-1213: the declaration a student bound to the live submission, read by
// the course teacher or, since SRV-IZJAVA-MENTOR, the mentor of the work.
// app.teacher_declaration checks the relationship (C-23)
// and records the opening of a bound declaration in the access log; a refusal
// (ZD403) is the same 404 as an unknown id.
import type { WithActor } from "../index.ts";

export {
  createTeacherDeclarationConversationReader,
  type TeacherDeclarationConversation,
  type TeacherDeclarationConversationReader,
} from "./conversation.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SQL = `SELECT state, payload_jcs, declaration_sha256
    FROM app.teacher_declaration($1::uuid, $2::uuid)`;
// SRV-IZJAVA-PITANJE: the question in force and the answer bound with the
// declaration, read in the same transaction after the declaration (same
// relation check, the same access-log row).
const ANSWER_SQL = `SELECT question, answer FROM app.teacher_declaration_answer($1::uuid, $2::uuid)`;
// SRV-IZJAVA-AI-UNBOUND: the student's transfer records of the declared document
// that no evidence revision binds, read third in the same transaction (same
// relation check; it writes no access-log row of its own). Only the v3 route asks.
const UNBOUND_SQL = `SELECT app.teacher_declaration_unbound($1::uuid, $2::uuid) AS unbound`;

type Question = { questionId: string; text: string } | null;
type Answer = { questionId: string; questionText: string; text: string } | null;
export type UnboundTransfer = { aiTransferId: string; aiTransferSha256: string };

export type TeacherDeclaration = (
  | { state: "none"; payload: null; declarationSha256: null }
  | {
      state: "bound";
      payload: unknown;
      declarationSha256: string;
      ai?: { unbound: UnboundTransfer[] };
    }
) & { question?: Question; questionAnswer?: Answer };

export type TeacherDeclarationReader = (
  token: string,
  assignmentId: string,
  studentId: string,
) => Promise<
  | { status: "ok"; body: TeacherDeclaration }
  | { status: "unauthenticated" | "not_found" | "unavailable" }
>;

export function createTeacherDeclarationReader(
  withActor: WithActor,
  options: { unbound?: boolean } = {},
): TeacherDeclarationReader {
  return async (token, assignmentId, studentId) => {
    assignmentId = assignmentId.toLowerCase();
    studentId = studentId.toLowerCase();
    if (!UUID.test(assignmentId) || !UUID.test(studentId)) return { status: "not_found" };

    let rows: Record<string, unknown>[];
    let extra: Record<string, unknown>[];
    let unboundRows: Record<string, unknown>[] | undefined;
    try {
      [rows, extra, unboundRows] = await withActor(token, async (tx) => [
        (await tx.query<Record<string, unknown>>(SQL, [assignmentId, studentId])).rows,
        (await tx.query<Record<string, unknown>>(ANSWER_SQL, [assignmentId, studentId])).rows,
        options.unbound === true
          ? (await tx.query<Record<string, unknown>>(UNBOUND_SQL, [assignmentId, studentId])).rows
          : undefined,
      ]);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ZD401") return { status: "unauthenticated" };
      if (code === "ZD403") return { status: "not_found" };
      return { status: "unavailable" };
    }
    const row = rows.length === 1 ? rows[0]! : undefined;
    const answerRow = extra.length === 1 ? extra[0]! : undefined;
    if (answerRow === undefined) return { status: "unavailable" };
    // The shapes are checked against the contract at the HTTP edge.
    const question = (answerRow.question ?? null) as Question;
    const questionAnswer = (row?.state === "bound" ? (answerRow.answer ?? null) : null) as Answer;
    if (row?.state === "none") {
      return {
        status: "ok",
        body: { state: "none", payload: null, declarationSha256: null, question, questionAnswer },
      };
    }
    if (
      row?.state !== "bound" ||
      typeof row.payload_jcs !== "string" ||
      typeof row.declaration_sha256 !== "string" ||
      !SHA256.test(row.declaration_sha256)
    ) {
      return { status: "unavailable" };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_jcs);
    } catch {
      return { status: "unavailable" };
    }
    // The list's shape is checked against the contract at the HTTP edge.
    const unbound = unboundRows?.length === 1 ? unboundRows[0]!.unbound : undefined;
    if (unboundRows !== undefined && !Array.isArray(unbound)) return { status: "unavailable" };
    return {
      status: "ok",
      body: {
        state: "bound",
        payload,
        declarationSha256: row.declaration_sha256,
        ...(unboundRows === undefined ? {} : { ai: { unbound: unbound as UnboundTransfer[] } }),
        question,
        questionAnswer,
      },
    };
  };
}
