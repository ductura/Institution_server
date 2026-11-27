// POST /api/v1/student/submissions/{submissionId}/package-link and
// GET .../package/{kind} (student.submission-package-link.post,
// student.submission-package.get), SRV-1807 (plan M8.6, R-05, R-06, D-173):
// the 24 hour link to the export package or to the confirmation for the
// registrar of the caller's own submission, and the download through it. The
// HTTP edge only: the same-origin read (403), a live session cookie (401), the
// submission id, then server/database/portable-record for the stored rows and
// server/downloads/submission-package for the link and the checked bytes.
// Another's, an unknown and a malformed submission, a link that is not this
// session's, this submission's or this kind's, are the same 404 (C-23); a link
// past its 24 hours is 410. The PDF QR needs the configured origin
// (APP_ORIGIN); without it, as for a record the builder could not vouch for
// or a throw, the answer is 503, reported with a closed reason only.
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { receiptPdfHr } from "../../../locales/index.ts";
import { ROUTES } from "../../contracts/index.ts";
import { createPortableRecordReader, type PortableRecordReader } from "../../database/index.ts";
import {
  buildSubmissionPackage,
  checkPackageLink,
  issuePackageLink,
  PACKAGE_KINDS,
  PENDING_DAILY_ROOT,
  type PackageKind,
  type PortableDailyRootSource,
} from "../../downloads/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";

import {
  codeForRecord,
  createSubmissionConfirmationCodeFor,
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Databases,
  type Route,
  type SubmissionConfirmationCode,
} from "../index.ts";

const BODY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function contractOf(id: string) {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
}

const isKind = (value: unknown): value is PackageKind =>
  (PACKAGE_KINDS as readonly unknown[]).includes(value);

/** One line on stderr: a closed reason code and the request id, never an id or content. */
function unavailable(response: ServerResponse, reason: string): void {
  try {
    console.error(
      JSON.stringify({
        event: "submission_package_unavailable",
        reason,
        requestId: requestIdOf(response),
      }),
    );
  } catch {
    // A broken stderr must not turn the 503 into a crash.
  }
}

export type SubmissionPackageRouteDeps = {
  readonly read: PortableRecordReader;
  /** The signed root of the day of a receipt; pending until SRV-1311's store and reader exist. */
  readonly dailyRoot: PortableDailyRootSource;
  /** APP_ORIGIN, for the QR of the receipt PDF; null answers 503. */
  readonly origin: string | null;
  /** The bound confirmation code of the submission, under the same session; none if not live (Dizajn 1.1). */
  readonly code: SubmissionConfirmationCode;
  readonly now?: () => number;
};

function linkRoute(deps: SubmissionPackageRouteDeps): Route {
  const contract = contractOf("student.submission-package-link.post");
  const input = contract.request.body!;
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
      const submissionId = params?.submissionId ?? "";
      if (!UUID.test(submissionId)) return sendProblem(response, 404, "not_found");
      const { kind } = json.value as { kind: PackageKind };
      try {
        const read = await deps.read(token, submissionId.toLowerCase());
        if (read.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (read.status === "not_found") return sendProblem(response, 404, "not_found");
        if (read.status === "unavailable") {
          unavailable(response, read.reason);
          return sendProblem(response, 503, "unavailable");
        }
        const link = issuePackageLink(token, submissionId.toLowerCase(), kind, now());
        return sendJson(response, 201, {
          kind,
          downloadPath: `/api/v1/student/submissions/${submissionId.toLowerCase()}/package/${kind}?token=${link.token}`,
          expiresAt: link.expiresAt,
        });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

function downloadRoute(deps: SubmissionPackageRouteDeps): Route {
  const contract = contractOf("student.submission-package.get");
  const now = deps.now ?? Date.now;
  return {
    contract,
    async handle(request, response, params) {
      const site = request.headersDistinct["sec-fetch-site"];
      if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
        return sendProblem(response, 403, "forbidden");
      }
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const submissionId = params?.submissionId?.toLowerCase() ?? "";
      const kind = params?.kind;
      const linkToken = new URL(request.url ?? "/", "http://localhost").searchParams.get("token");
      if (!UUID.test(submissionId) || !isKind(kind) || linkToken === null) {
        return sendProblem(response, 404, "not_found");
      }
      const check = checkPackageLink(token, submissionId, kind, linkToken, now());
      if (check === "invalid") return sendProblem(response, 404, "not_found");
      if (check === "expired") return sendProblem(response, 410, "not_allowed");
      if (deps.origin === null) {
        unavailable(response, "origin_missing");
        return sendProblem(response, 503, "unavailable");
      }
      try {
        const read = await deps.read(token, submissionId);
        if (read.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (read.status === "not_found") return sendProblem(response, 404, "not_found");
        if (read.status === "unavailable") {
          unavailable(response, read.reason);
          return sendProblem(response, 503, "unavailable");
        }
        const confirmation = await codeForRecord(
          deps.code,
          token,
          submissionId,
          read.rows.receiptPayload,
          response,
          contract.id,
        );
        if (confirmation === null) return;
        const built = await buildSubmissionPackage(kind, {
          submissionId,
          source: read.rows,
          dailyRoot: deps.dailyRoot,
          origin: deps.origin,
          labels: receiptPdfHr,
          confirmationCode: confirmation.code,
        });
        if (built.status === "refused") {
          unavailable(response, built.reason);
          return sendProblem(response, 503, "unavailable");
        }
        if (createHash("sha256").update(built.bytes).digest("hex") !== built.sha256) {
          unavailable(response, "fingerprint_mismatch");
          return sendProblem(response, 503, "unavailable");
        }
        response.writeHead(200, {
          "content-type": built.contentType,
          "content-disposition": `attachment; filename="${built.filename}"`,
          "cache-control": "private, no-store",
          "content-length": String(built.bytes.byteLength),
          "x-content-type-options": "nosniff",
          "x-content-sha256": built.sha256,
        });
        response.end(Buffer.from(built.bytes));
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createSubmissionPackageRoutes(deps: SubmissionPackageRouteDeps): Route[] {
  return [linkRoute(deps), downloadRoute(deps)];
}

/** The routes over main's application withActor; daily roots stay pending until they are stored. */
export function createSubmissionPackageRoutesFor(
  main: Pick<Databases["main"], "withActor">,
  origin: string | null,
): Route[] {
  return createSubmissionPackageRoutes({
    read: createPortableRecordReader(main.withActor),
    dailyRoot: PENDING_DAILY_ROOT,
    origin,
    code: createSubmissionConfirmationCodeFor(main.withActor),
  });
}
