import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1110 (Ductus#2051 c.7049370945, Val 11, N-18, C-16, D4): the Merlin
// package of an assignment for its teacher. One ZIP with the roster CSV of
// SRV-1109 (teacher.merlin-roster-csv.get), the PDF and DOCX of every
// submitted work and otisci.sha256 with the SHA-256 of every file in it, all
// from one set of bytes: the fingerprints in the CSV and in otisci.sha256 are
// those of the files the ZIP carries. The same request key is the same
// package. A built package can be downloaded for 24 hours (C-16) by the
// teacher who asked for it, while still teaching the work; every download is
// recorded. Database: institution.request_merlin_package and the functions
// next to it (20261121107500).

/** Lowercase UUID. */
const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const DownloadPath = Type.String({
  pattern: "^/api/v1/teacher/assignments/[0-9a-f-]{36}/merlin/packages/[0-9a-f-]{36}/download$",
});

/** The states of a package; expired is a ready package at or after expiresAt. */
export const MERLIN_PACKAGE_STATES = ["queued", "ready", "failed", "expired"] as const;

const AssignmentParams = closed({ assignmentId: Type.String({ minLength: 1 }) });
const PackageParams = closed({
  assignmentId: Type.String({ minLength: 1 }),
  packageId: Type.String({ minLength: 1 }),
});
const READ_ERRORS = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;
const INVENTORY = "app/api/teacher/assignments/[assignmentId]/merlin/packages";

export const teacherMerlinPackagesPost = defineRoute({
  id: "teacher.merlin-packages.post",
  method: "POST",
  path: "/api/v1/teacher/assignments/{assignmentId}/merlin/packages",
  inventory: `${INVENTORY}/route.ts`,
  access: "course_teacher",
  summary:
    "The teacher of the assignment asks for its Merlin package with a request key of the client's (8 to 128 of A-Z, a-z, 0-9, - and _). A new key makes a package and the server builds it; the same key again answers the same package and never builds a second one (a failed package is built again). The answer follows the build: ready, failed, or queued while another request is building it; expired once 24 hours have passed since the build. An inaccessible, unknown or malformed assignment returns 404.",
  request: {
    params: AssignmentParams,
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ requestKey: Type.String({ pattern: "^[A-Za-z0-9_-]{8,128}$" }) }),
  },
  responses: [
    {
      status: 202,
      description: "the package of this key",
      body: closed({
        id: Uuid,
        state: Type.Union(MERLIN_PACKAGE_STATES.map((state) => Type.Literal(state))),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const teacherMerlinPackageGet = defineRoute({
  id: "teacher.merlin-package.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/merlin/packages/{packageId}",
  inventory: `${INVENTORY}/[packageId]/route.ts`,
  access: "course_teacher",
  summary:
    "The state of a Merlin package the caller asked for, while the caller teaches the assignment. A ready package names its download path, its expiry (24 hours after the build) and the SHA-256 of the ZIP; an expired one its expiry and SHA-256, without a path. A package of another teacher, of another assignment, unknown or malformed returns 404; a cross-site read 403.",
  request: { params: PackageParams },
  responses: [
    {
      status: 200,
      description: "the package",
      body: Type.Union([
        closed({ id: Uuid, state: Type.Union([Type.Literal("queued"), Type.Literal("failed")]) }),
        closed({
          id: Uuid,
          state: Type.Literal("ready"),
          downloadPath: DownloadPath,
          expiresAt: Instant,
          sha256: Sha256,
        }),
        closed({ id: Uuid, state: Type.Literal("expired"), expiresAt: Instant, sha256: Sha256 }),
      ]),
      headers: ["cache-control"],
    },
  ],
  errors: READ_ERRORS,
});

export const teacherMerlinPackageDownloadGet = defineRoute({
  id: "teacher.merlin-package-download.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/merlin/packages/{packageId}/download",
  inventory: `${INVENTORY}/[packageId]/download/route.ts`,
  access: "course_teacher",
  summary:
    "The ZIP of a ready Merlin package as application/zip, for the teacher who asked for it while teaching the assignment, before its expiry; the download is recorded in the same transaction that reads the bytes. The ZIP holds merlin-popis.csv (teacher.merlin-roster-csv.get), the PDF and DOCX of every submitted work under the names the CSV gives, and otisci.sha256 (one line per file: SHA-256, two spaces, name). Content-Disposition names the file merlin-paket.zip; X-Content-SHA256 is the SHA-256 of the ZIP, as teacher.merlin-package.get names it. A package not yet built or failed returns 409, an expired one 410; errors as teacher.merlin-package.get, as JSON.",
  request: { params: PackageParams },
  responses: [
    {
      status: 200,
      description: "ZIP bytes (application/zip); the contract format has no binary body",
      headers: ["content-disposition", "cache-control", "x-content-sha256"],
    },
  ],
  errors: [...READ_ERRORS, error(409, "conflict"), error(410, "not_allowed")],
});

export const merlinPackageRoutes = [
  teacherMerlinPackagesPost,
  teacherMerlinPackageGet,
  teacherMerlinPackageDownloadGet,
] as const;
