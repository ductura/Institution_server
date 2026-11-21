// POST /api/v1/teacher/assignments/{assignmentId}/submissions-bulk-link and
// GET .../submissions-bulk/{format} (teacher.submissions-bulk-link.post,
// teacher.submissions-bulk.get), SRV-1902 (plan P-D2): the teacher of an
// assignment asks for a 24 hour link to the ZIP of all its submissions and
// downloads it. The HTTP edge and the composition of existing reads:
//   access   the deadline extensions of the assignment (SRV-1108), which
//            refuse anyone but its teacher with not_found and read no work;
//   works    the Merlin roster read (SRV-1109) over app.fast_path_works, the
//            teacher's read of the submitted texts, which writes the opening
//            of each to the access log in its transaction (SRV-11), so every
//            download is recorded;
//   receipts app.teacher_submission_state (SRV-30), checked as for the
//            student, rendered as the same receipt PDF (SRV-9C).
// A cross-site read is 403, no session 401; another's, an unknown and a
// malformed assignment, a link of another assignment, format or session are
// the same 404 (C-23); a link past its 24 hours is 410. Reads that disagree,
// a missing APP_ORIGIN for the receipt QR, or a throw are 503, reported with
// a closed reason, never a partial ZIP.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { receiptPdfHr } from "../../../locales/index.ts";
import { ROUTES } from "../../contracts/index.ts";
import {
  createAssignmentSubmissionsReader,
  createDeadlineExtensions,
  createMySubmissionStateReader,
  createSubmittedWorksReader,
  type WithActor,
} from "../../database/index.ts";
import {
  createMerlinRosterReader,
  renderReceiptPdf,
  type MerlinRosterReader,
} from "../../downloads/index.ts";
import { readTeacherSubmission, type StudentSubmissionAnswer } from "../../institution/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import { MERLIN_LABELS } from "../merlin-roster/index.ts";

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

import { BULK_ZIP_FILENAME, buildSubmissionsZip, submittedStudents } from "./build.ts";
import { checkBulkLink, isBulkFormat, issueBulkLink, type BulkFormat } from "./link.ts";

export { BULK_FINGERPRINTS, BULK_ZIP_FILENAME } from "./build.ts";
export { BULK_LINK_TTL_MS } from "./link.ts";

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type Answered = Extract<StudentSubmissionAnswer, { status: 200 }>["body"];
export type BulkReceipt = Extract<Answered, { state: "potvrdeno" }>["receipt"];

export type TeacherSubmissionsBulkDeps = {
  /** Whether the caller teaches the assignment; reads no work. */
  readonly access: (
    token: string,
    assignmentId: string,
  ) => Promise<"read" | "unauthorized" | "not_found">;
  readonly roster: MerlinRosterReader;
  readonly receipt: (
    token: string,
    assignmentId: string,
    studentId: string,
  ) => Promise<StudentSubmissionAnswer>;
  /** The receipt PDF; null without APP_ORIGIN for its QR, which answers 503. */
  readonly renderReceipt: ((receipt: BulkReceipt) => Promise<Uint8Array>) | null;
  readonly now?: () => number;
};

function contractOf(id: string) {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
}

