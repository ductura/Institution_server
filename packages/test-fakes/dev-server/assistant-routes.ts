import type { Handlers } from "./server.ts";

// SRV-1204: the AI assistant proxy on the dev fake, as the production
// composition answers it: no provider is configured (Q-10), so every request
// whose body passes is ai_disabled. Nothing is ever stored, so a student's
// conversation reads empty and anyone else's read is not_found.
export const ASSISTANT_HANDLERS: Handlers = {
  "student.assistant-request.post": () => ({
    status: 200,
    body: { outcome: "ai_disabled", requestId: null, conversationId: null },
  }),
  "student.assistant-conversation.get": ({ account, params }) => {
    const id = params.conversationId.toLowerCase();
    if (!account?.roles.includes("student") || !/^[0-9a-f-]{36}$/.test(id)) {
      return { error: "not_found" };
    }
    return { status: 200, body: { conversationId: id, messages: [] } };
  },
  // SRV-ASIST-CITANJE: nothing is stored, so a student of the assignment's
  // course reads an empty list; anyone else's or an unknown one is not_found.
  "student.assistant-conversations.get": ({ state, account, params }) => {
    const id = params.assignmentId.toLowerCase();
    const assignment = state.assignments.find((a) => a.id === id);
    const course = state.courses.find((c) => c.id === assignment?.courseId);
    if (assignment === undefined || account === null || !course?.studentIds.includes(account.id))
      return { error: "not_found" };
    return { status: 200, body: { assignmentId: assignment.id, conversations: [] } };
  },
};
