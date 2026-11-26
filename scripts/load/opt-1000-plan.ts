// SRV-OPT-1000 (DAN-895): the matrix of runs and the parameters of the two
// separate loads. Pure data and checks, so the dry run and the tests share
// them. Nothing here starts a process or sends a request.

/** (a) 1000 concurrent writers, (b) 1000 requests a second. */
export const LOADS = ["pisci", "zahtjevi"] as const;
export type Load = (typeof LOADS)[number];

/** Copies of the web process and of the worker per run (1, 2 and 4). */
export const COPY_COUNTS = [1, 2, 4] as const;

export const WRITERS = 1_000;
export const TARGET_RATE = 1_000;
/** Seconds between two saves of one writer (a). */
export const SAVE_GAP_S = [15, 30] as const;
/** Share of the writers that resend a save after a lost connection (a). */
export const RESEND_SHARE = 0.1;
export const DRY_RUN_USERS = 10;

export type RunPlan = {
  load: Load;
  webCopies: number;
  workerCopies: number;
  users: number;
  /** Rate for (b); 0 for (a). */
  rate: number;
  label: string;
};

/** One run per load and copy count: web and worker scale together. */
export function buildMatrix(users: number = WRITERS, rate: number = TARGET_RATE): RunPlan[] {
  if (!Number.isSafeInteger(users) || users < 1 || users > WRITERS)
    throw new RangeError(`users must be 1 to ${WRITERS}`);
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > TARGET_RATE)
    throw new RangeError(`rate must be 1 to ${TARGET_RATE}`);
  return LOADS.flatMap((load) =>
    COPY_COUNTS.map((copies) => ({
      load,
      webCopies: copies,
      workerCopies: copies,
      users,
      rate: load === "zahtjevi" ? rate : 0,
      label: `${load}-w${copies}-r${copies}`,
    })),
  );
}

/** The local dry run: 10 users and a proportionally small rate, one copy. */
export function dryRun(load: Load): RunPlan {
  return {
    load,
    webCopies: 1,
    workerCopies: 1,
    users: DRY_RUN_USERS,
    rate: load === "zahtjevi" ? DRY_RUN_USERS : 0,
    label: `proba-${load}`,
  };
}

/** X-Forwarded-For of writer `index`: a distinct address in 10.0.0.0/8 for every one. */
export function forwardedFor(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 24 - 2)
    throw new RangeError("index out of range");
  const n = index + 1;
  return `10.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/** Seconds the run of (a) may last at most: every gap at its longest plus slack. */
export function maxDurationSeconds(saves: number): number {
  if (!Number.isSafeInteger(saves) || saves < 1) throw new RangeError("saves must be at least 1");
  const [, longest] = SAVE_GAP_S;
  return Math.ceil(longest + saves * longest + (saves + 1) * 30 + 120);
}

/** The id `priprema.ts --pokret` accepts (a-z, 0-9, at most 12) for a run label: the label without dashes, "pisci" as "p" and "zahtjevi" as "z". */
export function preparationId(label: string): string {
  const id = label
    .replace(/^pisci/u, "p")
    .replace(/^zahtjevi/u, "z")
    .replaceAll("-", "");
  if (!/^[a-z0-9]{1,12}$/u.test(id)) throw new RangeError("label has no valid preparation id");
  return id;
}
