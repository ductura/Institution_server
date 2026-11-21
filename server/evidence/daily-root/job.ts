// SRV-1311 (plan M3.9, B5): the scheduled job of the daily root. Once a day,
// for the slot that starts at midnight UTC, it reads the evidence log entries
// of the day before through the reader port, computes their Merkle root,
// signs { day, root, count, keyId } with the key port and stores the record
// through the storage port. A day with no entries gives a record with
// count 0 and the root of the empty tree; it is not an error.
//
// The day is the slot's, never the clock's, so a second run of one slot
// gives the same record and the store answers `existing`. A second, different
// record for a day already stored is `conflict` and fails the job: the record
// of a day is never overwritten.
//
// The job registers itself through the schedule's registerScheduledJob (SRV-1303).
// As in server/session/purge-ended, the types below are the shapes of the
// schedule's, written out here: no production file outside the queue folder
// may name it (server/database/registry-boundary.test.ts).
import {
  canonicalizeJcs,
  type PublicVerificationKey,
  type Result,
  type SignatureEnvelope,
} from "../../domain/index.ts";
import type { EvidencePayloadStore } from "../../external/storage/index.ts";

import {
  DAY_MS,
  dailyRootPayload,
  dailyRootPublicKey,
  dailyRootSigningInput,
  dayOf,
  dayStart,
  encodeDailyRoot,
  entriesOnDay,
  MAX_KEY_ID_LENGTH,
  readDailyRootEntries,
  sha256Hex,
  verifyDailyRoot,
  DAILY_ROOT_FORMAT,
  type DailyRootEntry,
  type DailyRootRecord,
} from "./daily-root.ts";

export const DAILY_ROOT_JOB = "evidence_daily_root";
/** One slot a day, from midnight UTC. */
export const DAILY_ROOT_EVERY_MS = DAY_MS;
/** The object group of daily roots in the store: `v2/<institution>/evidence-daily-root/<sha256>.json`. */
export const DAILY_ROOT_OBJECT_GROUP = "evidence-daily-root";

/**
 * The reader port: the evidence log entries accepted in [from, to), in any
 * order. The worker's composition root gives the database adapter; tests give
 * fakes. What it returns is read and checked here, never trusted.
 */
export type DailyRootEntriesReader = (
  from: Date,
  to: Date,
  signal: AbortSignal,
) => Promise<unknown>;

/** The part of the signing port (SigningKeyProvider of external/keys) the job needs. */
export type DailyRootSigner = {
  sign(message: Uint8Array): Promise<Result<SignatureEnvelope>>;
  publicVerificationKey(): Promise<Result<PublicVerificationKey>>;
};

export type DailyRootBuildProblem =
  | "day_invalid"
  | "entries_malformed"
  | "entry_outside_day"
  | "signing_unavailable"
  | "signer_not_ed25519"
  | "self_check_failed"
  | "daily_root_conflict"
  | "storage_invalid"
  | "storage_unavailable";

/** A failure of the job by a closed code; the schedule stores the code as the job's outcome. */
export class DailyRootError extends Error {
  readonly code: DailyRootBuildProblem;
  constructor(code: DailyRootBuildProblem) {
    super(code);
    this.name = "DailyRootError";
    this.code = code;
  }
}

export type StoredDailyRoot = {
  record: DailyRootRecord;
  bytes: Uint8Array<ArrayBuffer>;
  storageRef: string;
  stored: "stored" | "existing";
};

export type DailyRootDeps = {
  institutionId: string;
  readEntries: DailyRootEntriesReader;
  signer: DailyRootSigner;
  store: Pick<EvidencePayloadStore, "putImmutable">;
  /**
   * Turns a closed code into the error the job throws. The composition root
   * passes `(code) => new ScheduledJobError(code)`, so the schedule records the
   * code itself; by default a DailyRootError.
   */
  fail?: (code: DailyRootBuildProblem) => Error;
};

/** The shape of the schedule's ScheduledJobDefinition. */
export type DailyRootJob = {
  readonly name: string;
  readonly mode: "execute" | "dry-run";
  readonly everyMs: number;
  readonly candidates: (slot: Date, signal: AbortSignal) => Promise<number>;
  readonly execute: (slot: Date, signal: AbortSignal) => Promise<number>;
};

/** The shape of the schedule's registerScheduledJob. */
export type RegisterJob = (definition: DailyRootJob) => void;

/** The UTC day the slot that starts at `slot` closes: the day before it. */
export function dailyRootDay(slot: Date): string | null {
  const time = slot.getTime();
  if (!Number.isFinite(time) || time % DAY_MS !== 0 || time < DAY_MS) return null;
  return dayOf(time - DAY_MS);
}

