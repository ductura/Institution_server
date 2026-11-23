import { Value } from "@sinclair/typebox/value";

import { ROUTES, WORK_INTERVIEW_NOTE_MAX_BYTES, workIdFromPath } from "../../contracts/index.ts";
import { createWorkInterviewStore, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

const route = (id: string) => ROUTES.find((contract) => contract.id === id)!;
const GET = route("work.interview.get");
const ADD_QUESTION = route("work.interview-questions.post");
const REMOVE_QUESTION = route("work.interview-questions.delete");
const INVITE = route("work.interview-invite.post");
const APPOINTMENT = route("work.interview-appointment.put");
const HELD = route("work.interview-held.post");
const EXPLAIN = route("work.interview-explanations.post");
const NOTE = route("work.interview-notes.post");
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
const REFUSALS = new Map<string, readonly [number, string]>([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
  ["22007", [422, "invalid_input"]],
  ["22008", [422, "invalid_input"]],
  ["22009", [422, "invalid_input"]],
]);

type Input = {
  paragraphRef?: string | null;
  questionText?: string;
  consultationSlotId?: string;
  place?: string;
  at?: string;
  date?: string;
  questionId?: string | null;
  text?: string;
  fileName?: string;
  mediaType?: "text/plain" | "application/pdf";
  contentBase64?: string;
};

const PDF_HEADER = Buffer.from("%PDF-", "latin1");
// Tab, line feed and carriage return are the only control characters a text note keeps.
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * The bytes of a note when they are canonical Base64 of a UTF-8 text or a PDF
 * within the limit; the database checks the same again.
 */
function noteContent(
  mediaType: "text/plain" | "application/pdf",
  base64: string,
): Uint8Array | null {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) return null;
  if (bytes.length < 1 || bytes.length > WORK_INTERVIEW_NOTE_MAX_BYTES) return null;
  if (mediaType === "application/pdf") {
    return bytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER) ? bytes : null;
  }
  // Invalid UTF-8 decodes to replacement characters, which do not encode back to the same bytes.
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) && !TEXT_CONTROL.test(text) ? bytes : null;
}

export function createWorkInterviewRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const store = createWorkInterviewStore(withActor);
  const run = (
    contract: (typeof ROUTES)[number],
    token: string,
    documentId: string,
    questionId: string | undefined,
    input: Input,
    content: Uint8Array | null,
  ): Promise<unknown> => {
    const actions = new Map<string, () => Promise<unknown>>([
      [GET.id, () => store.get(token, documentId)],
      [
        ADD_QUESTION.id,
        () => store.addQuestion(token, documentId, input.paragraphRef ?? null, input.questionText!),
      ],
      [INVITE.id, () => store.invite(token, documentId)],
      [
        APPOINTMENT.id,
        () =>
          store.setAppointment(
            token,
            documentId,
            input.consultationSlotId === undefined
              ? { place: input.place!, at: input.at! }
              : { consultationSlotId: input.consultationSlotId },
          ),
      ],
      [HELD.id, () => store.markHeld(token, documentId, input.date!)],
      [
        EXPLAIN.id,
        () => store.addExplanation(token, documentId, input.questionId ?? null, input.text!),
      ],
      [
        NOTE.id,
        () =>
          store.addNote(token, documentId, {
            fileName: input.fileName!,
            mediaType: input.mediaType!,
            content: content!,
          }),
      ],
    ]);
    return actions.get(contract.id)!();
  };

  return [GET, ADD_QUESTION, REMOVE_QUESTION, INVITE, APPOINTMENT, HELD, EXPLAIN, NOTE].map(
    (contract) => {
      const success = contract.responses[0]!;
      return {
        contract,
        async handle(request, response, params) {
          const token = liveSessionTokenFromCookie(request.headers.cookie);
          if (token === undefined) return refuse(response, 401, "unauthorized");
          const documentId = workIdFromPath(params?.documentId ?? "");
          const questionId = params?.questionId;
          if (
            documentId === null ||
            !Value.Check(contract.request.params!, {
              documentId,
              ...(questionId === undefined ? {} : { questionId }),
            })
          ) {
            return refuse(response, 404, "not_found");
          }

          let input: Input = {};
          if (contract.request.body !== undefined) {
            const types = request.headersDistinct["content-type"];
            if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
              return refuse(response, 415, "unsupported_media_type");
            }
            const raw = await readBodyWithLimit(
              request,
              contract.request.maxBodyBytes!,
              BODY_TIMEOUT_MS,
            );
            if (!raw.ok) return refuse(response, raw.status, raw.reason);
            const json = parseJson(raw.bytes);
            if (!json.ok) return sendProblem(response, 400, "invalid_json");
            if (!Value.Check(contract.request.body, json.value)) {
              return sendProblem(response, 422, "invalid_input");
            }
            input = json.value as Input;
          }
          let content: Uint8Array | null = null;
          if (contract === NOTE) {
            content = noteContent(input.mediaType!, input.contentBase64!);
            if (content === null) return sendProblem(response, 422, "invalid_input");
          }

          try {
            if (contract === REMOVE_QUESTION) {
              await store.removeQuestion(token, documentId, questionId!);
              response.writeHead(204, { "cache-control": "no-store" });
              response.end();
            } else {
              const body = await run(contract, token, documentId, questionId, input, content);
              if (!Value.Check(success.body!, body))
                throw new Error("invalid work interview response");
              sendJson(response, success.status, body);
            }
          } catch (error) {
            const code =
              error && typeof error === "object" && "code" in error ? error.code : undefined;
            const refusal = typeof code === "string" ? REFUSALS.get(code) : undefined;
            if (refusal !== undefined) return sendProblem(response, ...refusal);
            reportServerError("route", error, requestIdOf(response), contract.id);
            return sendProblem(response, 503, "unavailable");
          }
          if (contract !== GET) void recordActivity(token, withActor).catch(() => undefined);
        },
      };
    },
  );
}
