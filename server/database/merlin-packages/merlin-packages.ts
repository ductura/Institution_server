// The port of the Merlin package (SRV-1110; migration 20261121107500): the
// teacher of an assignment asks for its package by request key, the builder
// stores the ZIP or a closed failure code, and the one who asked reads its
// state and downloads it. Every write goes through an RPC, never the table;
// the author and institution come only from the session. The database
// computes the fingerprint of the ZIP, decides the expiry (24 hours after the
// build) and records every download in the transaction that reads the bytes.
//
// The input is checked here before the database checks it again. Refusals
// are outcomes, never thrown: ZD401 unauthorized, ZD403 not_found (one answer
// for every refusal, C-23), ZD409 not_ready, ZD410 expired, ZD422
// invalid_input. Anything else is thrown.
import type { WithActor } from "../index.ts";

export const MERLIN_PACKAGE_STATES = ["queued", "ready", "failed", "expired"] as const;
export type MerlinPackageState = (typeof MERLIN_PACKAGE_STATES)[number];

export type MerlinPackageStatus = {
  readonly id: string;
  readonly state: MerlinPackageState;
  /** Set once the package was built, also after its expiry; else null. */
  readonly sha256: string | null;
  readonly byteSize: number | null;
  readonly expiresAt: string | null;
};

type Refusal = { readonly status: "unauthorized" | "not_found" };
export type MerlinPackageRequest =
  | {
      readonly status: "requested";
      readonly id: string;
      readonly state: MerlinPackageState;
      /** The caller must build the package now. */
      readonly claimed: boolean;
    }
  | Refusal
  | { readonly status: "invalid_input" };
export type MerlinPackageWrite =
  | { readonly status: "written"; readonly package: MerlinPackageStatus }
  | Refusal
  | { readonly status: "not_ready" };
export type MerlinPackageRead =
  { readonly status: "read"; readonly package: MerlinPackageStatus } | Refusal;
export type MerlinPackageDownload =
  | { readonly status: "downloaded"; readonly content: Uint8Array; readonly sha256: string }
  | Refusal
  | { readonly status: "not_ready" | "expired" };

const STATUS_FIELDS = 'id, state, sha256, byte_size AS "byteSize", expires_at AS "expiresAt"';
const REQUEST_SQL =
  "SELECT id, state, claimed FROM institution.request_merlin_package($1::uuid, $2::text)";
const COMPLETE_SQL = `SELECT ${STATUS_FIELDS}
  FROM institution.complete_merlin_package($1::uuid, $2::uuid, $3::bytea, $4::uuid[])`;
const FAIL_SQL =
  "SELECT id, state FROM institution.fail_merlin_package($1::uuid, $2::uuid, $3::text)";
const STATUS_SQL = `SELECT ${STATUS_FIELDS} FROM institution.merlin_package_status($1::uuid, $2::uuid)`;
const DOWNLOAD_SQL =
  "SELECT content, sha256 FROM institution.download_merlin_package($1::uuid, $2::uuid)";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/u;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
/** The database refuses more; checked here so a larger ZIP never leaves the process. */
export const MERLIN_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;

type Row = Record<string, unknown>;

const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);
const isState = (value: unknown): value is MerlinPackageState =>
  (MERLIN_PACKAGE_STATES as readonly unknown[]).includes(value);

