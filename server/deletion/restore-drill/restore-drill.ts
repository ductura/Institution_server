// Restore drill on a synthetic shape (M10.Z1; plan D-272 MQ07, D-273 MQ15).
// Before a restore is opened, the erasure tombstones of the restored database
// must match the signed erasure checkpoint (SRV-1302). If they do not, the
// restore is not opened and nothing from the copy is let through. When it is
// opened, nothing the tombstones record as erased comes back from the copy.
//
// Pure: no I/O, no clock, no database. The caller hands over the restored
// tombstones and the items of the copy. Only an invented (synthetic)
// institution is accepted. Every answer is a closed code; no input value is
// ever put into one.
import {
  readErasureTombstones,
  verifyErasureCheckpoint,
  type ErasureCheckpointProblem,
  type ErasureDataClass,
  type ErasureTombstone,
} from "../erasure-checkpoint.ts";

/** Synthetic institutions of the drill carry this prefix; no real one may. */
export const SYNTHETIC_INSTITUTION_PATTERN = /^5d5d5d5d-0000-4000-8000-[0-9a-f]{12}$/;
/** Upper bound of items of one copy, asked before anything is compared. */
export const MAX_DRILL_COPY_ITEMS = 100_000;

/** One erasable item as the copy holds it. */
export type DrillCopyItem = {
  dataClass: ErasureDataClass;
  subjectId: string;
  contentSha256: string;
};

export type RestoreDrillProblem = ErasureCheckpointProblem | "not_synthetic" | "copy_malformed";

export type RestoreDrillResult =
  | {
      ok: true;
      /** The restore may be opened. */
      restore: "open";
      /** Items of the copy that may come back, in the order of the copy. */
      restored: DrillCopyItem[];
      /** Items of the copy that were erased and so do not come back. */
      withheld: DrillCopyItem[];
    }
  | { ok: false; restore: "closed"; problem: RestoreDrillProblem };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function readCopy(value: unknown): DrillCopyItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_DRILL_COPY_ITEMS) return null;
  const items: DrillCopyItem[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw: unknown = value[index];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const own = raw as Record<string, unknown>;
    const item = {
      dataClass: own.dataClass,
      subjectId: own.subjectId,
      contentSha256: own.contentSha256,
    };
    if (
      item.dataClass !== "access_log" ||
      typeof item.subjectId !== "string" ||
      item.subjectId.length === 0 ||
      item.subjectId.length > 256 ||
      typeof item.contentSha256 !== "string" ||
      !SHA256_HEX.test(item.contentSha256)
    ) {
      return null;
    }
    items.push(item as DrillCopyItem);
  }
  return items;
}

function erasedKey(dataClass: string, subjectId: string): string {
  return `${dataClass}\u0000${subjectId}`;
}

/**
 * Decides whether the restore of a synthetic institution may be opened.
 * `checkpoint` is the signed checkpoint (stored bytes or object), `publicKey`
 * the key that verifies it, `tombstones` those of the restored database in
 * the order the checkpoint was made over, `copy` the erasable items of the
 * copy being restored.
 */
export async function runRestoreDrill(input: {
  institutionId: unknown;
  checkpoint: unknown;
  publicKey: unknown;
  tombstones: unknown;
  copy: unknown;
}): Promise<RestoreDrillResult> {
  const refuse = (problem: RestoreDrillProblem): RestoreDrillResult => ({
    ok: false,
    restore: "closed",
    problem,
  });
  const institutionId = input.institutionId;
  if (
    typeof institutionId !== "string" ||
    !UUID.test(institutionId) ||
    !SYNTHETIC_INSTITUTION_PATTERN.test(institutionId)
  ) {
    return refuse("not_synthetic");
  }
  // Each list is read once into plain objects, so what is verified is what is used.
  const tombstones: ErasureTombstone[] | null = readErasureTombstones(input.tombstones);
  if (tombstones === null) return refuse("records_malformed");
  const copy = readCopy(input.copy);
  if (copy === null) return refuse("copy_malformed");

  const check = await verifyErasureCheckpoint(input.checkpoint, tombstones, input.publicKey);
  if (!check.ok) return refuse(check.problem);
  // The checkpoint must be of this institution, or its tombstones are not ours.
  if (tombstones.some((record) => record.institutionId !== institutionId)) {
    return refuse("institution_mismatch");
  }

  const erased = new Set(tombstones.map((t) => erasedKey(t.dataClass, t.subjectId)));
  const restored: DrillCopyItem[] = [];
  const withheld: DrillCopyItem[] = [];
  for (const item of copy) {
    (erased.has(erasedKey(item.dataClass, item.subjectId)) ? withheld : restored).push(item);
  }
  return { ok: true, restore: "open", restored, withheld };
}
