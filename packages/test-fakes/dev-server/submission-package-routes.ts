// The submission package on the dev fake server (SRV-1807): the 24 hour link
// of student.submission-package-link.post and the download of
// student.submission-package.get. Only the student whose work holds the
// receipt with that submission id gets a link or a download; anyone else, an
// unknown and a malformed id the same 404. The token carries its expiry as the
// real one does (<epoch ms>.<43 characters>); the fake's receipt is not signed
// (UNSIGNED_SUBMISSION), so the download answers the headers of the ZIP or the
// PDF without bytes, as the portable record does. The real files are built and
// checked by server/downloads/submission-package.
import { createHash } from "node:crypto";

import type { Handlers } from "./server.ts";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^(\d{1,15})\.[A-Za-z0-9_-]{43}$/u;

const tokenFor = (submissionId: string, kind: string, expiresMs: number) =>
  `${expiresMs}.${createHash("sha256")
    .update(`${submissionId}\n${kind}\n${expiresMs}`)
    .digest("base64url")}`;

export const SUBMISSION_PACKAGE_HANDLERS: Handlers = {
  "student.submission-package-link.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const submissionId = params.submissionId.toLowerCase();
    const owned =
      LOWER_UUID.test(submissionId) &&
      state.works.some(
        (item) =>
          item.studentId === account.id &&
          item.submissionReceipt?.payload.submissionId === submissionId,
      );
    if (!owned) return { error: "not_found" };
    const expiresMs = now.getTime() + DAY_MS;
    return {
      status: 201,
      headers: { "cache-control": "no-store" },
      body: {
        kind: body.kind,
        downloadPath: `/api/v1/student/submissions/${submissionId}/package/${body.kind}?token=${tokenFor(submissionId, body.kind, expiresMs)}`,
        expiresAt: new Date(expiresMs).toISOString(),
      },
    };
  },
  "student.submission-package.get": ({ state, account, params, query, now }) => {
    if (account === null) return { error: "unauthorized" };
    const submissionId = params.submissionId.toLowerCase();
    const owned =
      LOWER_UUID.test(submissionId) &&
      state.works.some(
        (item) =>
          item.studentId === account.id &&
          item.submissionReceipt?.payload.submissionId === submissionId,
      );
    const match = TOKEN.exec(query.token);
    if (!owned || match === null) return { error: "not_found" };
    const expiresMs = Number(match[1]);
    if (query.token !== tokenFor(submissionId, params.kind, expiresMs)) {
      return { error: "not_found" };
    }
    if (now.getTime() >= expiresMs) return { error: "not_allowed" };
    const zip = params.kind === "package";
    return {
      status: 200,
      headers: {
        "content-type": zip ? "application/zip" : "application/pdf",
        "content-disposition": `attachment; filename="${zip ? "prenosivi-zapis.zip" : "potvrda-za-referadu.pdf"}"`,
        "cache-control": "private, no-store",
        "x-content-sha256": createHash("sha256")
          .update(`izvozni-paket-${params.kind}-${submissionId}`)
          .digest("hex"),
      },
    };
  },
};
