// The student data export on the dev fake server (SRV-1308, plan M10.5): a
// clerk of the registry office (the fake's clerk is the account without a
// role, "bez-uloge") requests, an administrator who did not request approves,
// and a ready export lets its link through once (410 afterwards). As on the
// real server a clerk never requests for themselves, an administrator never
// requests, a second open request for the same person is 409, and the list is
// the institution's for a clerk or an administrator and the caller's own for
// anyone else. The fake has no worker: an export becomes ready only through
// its state (a test's prepare). The download answers the ZIP headers without
// bytes; the real package is built by server/privacy/student-data-export.
// All values are invented.
import { createHash, randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const OPEN = new Set(["requested", "approved", "ready"]);

/** The SHA-256 of a link token, as the state keeps it. */
export const studentDataExportTokenHashOf = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const STUDENT_DATA_EXPORT_HANDLERS: Handlers = {
  "institution.student-data-exports.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const all =
      state.registryClerks.includes(account.id) || account.roles.includes("institution_admin");
    return {
      status: 200,
      body: {
        exports: state.studentDataExports
          .filter((e) => all || e.studentId === account.id)
          .toSorted((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
          .map(({ exportId, state: s, requestedAt, expiresAt }) => ({
            exportId,
            state: s,
            requestedAt,
            expiresAt,
          })),
      },
    };
  },
  // SRV-NF7-IZVOZ-STUDENT: the same reach as the list, only the person and the state.
  "institution.student-data-export-students.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const all =
      state.registryClerks.includes(account.id) || account.roles.includes("institution_admin");
    return {
      status: 200,
      body: {
        exports: state.studentDataExports
          .filter((e) => all || e.studentId === account.id)
          .toSorted((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
          .map(({ exportId, studentId, state: s }) => ({ exportId, studentId, state: s })),
      },
    };
  },
  "institution.student-data-exports.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!state.registryClerks.includes(account.id) || account.roles.includes("institution_admin")) {
      return { error: "forbidden" };
    }
    const studentId = body.studentId.toLowerCase();
    if (studentId === account.id) return { error: "forbidden" };
    if (!state.accounts.some((a) => a.id === studentId)) return { error: "not_found" };
    if (state.studentDataExports.some((e) => e.studentId === studentId && OPEN.has(e.state))) {
      return { error: "conflict" };
    }
    const exportId = randomUUID();
    state.studentDataExports.push({
      exportId,
      studentId,
      requestedBy: account.id,
      state: "requested",
      requestedAt: now.toISOString(),
      expiresAt: null,
      tokenHash: null,
    });
    return { status: 201, body: { exportId } };
  },
  "institution.student-data-exports-approve.post": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    if (!UUID.test(params.exportId)) return { error: "not_found" };
    const found = state.studentDataExports.find(
      (e) => e.exportId === params.exportId.toLowerCase(),
    );
    if (found === undefined) return { error: "not_found" };
    if (found.requestedBy === account.id || found.studentId === account.id)
      return { error: "forbidden" };
    if (found.state !== "requested") return { error: "conflict" };
    found.state = "approved";
    return { status: 200, body: { exportId: found.exportId, state: "approved" } };
  },
  "student.data-export.get": ({ state, params, now }) => {
    const hash = studentDataExportTokenHashOf(params.token);
    const found = state.studentDataExports.find((e) => e.tokenHash === hash && e.state === "ready");
    if (
      found === undefined ||
      found.expiresAt === null ||
      Date.parse(found.expiresAt) <= now.getTime()
    ) {
      return { error: "not_allowed" };
    }
    found.state = "downloaded";
    found.tokenHash = null;
    return {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="izvoz-mojih-podataka.zip"',
        "cache-control": "private, no-store",
        "x-content-sha256": createHash("sha256")
          .update(`izvoz-podataka-${found.exportId}`)
          .digest("hex"),
      },
    };
  },
};
