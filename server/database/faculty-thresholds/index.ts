// SRV-1111 (Ductus#2052; P-1, rule 12): the database port of the thresholds of a
// faculty per kind of origin and of the comparison of a work with them
// (20261213100400: app.origin_thresholds_read, app.origin_thresholds_put,
// app.work_origin_threshold_status). One withActor transaction over one RPC,
// which decides who may: the administrator of the institution reads and writes
// the thresholds (ZD403 otherwise), the owner of a work and its readers read
// the comparison (ZD403 for everyone else, also for an unknown work). ZD401 is
// unauthenticated, ZD422 invalid, anything else unavailable. A row of an
// unexpected shape is unavailable too. There are no default thresholds and this
// port returns no share: only the three words of the comparison.
import type { WithActor } from "../index.ts";

export const THRESHOLD_ORIGINS = [
  "typed",
  "assistant_inserted",
  "assistant_match",
  "imported_file",
  "pasted_known",
  "pasted_unknown",
] as const;
export type ThresholdOrigin = (typeof THRESHOLD_ORIGINS)[number];
export type ThresholdStrictness = "hard" | "soft";
export type ThresholdState = "in_line" | "for_review" | "exceeded";

export type Threshold = {
  readonly origin: ThresholdOrigin;
  readonly thresholdPercent: number;
  readonly strictness: ThresholdStrictness;
};
export type ThresholdComparison = {
  readonly origin: ThresholdOrigin;
  readonly state: ThresholdState;
};

type Failure = {
  readonly status: "unauthenticated" | "forbidden" | "invalid" | "unavailable";
};
export type ThresholdsReadOutcome =
  { readonly status: "ok"; readonly thresholds: readonly Threshold[] } | Failure;
export type ThresholdWriteOutcome = { readonly status: "ok"; readonly changed: boolean } | Failure;
export type ThresholdComparisonOutcome =
  { readonly status: "ok"; readonly comparison: readonly ThresholdComparison[] } | Failure;

export type FacultyThresholds = {
  /** An administrator reads the thresholds written so far, in the order of the kinds. */
  read(token: string): Promise<ThresholdsReadOutcome>;
  /** An administrator sets the threshold of one kind; changed is false when it held exactly this. */
  put(token: string, threshold: Threshold): Promise<ThresholdWriteOutcome>;
  /** An administrator removes the threshold of one kind; changed is false when there was none. */
  clear(token: string, origin: ThresholdOrigin): Promise<ThresholdWriteOutcome>;
  /** The owner of the work or a reader of it: the state per kind that has a threshold. */
  compare(token: string, documentId: string): Promise<ThresholdComparisonOutcome>;
};

class Malformed extends Error {}

const STATES: readonly string[] = ["in_line", "for_review", "exceeded"];

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function failureOf(thrown: unknown): Failure {
  if (thrown instanceof Malformed) return { status: "unavailable" };
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "forbidden" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

/** The rows come in the order of the list, each kind at most once. */
function inOrder(origins: readonly ThresholdOrigin[]): void {
  let last = -1;
  for (const origin of origins) {
    const at = THRESHOLD_ORIGINS.indexOf(origin);
    if (at <= last) throw new Malformed();
    last = at;
  }
}

function originOf(value: unknown): ThresholdOrigin {
  const found = THRESHOLD_ORIGINS.find((origin) => origin === value);
  if (found === undefined) throw new Malformed();
  return found;
}

function toThresholds(rows: readonly Record<string, unknown>[]): Threshold[] {
  const thresholds = rows.map((row): Threshold => {
    const percent =
      typeof row.thresholdPercent === "string"
        ? Number(row.thresholdPercent)
        : row.thresholdPercent;
    if (
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 100 ||
      (row.strictness !== "hard" && row.strictness !== "soft")
    ) {
      throw new Malformed();
    }
    return { origin: originOf(row.kind), thresholdPercent: percent, strictness: row.strictness };
  });
  inOrder(thresholds.map((threshold) => threshold.origin));
  return thresholds;
}

function toComparison(rows: readonly Record<string, unknown>[]): ThresholdComparison[] {
  const comparison = rows.map((row): ThresholdComparison => {
    const state = STATES.find((candidate) => candidate === row.status);
    if (state === undefined) throw new Malformed();
    return { origin: originOf(row.kind), state: state as ThresholdState };
  });
  inOrder(comparison.map((entry) => entry.origin));
  return comparison;
}

export function createFacultyThresholds(withActor: WithActor): FacultyThresholds {
  async function write(
    token: string,
    text: string,
    values: readonly unknown[],
  ): Promise<ThresholdWriteOutcome> {
    try {
      return await withActor(token, async (tx): Promise<ThresholdWriteOutcome> => {
        const rows = (await tx.query<Record<string, unknown>>(text, values)).rows;
        const changed = rows[0]?.changed;
        if (rows.length !== 1 || typeof changed !== "boolean") throw new Malformed();
        return { status: "ok", changed };
      });
    } catch (thrown) {
      return failureOf(thrown);
    }
  }
  return {
    async read(token) {
      try {
        return await withActor(token, async (tx): Promise<ThresholdsReadOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              'SELECT kind, threshold_percent AS "thresholdPercent", strictness FROM app.origin_thresholds_read()',
            )
          ).rows;
          return { status: "ok", thresholds: toThresholds(rows) };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
    async put(token, threshold) {
      return write(token, "SELECT app.origin_threshold_put($1, $2::numeric, $3) AS changed", [
        threshold.origin,
        threshold.thresholdPercent,
        threshold.strictness,
      ]);
    },
    async clear(token, origin) {
      return write(token, "SELECT app.origin_threshold_clear($1) AS changed", [origin]);
    },
    async compare(token, documentId) {
      try {
        return await withActor(token, async (tx): Promise<ThresholdComparisonOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              "SELECT kind, status FROM app.work_origin_threshold_status($1)",
              [documentId],
            )
          ).rows;
          return { status: "ok", comparison: toComparison(rows) };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
  };
}
