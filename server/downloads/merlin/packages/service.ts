// The Merlin package of an assignment (SRV-1110, Val 11, N-18, C-16, D4):
// asking for it builds it, reading its state and downloading it go to the
// database port, which decides access (the teacher who asked, while teaching
// the work), expiry (24 hours after the build) and records every download.
//
// The build runs in the request that claimed the package, under the
// caller's session: the roster of SRV-1109 (which also writes the teacher's
// opening of every work to the access log), then the ZIP, then the store
// with the students the roster covers, so the database can refuse the
// package once the caller may no longer open one of them.
// There is no worker for it yet (open item); the states are those a worker
// would use, so moving the build there changes no contract. A build that
// throws is recorded as failed with a closed code and reported; the same
// request key builds it again.
import type { MerlinPackages, MerlinPackageState } from "../../../database/index.ts";
import type { MerlinLabels, MerlinRosterReader } from "../roster/index.ts";

import { buildMerlinPackageZip } from "./zip.ts";

export type MerlinPackageServiceDeps = {
  readonly packages: Pick<MerlinPackages, "request" | "complete" | "fail" | "status" | "download">;
  readonly roster: MerlinRosterReader;
  readonly labels: MerlinLabels;
};

/** Told about a build that threw; the package is then recorded as failed. */
export type MerlinBuildReport = (error: unknown) => void;

export type MerlinPackageAsk =
  | { readonly status: "accepted"; readonly id: string; readonly state: MerlinPackageState }
  | { readonly status: "unauthorized" | "not_found" | "invalid_input" };

type Refusal = { readonly status: "unauthorized" | "not_found" };

export function createMerlinPackageService(deps: MerlinPackageServiceDeps) {
  const { packages } = deps;

  /** The state as it is now, after another request finished or failed the build first. */
  async function current(token: string, assignmentId: string, id: string) {
    const read = await packages.status(token, assignmentId, id);
    return read.status === "read"
      ? ({ status: "accepted", id, state: read.package.state } as const)
      : read;
  }

  /** Builds the claimed package; the state it ends in, or a refusal. */
  async function build(
    token: string,
    assignmentId: string,
    id: string,
    report: MerlinBuildReport,
  ): Promise<MerlinPackageAsk> {
    let code = "build_failed";
    try {
      const read = await deps.roster(token, assignmentId);
      if (read.status === "unauthorized") return { status: "unauthorized" };
      if (read.status === "read") {
        const zip = buildMerlinPackageZip(read.roster, deps.labels);
        const stored = await packages.complete(
          token,
          assignmentId,
          id,
          zip.bytes,
          zip.sha256,
          read.roster.studentIds,
        );
        if (stored.status === "written") return { status: "accepted", id, state: "ready" };
        if (stored.status !== "not_ready") return stored satisfies Refusal;
        return current(token, assignmentId, id);
      }
      code = "roster_refused";
    } catch (error) {
      report(error);
    }
    const failed = await packages.fail(token, assignmentId, id, code);
    if (failed.status === "written") return { status: "accepted", id, state: "failed" };
    if (failed.status !== "not_ready") return failed satisfies Refusal;
    return current(token, assignmentId, id);
  }

  return {
    /** Ask for the package by request key; a new (or failed) package is built before the answer. */
    async request(
      token: string,
      assignmentId: string,
      requestKey: string,
      report: MerlinBuildReport,
    ): Promise<MerlinPackageAsk> {
      const asked = await packages.request(token, assignmentId, requestKey);
      if (asked.status !== "requested") return asked;
      if (!asked.claimed) return { status: "accepted", id: asked.id, state: asked.state };
      return build(token, assignmentId, asked.id, report);
    },
    status: packages.status,
    download: packages.download,
  };
}

export type MerlinPackageService = ReturnType<typeof createMerlinPackageService>;
