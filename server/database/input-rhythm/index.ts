// SRV-0910 (Ductus#2052): the database port of the rhythm of typing
// (20261213100300, app.input_rhythm_*). The rhythm is the gaps in milliseconds
// between inputs inside one burst and nothing else: no key, no content. This
// port holds no function that sums, averages or compares gaps, and none that
// returns anything but the stored gaps (a test fails on any derived measure).
// The recording is on by default; the switch is the teacher's, per assignment
// (20261213110100, Daniel 22. 11. 2026.), and holds from the moment of
// switching off; the student only reads its state. Every refusal of access is
// one not_found (C-23).
import type { WithActor } from "../index.ts";

/** The most values the server keeps of one burst; longer bursts are thinned. */
export const RHYTHM_MAX_GAPS_PER_BURST = 130;

type Failure = { readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable" };

export type RhythmBurst = {
  readonly id: string;
  readonly gapsMs: readonly number[];
  readonly recordedAt: string;
};

export type InputRhythm = {
  /** The student owner records a burst; recorded is false while the switch is off. */
  record(
    token: string,
    documentId: string,
    gapsMs: readonly number[],
  ): Promise<{ readonly status: "ok"; readonly recorded: boolean } | Failure>;
  /** The teacher of the assignment switches the recording; answers the new state. */
  setEnabled(
    token: string,
    assignmentId: string,
    enabled: boolean,
  ): Promise<{ readonly status: "ok"; readonly enabled: boolean } | Failure>;
  /** The teacher of the assignment reads the switch. */
  readEnabled(
    token: string,
    assignmentId: string,
  ): Promise<{ readonly status: "ok"; readonly enabled: boolean } | Failure>;
  /** The owner and the readers of a work read the state of the switch of its assignment. */
  state(
    token: string,
    documentId: string,
  ): Promise<{ readonly status: "ok"; readonly enabled: boolean } | Failure>;
  /** The student deletes the recorded rhythm of a work on request. */
  remove(
    token: string,
    documentId: string,
  ): Promise<{ readonly status: "ok"; readonly deleted: number } | Failure>;
  /** The bursts of a work for its owner and readers; none while the switch is off. */
  read(
    token: string,
    documentId: string,
  ): Promise<{ readonly status: "ok"; readonly bursts: readonly RhythmBurst[] } | Failure>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Malformed extends Error {}

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
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function toBurst(row: Record<string, unknown>): RhythmBurst {
  const { id, gaps_ms: gaps, recorded_at: at } = row;
  if (
    typeof id !== "string" ||
    !UUID.test(id) ||
    !Array.isArray(gaps) ||
    gaps.length < 1 ||
    gaps.length > RHYTHM_MAX_GAPS_PER_BURST ||
    !gaps.every((gap) => typeof gap === "number" && Number.isInteger(gap) && gap >= 0) ||
    !(at instanceof Date)
  ) {
    throw new Malformed();
  }
  return { id, gapsMs: gaps as number[], recordedAt: at.toISOString() };
}

export function createInputRhythm(withActor: WithActor): InputRhythm {
  async function oneBoolean(
    token: string,
    text: string,
    values: readonly unknown[],
  ): Promise<{ readonly status: "ok"; readonly enabled: boolean } | Failure> {
    try {
      return await withActor(token, async (tx) => {
        const rows = (await tx.query<Record<string, unknown>>(text, [...values])).rows;
        const enabled = rows[0]?.enabled;
        if (rows.length !== 1 || typeof enabled !== "boolean") throw new Malformed();
        return { status: "ok" as const, enabled };
      });
    } catch (thrown) {
      return failureOf(thrown);
    }
  }
  return {
    async record(token, documentId, gapsMs) {
      try {
        return await withActor(token, async (tx) => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              "SELECT app.input_rhythm_record($1, $2::integer[]) AS recorded",
              [documentId, [...gapsMs]],
            )
          ).rows;
          const recorded = rows[0]?.recorded;
          if (rows.length !== 1 || typeof recorded !== "boolean") throw new Malformed();
          return { status: "ok" as const, recorded };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
    setEnabled: (token, assignmentId, enabled) =>
      oneBoolean(token, "SELECT app.input_rhythm_switch($1, $2) AS enabled", [
        assignmentId,
        enabled,
      ]),
    readEnabled: (token, assignmentId) =>
      oneBoolean(token, "SELECT app.input_rhythm_switch_read($1) AS enabled", [assignmentId]),
    state: (token, documentId) =>
      oneBoolean(token, "SELECT app.input_rhythm_state($1) AS enabled", [documentId]),
    async remove(token, documentId) {
      try {
        return await withActor(token, async (tx) => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              "SELECT app.input_rhythm_delete($1) AS deleted",
              [documentId],
            )
          ).rows;
          const deleted = rows[0]?.deleted;
          if (rows.length !== 1 || typeof deleted !== "number") throw new Malformed();
          return { status: "ok" as const, deleted };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
    async read(token, documentId) {
      try {
        return await withActor(token, async (tx) => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              "SELECT id::text AS id, gaps_ms, recorded_at FROM app.input_rhythm_read($1)",
              [documentId],
            )
          ).rows;
          return { status: "ok" as const, bursts: rows.map(toBurst) };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
  };
}