/** The object key of a day: one object per day and institution, never overwritten. */
export function dailyRootObjectHash(day: string): string {
  return sha256Hex(`${DAILY_ROOT_FORMAT}\n${day}`);
}

export type DailyRootService = {
  /** Reads, checks and orders the entries of `day`. */
  entriesOf(day: string, signal: AbortSignal): Promise<DailyRootEntry[]>;
  /** Builds, self-checks, signs and stores the record of `day`. */
  build(day: string, signal: AbortSignal): Promise<StoredDailyRoot>;
};

export function createDailyRootService(deps: DailyRootDeps): DailyRootService {
  const fail = (code: DailyRootBuildProblem): Error =>
    deps.fail ? deps.fail(code) : new DailyRootError(code);

  async function entriesOf(day: string, signal: AbortSignal): Promise<DailyRootEntry[]> {
    const start = dayStart(day);
    if (start === null) throw fail("day_invalid");
    const raw = await deps.readEntries(new Date(start), new Date(start + DAY_MS), signal);
    const entries = readDailyRootEntries(raw);
    if (entries === null) throw fail("entries_malformed");
    if (!entriesOnDay(entries, day)) throw fail("entry_outside_day");
    return entries;
  }

  async function build(day: string, signal: AbortSignal): Promise<StoredDailyRoot> {
    const entries = await entriesOf(day, signal);
    const key = await deps.signer.publicVerificationKey();
    if (!key.ok) throw fail("signing_unavailable");
    if (key.value.algorithm !== "Ed25519" || key.value.encoding !== "spki-der")
      throw fail("signer_not_ed25519");
    const keyId = key.value.keyId;
    if (keyId.length === 0 || keyId.length > MAX_KEY_ID_LENGTH) throw fail("signer_not_ed25519");

    const payload = await dailyRootPayload(day, entries, keyId);
    const signed = await deps.signer.sign(dailyRootSigningInput(payload));
    if (!signed.ok) throw fail("signing_unavailable");
    if (signed.value.algorithm !== "Ed25519" || signed.value.signatureEncoding !== "raw")
      throw fail("signer_not_ed25519");
    if (signed.value.keyId !== keyId) throw fail("self_check_failed");
    const record: DailyRootRecord = { ...payload, signature: signed.value.signatureBase64Url };
    const bytes = encodeDailyRoot(record);

    // A record is stored only once the key the port names verifies it over
    // the same entries: a wrong key or a broken signer stores nothing.
    const publicKey = dailyRootPublicKey(Buffer.from(key.value.keyBase64Url, "base64url"));
    const check = await verifyDailyRoot(bytes, entries, publicKey);
    if (!check.ok) throw fail("self_check_failed");

    const put = await deps.store.putImmutable({
      institutionId: deps.institutionId,
      evidencePackageId: DAILY_ROOT_OBJECT_GROUP,
      segmentHash: dailyRootObjectHash(day),
      canonicalPayload: canonicalizeJcs(record),
    });
    switch (put.status) {
      case "stored":
      case "existing":
        return { record, bytes, storageRef: put.storageRef, stored: put.status };
      case "conflict":
        throw fail("daily_root_conflict");
      case "invalid":
        throw fail("storage_invalid");
      case "unavailable":
        throw fail("storage_unavailable");
    }
  }

  return { entriesOf, build };
}

/**
 * The job definition. `candidates` (the dry run) counts the entries of the
 * day and signs and stores nothing; `execute` stores the record and returns
 * its count. The job asks to execute; until it is on the schedule's
 * EXECUTE_ALLOWED list the schedule runs it as a dry run.
 */
export function dailyRootJob(deps: DailyRootDeps): DailyRootJob {
  const service = createDailyRootService(deps);
  const dayOfSlot = (slot: Date): string => {
    const day = dailyRootDay(slot);
    if (day === null)
      throw deps.fail ? deps.fail("day_invalid") : new DailyRootError("day_invalid");
    return day;
  };
  return Object.freeze({
    name: DAILY_ROOT_JOB,
    mode: "execute",
    everyMs: DAILY_ROOT_EVERY_MS,
    candidates: async (slot: Date, signal: AbortSignal) =>
      (await service.entriesOf(dayOfSlot(slot), signal)).length,
    execute: async (slot: Date, signal: AbortSignal) =>
      (await service.build(dayOfSlot(slot), signal)).record.count,
  });
}

/** Registers the job on the worker's schedule. */
export function registerDailyRoot(register: RegisterJob, deps: DailyRootDeps): void {
  register(dailyRootJob(deps));
}