function statusOf(row: Row | undefined): MerlinPackageStatus {
  if (row === undefined || !isId(row.id) || !isState(row.state)) {
    throw new Error("invalid merlin package row");
  }
  const built = row.state === "ready" || row.state === "expired";
  if (!built) {
    if (row.sha256 !== null || row.byteSize !== null || row.expiresAt !== null) {
      throw new Error("invalid merlin package row");
    }
    return { id: row.id, state: row.state, sha256: null, byteSize: null, expiresAt: null };
  }
  if (
    typeof row.sha256 !== "string" ||
    !SHA256.test(row.sha256) ||
    typeof row.byteSize !== "number" ||
    !Number.isInteger(row.byteSize) ||
    row.byteSize <= 0 ||
    !(row.expiresAt instanceof Date) ||
    !Number.isFinite(row.expiresAt.getTime())
  ) {
    throw new Error("invalid merlin package row");
  }
  return {
    id: row.id,
    state: row.state,
    sha256: row.sha256,
    byteSize: row.byteSize,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function codeOf(error: unknown): unknown {
  try {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function refusalOf(code: unknown): Refusal | undefined {
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  return undefined;
}

const INVALID = new Map([["ZD422", "invalid_input" as const]]);
const NOT_READY = new Map([["ZD409", "not_ready" as const]]);
const NOT_READY_OR_EXPIRED = new Map([
  ["ZD409", "not_ready" as const],
  ["ZD410", "expired" as const],
]);

/** The outcome of a refused call, or throws what is not a refusal. */
function outcomeOf<T extends string>(error: unknown, codes: ReadonlyMap<unknown, T>) {
  const code = codeOf(error);
  const refusal = refusalOf(code);
  if (refusal !== undefined) return refusal;
  const status = codes.get(code);
  if (status !== undefined) return { status };
  throw error;
}

export function createMerlinPackages(withActor: WithActor) {
  return {
    /** Ask for the package of an assignment by request key; the same key is the same package. */
    async request(
      token: string,
      assignmentId: string,
      requestKey: string,
    ): Promise<MerlinPackageRequest> {
      if (!isId(assignmentId)) return { status: "not_found" };
      if (typeof requestKey !== "string" || !REQUEST_KEY.test(requestKey)) {
        return { status: "invalid_input" };
      }
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(REQUEST_SQL, [assignmentId, requestKey]);
          const row = rows[0];
          if (
            rows.length !== 1 ||
            row === undefined ||
            !isId(row.id) ||
            !isState(row.state) ||
            typeof row.claimed !== "boolean" ||
            (row.claimed && row.state !== "queued")
          ) {
            throw new Error("unconfirmed merlin package request");
          }
          return { status: "requested", id: row.id, state: row.state, claimed: row.claimed };
        });
      } catch (error) {
        return outcomeOf(error, INVALID);
      }
    },
    /**
     * Store the ZIP of a queued package with the students whose rows and
     * works it carries (the database refuses one the caller may not open and
     * later refuses the package once the caller may no longer open one of
     * them); the database's fingerprint must be `sha256`, or the write is
     * rolled back and this throws.
     */
    async complete(
      token: string,
      assignmentId: string,
      packageId: string,
      content: Uint8Array,
      sha256: string,
      studentIds: readonly string[],
    ): Promise<MerlinPackageWrite> {
      if (!isId(assignmentId) || !isId(packageId)) return { status: "not_found" };
      if (content.byteLength === 0 || content.byteLength > MERLIN_PACKAGE_MAX_BYTES) {
        throw new Error("merlin package size out of bounds");
      }
      if (!studentIds.every(isId) || new Set(studentIds).size !== studentIds.length) {
        throw new Error("invalid merlin package students");
      }
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(COMPLETE_SQL, [
            assignmentId,
            packageId,
            Buffer.from(content.buffer, content.byteOffset, content.byteLength),
            [...studentIds],
          ]);
          const written = statusOf(rows.length === 1 ? rows[0] : undefined);
          if (
            written.id !== packageId ||
            written.state !== "ready" ||
            written.sha256 !== sha256 ||
            written.byteSize !== content.byteLength
          ) {
            throw new Error("unconfirmed merlin package");
          }
          return { status: "written", package: written };
        });
      } catch (error) {
        return outcomeOf(error, NOT_READY);
      }
    },
    /** Record the closed code of a build that failed. */
    async fail(
      token: string,
      assignmentId: string,
      packageId: string,
      code: string,
    ): Promise<MerlinPackageWrite> {
      if (!isId(assignmentId) || !isId(packageId)) return { status: "not_found" };
      if (!FAILURE_CODE.test(code)) throw new Error("invalid failure code");
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(FAIL_SQL, [assignmentId, packageId, code]);
          const row = rows[0];
          if (rows.length !== 1 || row?.id !== packageId || row.state !== "failed") {
            throw new Error("unconfirmed merlin package failure");
          }
          return {
            status: "written",
            package: {
              id: packageId,
              state: "failed",
              sha256: null,
              byteSize: null,
              expiresAt: null,
            },
          };
        });
      } catch (error) {
        return outcomeOf(error, NOT_READY);
      }
    },
    /** The state of the caller's package. */
    async status(
      token: string,
      assignmentId: string,
      packageId: string,
    ): Promise<MerlinPackageRead> {
      if (!isId(assignmentId) || !isId(packageId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(STATUS_SQL, [assignmentId, packageId]);
          const read = statusOf(rows.length === 1 ? rows[0] : undefined);
          if (read.id !== packageId) throw new Error("invalid merlin package row");
          return { status: "read", package: read };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** The bytes of the caller's ready package; the database records the download. */
    async download(
      token: string,
      assignmentId: string,
      packageId: string,
    ): Promise<MerlinPackageDownload> {
      if (!isId(assignmentId) || !isId(packageId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(DOWNLOAD_SQL, [assignmentId, packageId]);
          const row = rows[0];
          if (
            rows.length !== 1 ||
            row === undefined ||
            !(row.content instanceof Uint8Array) ||
            typeof row.sha256 !== "string" ||
            !SHA256.test(row.sha256)
          ) {
            throw new Error("invalid merlin package download");
          }
          return { status: "downloaded", content: row.content, sha256: row.sha256 };
        });
      } catch (error) {
        return outcomeOf(error, NOT_READY_OR_EXPIRED);
      }
    },
  };
}

export type MerlinPackages = ReturnType<typeof createMerlinPackages>;
