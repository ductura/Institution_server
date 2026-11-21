/**
 * SRV-1304 (plan M10.2 and M10.7, the part without an owner decision): the
 * catalogue of data classes for retention. Each entry names the classes of
 * Ductus docs/privacy/06-klase-podataka.md §2 it covers and its period.
 *
 * Only the sessions have a decided period (30 days after the end, D-273 MQ08),
 * and only they are deleted for real (app.purge_ended_sessions, SRV-1303).
 * Every other period waits for D-30 and is null; a class with a null period
 * is only ever counted (dry run). The type allows "execute" only next to a
 * number of days, so turning a null class into a deletion needs a change of
 * this catalogue, never a flag elsewhere.
 *
 * Hashes and receipts (class 27) are their own class and are never deleted:
 * they prove a submission after its content is gone (D-272 MQ06). They are
 * not counted either.
 */

export const RETENTION_CLASS_KEYS = [
  "sessions",
  "live-state",
  "versions",
  "change-times",
  "access-log",
  "receipts",
] as const;
export type RetentionClassKey = (typeof RETENTION_CLASS_KEYS)[number];

export type RetentionMode = "execute" | "dry-run";

/** A period in days with its mode; a null period is always a dry run. */
export type RetentionPolicy =
  | { readonly retentionDays: null; readonly mode: "dry-run" }
  | { readonly retentionDays: number; readonly mode: RetentionMode };

export type RetentionClass = RetentionPolicy & {
  readonly key: RetentionClassKey;
  /** Message key of the class name; the text is in the client's catalogue. */
  readonly label: string;
  /** Class numbers of docs/privacy/06-klase-podataka.md §2 (Ductus). */
  readonly dataClasses: readonly number[];
  /** False only for the class that is never deleted (hashes and receipts). */
  readonly erasable: boolean;
};

export const RETENTION_CATALOG: readonly RetentionClass[] = Object.freeze([
  {
    key: "sessions",
    label: "retention.sessions",
    dataClasses: [3],
    erasable: true,
    retentionDays: 30,
    mode: "execute",
  },
  {
    key: "live-state",
    label: "retention.liveState",
    dataClasses: [15],
    erasable: true,
    retentionDays: null,
    mode: "dry-run",
  },
  {
    key: "versions",
    label: "retention.versions",
    dataClasses: [13, 14],
    erasable: true,
    retentionDays: null,
    mode: "dry-run",
  },
  {
    key: "change-times",
    label: "retention.changeTimes",
    dataClasses: [22],
    erasable: true,
    retentionDays: null,
    mode: "dry-run",
  },
  {
    key: "access-log",
    label: "retention.accessLog",
    dataClasses: [25],
    erasable: true,
    retentionDays: null,
    mode: "dry-run",
  },
  {
    key: "receipts",
    label: "retention.receipts",
    dataClasses: [27],
    erasable: false,
    retentionDays: null,
    mode: "dry-run",
  },
] satisfies readonly RetentionClass[]);

/**
 * The mode a class runs in. A null period is a dry run whatever the entry
 * says, and so is a class that is never deleted.
 */
export function retentionMode(entry: RetentionClass): RetentionMode {
  if (entry.retentionDays === null || !entry.erasable) return "dry-run";
  return entry.mode;
}

export type RetentionReportEntry = {
  readonly key: RetentionClassKey;
  readonly label: string;
  readonly retentionDays: number | null;
  readonly mode: RetentionMode;
  readonly candidates: number | null;
  readonly lastRunAt: string | null;
};

/**
 * The report of a dry run: every class of the catalogue, in its order, with
 * the count the database gave. A class without a count (no storage of its
 * own yet) and the class that is never deleted have null. A count for a key
 * the catalogue does not know, or one that is not a whole number from 0, is
 * an error rather than a guess. lastRunAt is the time of the last deletion
 * run of the class; none is recorded yet, so it is null.
 */
export function retentionReport(
  counts: ReadonlyMap<string, number | null>,
): readonly RetentionReportEntry[] {
  const known = new Set<string>(RETENTION_CLASS_KEYS);
  for (const [key, count] of counts) {
    if (!known.has(key)) throw new Error("retention: unknown class");
    if (count !== null && !(Number.isSafeInteger(count) && count >= 0)) {
      throw new Error("retention: invalid count");
    }
  }
  return RETENTION_CATALOG.map((entry) => ({
    key: entry.key,
    label: entry.label,
    retentionDays: entry.retentionDays,
    mode: retentionMode(entry),
    candidates: entry.erasable ? (counts.get(entry.key) ?? null) : null,
    lastRunAt: null,
  }));
}
