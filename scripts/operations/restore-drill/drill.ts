// Restore drill on restored infrastructure (M11.2-P04; plan D-277 NQ05). The
// pure check of server/deletion/restore-drill (M10.Z1) says whether a restore
// may open and which erased items stay out. This adds the second half: the
// restored bucket is compared with the restored database. Every item that
// may come back must be in the bucket with the same hash, and nothing the
// tombstones record as erased may be there again.
//
// Pure: no I/O. The caller hands over what it read from the restored database
// and bucket. The target must be local or a test host: this script never
// points at production (migrations and restores there are not done by an
// agent). Every answer is a closed code or a count, never an input value.
import {
  runRestoreDrill,
  type DrillCopyItem,
  type RestoreDrillProblem,
} from "../../../server/deletion/index.ts";

export type DrillProblem =
  RestoreDrillProblem | "target_not_local" | "bucket_malformed" | "bucket_differs";

export type BucketCheck = {
  /** Items that may come back and are not in the restored bucket. */
  missing: number;
  /** Items in the bucket under the same subject with another hash. */
  mismatched: number;
  /** Erased items that are in the restored bucket again. */
  resurrected: number;
};

export type DrillReport =
  | { ok: true; restored: number; withheld: number; bucket: BucketCheck }
  | { ok: false; problem: DrillProblem; bucket?: BucketCheck };

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.(invalid|test|localhost))$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_BUCKET_ITEMS = 200_000;

/** A target the drill may run against: local or a reserved test name only. */
export function isDrillTarget(target: unknown): boolean {
  if (typeof target !== "string" || target.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return LOCAL_HOSTS.test(url.hostname.toLowerCase());
}

function readBucket(value: unknown): DrillCopyItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_BUCKET_ITEMS) return null;
  const items: DrillCopyItem[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const own = raw as Record<string, unknown>;
    if (
      own["dataClass"] !== "access_log" ||
      typeof own["subjectId"] !== "string" ||
      own["subjectId"].length === 0 ||
      own["subjectId"].length > 256 ||
      typeof own["contentSha256"] !== "string" ||
      !SHA256_HEX.test(own["contentSha256"])
    ) {
      return null;
    }
    items.push({
      dataClass: own["dataClass"],
      subjectId: own["subjectId"],
      contentSha256: own["contentSha256"],
    });
  }
  return items;
}

const keyOf = (item: DrillCopyItem): string => `${item.dataClass}\u0000${item.subjectId}`;

export async function runInfrastructureDrill(input: {
  target: unknown;
  institutionId: unknown;
  checkpoint: unknown;
  publicKey: unknown;
  tombstones: unknown;
  /** The erasable items of the restored database. */
  copy: unknown;
  /** The erasable items found in the restored bucket. */
  bucket: unknown;
}): Promise<DrillReport> {
  if (!isDrillTarget(input.target)) return { ok: false, problem: "target_not_local" };
  const bucket = readBucket(input.bucket);
  if (bucket === null) return { ok: false, problem: "bucket_malformed" };
  const drill = await runRestoreDrill(input);
  if (!drill.ok) return { ok: false, problem: drill.problem };

  const inBucket = new Map(bucket.map((item) => [keyOf(item), item.contentSha256]));
  let missing = 0;
  let mismatched = 0;
  for (const item of drill.restored) {
    const found = inBucket.get(keyOf(item));
    if (found === undefined) missing += 1;
    else if (found !== item.contentSha256) mismatched += 1;
  }
  const resurrected = drill.withheld.filter((item) => inBucket.has(keyOf(item))).length;
  const check: BucketCheck = { missing, mismatched, resurrected };
  if (missing + mismatched + resurrected > 0) {
    return { ok: false, problem: "bucket_differs", bucket: check };
  }
  return {
    ok: true,
    restored: drill.restored.length,
    withheld: drill.withheld.length,
    bucket: check,
  };
}
