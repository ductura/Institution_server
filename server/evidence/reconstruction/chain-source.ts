import { isEvidenceDomainId } from "../../domain/index.ts";
import type { WorkerReconstructionQuery } from "./store.ts";

export type ChainSourceFault = "invalid_request" | "invalid_row" | "source_failed";

/** One package whose chain still lacks the checkpoint at its newest due revision. */
export type DuePackage = {
  evidencePackageId: string;
  institutionId: string;
  segmentCount: number;
};

export type DuePackagesResult =
  { status: "found"; packages: DuePackage[] } | { status: "unavailable"; reason: ChainSourceFault };

/** The accepted chain of one package, first accepted first. */
export type PackageChain = {
  /** The head the package recorded: the hash of its newest accepted segment. */
  headSegmentHash: string;
  segmentHashes: string[];
  /** The exact text of revision 0, or `null` when the database holds none. */
  initialDocument: string | null;
};

export type PackageChainResult =
  | { status: "found"; chain: PackageChain }
  /** An unknown package, one of another domain and one with no segment read the same. */
  | { status: "none" }
  | { status: "unavailable"; reason: ChainSourceFault };

/** What the reconstruction worker reads from the database (M3.3, B-12). */
export type WorkerEvidenceChainSource = {
  /** Packages after `afterPackageId` (null: from the start) that are due a checkpoint, by id. */
  listDue(input: {
    interval: number;
    afterPackageId: string | null;
    limit: number;
  }): Promise<DuePackagesResult>;
  readChain(evidencePackageId: string): Promise<PackageChainResult>;
};

// The columns come back under camelCase aliases, so no snake_case name
// reaches this code (CODE_STYLE 9).
const DUE_SQL =
  'SELECT evidence_package_id AS "evidencePackageId", institution_id::text AS "institutionId",' +
  ' segment_count::text AS "segmentCount"' +
  " FROM app.worker_packages_due_checkpoints($1::uuid, $2::integer, $3::text, $4::integer)";
const CHAIN_SQL =
  'SELECT chain_position::text AS "position", segment_hash AS "segmentHash",' +
  ' head_segment_hash AS "headSegmentHash", initial_document AS "initialDocument"' +
  " FROM app.worker_package_chain($1::uuid, $2::text)";

export const MAX_DUE_PACKAGES_PER_READ = 500;
/** A chain longer than this is not read whole: the worker leaves it alone. */
export const MAX_CHAIN_SEGMENTS = 20_000;
const MAX_INTERVAL = 100_000;

const PACKAGE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNT = /^[1-9][0-9]{0,15}$/;

const unavailable = (reason: ChainSourceFault) => ({ status: "unavailable", reason }) as const;
const isPackageId = (value: unknown): value is string =>
  typeof value === "string" && PACKAGE_ID.test(value);
const isHash = (value: unknown): value is string =>
  typeof value === "string" && SHA256_HEX.test(value);
const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const exactKeys = (row: unknown, keys: readonly string[]): row is Record<string, unknown> =>
  typeof row === "object" &&
  row !== null &&
  !Array.isArray(row) &&
  Object.keys(row).length === keys.length &&
  keys.every((key) => Object.hasOwn(row, key));

/**
 * The worker's reads for the reconstruction loop, through
 * `app.worker_packages_due_checkpoints` and `app.worker_package_chain`. The
 * evidence domain is the worker's configuration, never a request field. An
 * answer it cannot take whole (a row of another shape, a chain out of order, a
 * head that is not the last segment) is `unavailable`, never a partial list,
 * and no fault carries driver text, which can hold an id.
 */
export function createWorkerEvidenceChainSource(options: {
  query: WorkerReconstructionQuery;
  evidenceDomainId: string;
}): WorkerEvidenceChainSource {
  const { query, evidenceDomainId } = options;

  return {
    async listDue({ interval, afterPackageId, limit }): Promise<DuePackagesResult> {
      if (
        !isEvidenceDomainId(evidenceDomainId) ||
        !inRange(interval, 1, MAX_INTERVAL) ||
        !inRange(limit, 1, MAX_DUE_PACKAGES_PER_READ) ||
        (afterPackageId !== null && !isPackageId(afterPackageId))
      ) {
        return unavailable("invalid_request");
      }
      let rows: unknown;
      try {
        rows = (await query(DUE_SQL, [evidenceDomainId, interval, afterPackageId, limit]))?.rows;
      } catch {
        return unavailable("source_failed");
      }
      if (!Array.isArray(rows) || rows.length > limit) return unavailable("invalid_row");
      const packages: DuePackage[] = [];
      let previous = afterPackageId;
      for (const row of rows) {
        if (!exactKeys(row, ["evidencePackageId", "institutionId", "segmentCount"]))
          return unavailable("invalid_row");
        const { evidencePackageId, institutionId, segmentCount } = row;
        // Ascending ids after the cursor, so a page always moves forward.
        if (
          !isPackageId(evidencePackageId) ||
          (previous !== null && evidencePackageId <= previous) ||
          typeof institutionId !== "string" ||
          !UUID.test(institutionId) ||
          typeof segmentCount !== "string" ||
          !COUNT.test(segmentCount) ||
          !Number.isSafeInteger(Number(segmentCount)) ||
          Number(segmentCount) < interval
        ) {
          return unavailable("invalid_row");
        }
        previous = evidencePackageId;
        packages.push({ evidencePackageId, institutionId, segmentCount: Number(segmentCount) });
      }
      return { status: "found", packages };
    },

    async readChain(evidencePackageId): Promise<PackageChainResult> {
      if (!isEvidenceDomainId(evidenceDomainId) || !isPackageId(evidencePackageId))
        return unavailable("invalid_request");
      let rows: unknown;
      try {
        rows = (await query(CHAIN_SQL, [evidenceDomainId, evidencePackageId]))?.rows;
      } catch {
        return unavailable("source_failed");
      }
      if (!Array.isArray(rows) || rows.length > MAX_CHAIN_SEGMENTS)
        return unavailable("invalid_row");
      if (rows.length === 0) return { status: "none" };
      const segmentHashes: string[] = [];
      let headSegmentHash: string | null = null;
      let initialDocument: string | null = null;
      for (const [index, row] of rows.entries()) {
        if (!exactKeys(row, ["position", "segmentHash", "headSegmentHash", "initialDocument"]))
          return unavailable("invalid_row");
        if (
          row.position !== String(index + 1) ||
          !isHash(row.segmentHash) ||
          !isHash(row.headSegmentHash) ||
          (row.initialDocument !== null && typeof row.initialDocument !== "string") ||
          // The same on every row of one read: two snapshots are no chain.
          (index > 0 &&
            (row.headSegmentHash !== headSegmentHash || row.initialDocument !== initialDocument))
        ) {
          return unavailable("invalid_row");
        }
        headSegmentHash = row.headSegmentHash;
        initialDocument = row.initialDocument;
        segmentHashes.push(row.segmentHash);
      }
      if (segmentHashes.at(-1) !== headSegmentHash) return unavailable("invalid_row");
      return {
        status: "found",
        chain: { headSegmentHash: headSegmentHash!, segmentHashes, initialDocument },
      };
    },
  };
}
