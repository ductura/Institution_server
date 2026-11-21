export type AssistantResponse = { messageId: string; text: string };

type SubmissionScope = { principalId: string; assignmentId: string; requestedAt: string };

type FakeAssistantMessage = AssistantResponse &
  Omit<SubmissionScope, "requestedAt"> & {
    source: "ductura" | "external";
    role: "assistant" | "user";
    recordedAt: string;
    deleted: boolean;
  };

/** Fixture adapter. Timestamps are canonical UTC with six fractional digits, as in receipts. */
export function readFakeAssistantResponses(
  submission: Readonly<SubmissionScope>,
  messages: readonly Readonly<FakeAssistantMessage>[],
): AssistantResponse[] {
  return messages
    .filter(
      (message) =>
        message.source === "ductura" &&
        message.role === "assistant" &&
        !message.deleted &&
        message.principalId === submission.principalId &&
        message.assignmentId === submission.assignmentId &&
        message.recordedAt < submission.requestedAt,
    )
    .map(({ messageId, text }) => ({ messageId, text }));
}