/** One line on stderr: a closed reason code and the request id, never an id or content. */
function unavailable(response: ServerResponse, reason: string): void {
  try {
    console.error(
      JSON.stringify({
        event: "teacher_submissions_bulk_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
  sendProblem(response, 503, "unavailable");
}

const crossSite = (request: IncomingMessage) => {
  const site = request.headersDistinct["sec-fetch-site"];
  return site !== undefined && (site.length !== 1 || site[0] !== "same-origin");
};

function linkRoute(deps: TeacherSubmissionsBulkDeps): Route {
  const contract = contractOf("teacher.submissions-bulk-link.post");
  const input = contract.request.body!;
  const output = contract.responses[0]?.body;
  const now = deps.now ?? Date.now;
  return {
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const types = request.headersDistinct["content-type"];
      if (
        types?.length !== 1 ||
        types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes!, BODY_TIMEOUT_MS);
      if (!raw.ok) return refuse(response, raw.status, raw.reason);
      const json = parseJson(raw.bytes);
      if (!json.ok) return sendProblem(response, 400, "invalid_json");
      if (!Value.Check(input, json.value)) return sendProblem(response, 422, "invalid_input");
      const assignmentId = (params?.assignmentId ?? "").toLowerCase();
      if (!UUID.test(assignmentId)) return sendProblem(response, 404, "not_found");
      const { format } = json.value as { format: BulkFormat };
      try {
        const access = await deps.access(token, assignmentId);
        if (access === "unauthorized") return sendProblem(response, 401, "unauthorized");
        if (access === "not_found") return sendProblem(response, 404, "not_found");
        const link = issueBulkLink(token, assignmentId, format, now());
        const answer = {
          format,
          downloadPath: `/api/v1/teacher/assignments/${assignmentId}/submissions-bulk/${format}?token=${link.token}`,
          expiresAt: link.expiresAt,
        };
        if (output !== undefined && Value.Check(output, answer)) {
          return sendJson(response, 201, answer);
        }
        return unavailable(response, "answer_outside_contract");
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

/** The receipt PDFs of the submitted students, or the status that ends the download. */
async function receiptsOf(
  deps: TeacherSubmissionsBulkDeps,
  render: (receipt: BulkReceipt) => Promise<Uint8Array>,
  token: string,
  assignmentId: string,
  studentIds: readonly string[],
): Promise<Map<string, Uint8Array> | 401 | "disagree"> {
  const receipts = new Map<string, Uint8Array>();
  for (const studentId of studentIds) {
    const read = await deps.receipt(token, assignmentId, studentId);
    if (read.status === 401) return 401;
    // The roster named a submission this read cannot vouch for.
    if (read.status !== 200 || read.body.state === "none") return "disagree";
    if (read.body.state === "ceka") continue;
    const { receipt } = read.body;
    if (receipt.payload.principalId !== studentId) return "disagree";
    receipts.set(studentId, await render(receipt));
  }
  return receipts;
}

function downloadRoute(deps: TeacherSubmissionsBulkDeps): Route {
  const contract = contractOf("teacher.submissions-bulk.get");
  const now = deps.now ?? Date.now;
  return {
    contract,
    async handle(request, response, params) {
      if (crossSite(request)) return sendProblem(response, 403, "forbidden");
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const assignmentId = (params?.assignmentId ?? "").toLowerCase();
      const format = params?.format;
      const linkToken = new URL(request.url ?? "/", "http://localhost").searchParams.get("token");
      if (!UUID.test(assignmentId) || !isBulkFormat(format) || linkToken === null) {
        return sendProblem(response, 404, "not_found");
      }
      const check = checkBulkLink(token, assignmentId, format, linkToken, now());
      if (check === "invalid") return sendProblem(response, 404, "not_found");
      if (check === "expired") return sendProblem(response, 410, "not_allowed");
      const render = deps.renderReceipt;
      if (render === null) return unavailable(response, "origin_missing");
      try {
        const read = await deps.roster(token, assignmentId);
        if (read.status !== "read") {
          return read.status === "unauthorized"
            ? sendProblem(response, 401, "unauthorized")
            : sendProblem(response, 404, "not_found");
        }
        const students = submittedStudents(read.roster);
        const receipts = await receiptsOf(deps, render, token, assignmentId, students);
        if (receipts === 401) return sendProblem(response, 401, "unauthorized");
        if (receipts === "disagree") return unavailable(response, "reads_disagree");
        const zip = buildSubmissionsZip(read.roster, format, receipts);
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${BULK_ZIP_FILENAME}"`,
          "cache-control": "private, no-store",
          "content-length": String(zip.bytes.byteLength),
          "x-content-type-options": "nosniff",
          "x-content-sha256": zip.sha256,
        });
        response.end(Buffer.from(zip.bytes));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createTeacherSubmissionsBulkRoutes(deps: TeacherSubmissionsBulkDeps): Route[] {
  return [linkRoute(deps), downloadRoute(deps)];
}

/** The routes over main's application withActor; APP_ORIGIN for the receipt QR, null answers 503. */
export function createTeacherSubmissionsBulkRoutesFor(
  main: { readonly withActor: WithActor },
  origin: string | null,
): Route[] {
  const extensions = createDeadlineExtensions(main.withActor);
  const states = createMySubmissionStateReader(main.withActor);
  return createTeacherSubmissionsBulkRoutes({
    access: async (token, assignmentId) => {
      const read = await extensions.list(token, assignmentId);
      return read.status;
    },
    roster: createMerlinRosterReader({
      extensions: (token, assignmentId) => extensions.list(token, assignmentId),
      submissions: createAssignmentSubmissionsReader(main.withActor),
      works: createSubmittedWorksReader(main.withActor),
      labels: MERLIN_LABELS,
    }),
    receipt: (token, assignmentId, studentId) =>
      readTeacherSubmission(states, token, assignmentId, studentId),
    renderReceipt:
      origin === null ? null : (receipt) => renderReceiptPdf(receipt, origin, receiptPdfHr),
  });
}
