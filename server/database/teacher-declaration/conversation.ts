// F4-NAS-R04-SRV (D-41): one conversation the student attached to the declaration
// bound to the live submission, read by the course teacher. The relationship,
// the attachment and its hash are checked in app.teacher_declaration_conversation;
// every refusal (ZD403: unattached, foreign, unknown, no live submission, a
// reader who is not the course teacher) is the same 404, and a stored
// conversation that no longer matches the confirmed hash (ZD409) is unavailable.
import type { WithActor } from "../index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROLES = new Set(["student_paragraph", "provider_response"]);
const SQL = `SELECT seq, role, content, content_sha256, created_at, through_seq, messages_sha256
    FROM app.teacher_declaration_conversation($1::uuid, $2::uuid, $3::uuid)`;

export type TeacherDeclarationConversation = {
  conversationId: string;
  throughSeq: number;
  messagesSha256: string;
  messages: {
    seq: number;
    role: "student_paragraph" | "provider_response";
    content: string;
    contentSha256: string;
    createdAt: string;
  }[];
};

export type TeacherDeclarationConversationReader = (
  token: string,
  assignmentId: string,
  studentId: string,
  conversationId: string,
) => Promise<
  | { status: "ok"; body: TeacherDeclarationConversation }
  | { status: "unauthenticated" | "not_found" | "unavailable" }
>;

export function createTeacherDeclarationConversationReader(
  withActor: WithActor,
): TeacherDeclarationConversationReader {
  return async (token, assignmentId, studentId, conversationId) => {
    assignmentId = assignmentId.toLowerCase();
    studentId = studentId.toLowerCase();
    conversationId = conversationId.toLowerCase();
    if (!UUID.test(assignmentId) || !UUID.test(studentId) || !UUID.test(conversationId)) {
      return { status: "not_found" };
    }
    let rows: Record<string, unknown>[];
    try {
      rows = await withActor(
        token,
        async (tx) =>
          (await tx.query<Record<string, unknown>>(SQL, [assignmentId, studentId, conversationId]))
            .rows,
      );
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ZD401") return { status: "unauthenticated" };
      if (code === "ZD403") return { status: "not_found" };
      return { status: "unavailable" };
    }
    const first = rows[0];
    if (first === undefined) return { status: "unavailable" };
    const throughSeq = first.through_seq;
    const messagesSha256 = first.messages_sha256;
    if (
      typeof throughSeq !== "number" ||
      typeof messagesSha256 !== "string" ||
      !SHA256.test(messagesSha256) ||
      rows.length !== throughSeq
    ) {
      return { status: "unavailable" };
    }
    const messages: TeacherDeclarationConversation["messages"] = [];
    for (const [index, row] of rows.entries()) {
      const { seq, role, content, content_sha256: sha, created_at: at } = row;
      if (
        seq !== index + 1 ||
        typeof role !== "string" ||
        !ROLES.has(role) ||
        typeof content !== "string" ||
        typeof sha !== "string" ||
        !SHA256.test(sha) ||
        !(at instanceof Date) ||
        Number.isNaN(at.getTime()) ||
        row.through_seq !== throughSeq ||
        row.messages_sha256 !== messagesSha256
      ) {
        return { status: "unavailable" };
      }
      messages.push({
        seq,
        role: role as "student_paragraph" | "provider_response",
        content,
        contentSha256: sha,
        createdAt: at.toISOString(),
      });
    }
    return { status: "ok", body: { conversationId, throughSeq, messagesSha256, messages } };
  };
}
