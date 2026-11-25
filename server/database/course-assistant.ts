// SRV-ASIST-PREKIDAC (Ductus#2055, T4): migration 20261219350000. The switch
// "Asistent uključen" per course, on by default. A teacher of the course sets
// it (app.course_assistant_switch) and reads it (app.course_assistant_switch_read);
// a student of an assignment reads whether the institution has a published cost
// configuration and the course did not switch it off
// (app.my_assistant_available). Who asks comes only from the session token; a
// refusal (ZD403, not_found) is not_found, the same as for a course or an
// assignment that does not exist, and an id that is not a lowercase uuid is
// never sent. A row the port cannot vouch for throws, so the route answers 503.

import type { WithActor } from "./with-actor.ts";

export type CourseAssistantSwitch =
  | { readonly status: "read"; readonly enabled: boolean }
  | { readonly status: "unauthorized" | "not_found" | "invalid_input" };

export type AssistantAvailability =
  | { readonly status: "read"; readonly available: boolean }
  | { readonly status: "unauthorized" | "not_found" };

export type CourseAssistantPort = {
  /** A teacher of the course sets it; the state in force again changes nothing. */
  set(token: string, courseId: string, enabled: boolean): Promise<CourseAssistantSwitch>;
  /** A teacher of the course reads it. */
  read(token: string, courseId: string): Promise<CourseAssistantSwitch>;
  /** A student of the assignment: a published cost configuration and the course's switch on. */
  available(token: string, assignmentId: string): Promise<AssistantAvailability>;
};

const SET_SQL = `SELECT enabled FROM app.course_assistant_switch($1::uuid, $2::boolean)`;
const READ_SQL = `SELECT enabled FROM app.course_assistant_switch_read($1::uuid)`;
const AVAILABLE_SQL = `SELECT outcome, available FROM app.my_assistant_available($1::uuid)`;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Row = { outcome?: unknown; enabled?: unknown; available?: unknown };

function onlyRow(rows: readonly Row[]): Row {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined) throw new Error("Invalid course assistant response");
  return row;
}

function booleanOf(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid course assistant response");
  return value;
}

function refusalOf(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ZD401") return { status: "unauthorized" } as const;
  if (code === "ZD403") return { status: "not_found" } as const;
  if (code === "ZD422") return { status: "invalid_input" } as const;
  return undefined;
}

async function refused<T>(
  run: () => Promise<T>,
): Promise<T | NonNullable<ReturnType<typeof refusalOf>>> {
  try {
    return await run();
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal !== undefined) return refusal;
    throw error;
  }
}

export function createCourseAssistantPort(withActor: WithActor): CourseAssistantPort {
  return {
    async set(token, courseId, enabled) {
      if (!LOWER_UUID.test(courseId)) return { status: "not_found" };
      if (typeof enabled !== "boolean") return { status: "invalid_input" };
      return refused(() =>
        withActor(token, async (tx) => {
          const value = booleanOf(
            onlyRow((await tx.query<Row>(SET_SQL, [courseId, enabled])).rows).enabled,
          );
          // Confirmed inside the transaction, so another answer rolls the write back.
          if (value !== enabled) throw new Error("Unconfirmed course assistant change");
          return { status: "read" as const, enabled: value };
        }),
      );
    },
    async read(token, courseId) {
      if (!LOWER_UUID.test(courseId)) return { status: "not_found" };
      return refused(() =>
        withActor(token, async (tx) => ({
          status: "read" as const,
          enabled: booleanOf(onlyRow((await tx.query<Row>(READ_SQL, [courseId])).rows).enabled),
        })),
      );
    },
    async available(token, assignmentId) {
      if (!LOWER_UUID.test(assignmentId)) return { status: "not_found" };
      const result = await refused(() =>
        withActor(token, async (tx) => {
          const row = onlyRow((await tx.query<Row>(AVAILABLE_SQL, [assignmentId])).rows);
          if (row.outcome === "not_found" && row.available === null)
            return { status: "not_found" as const };
          if (row.outcome !== "found") throw new Error("Invalid course assistant response");
          return { status: "read" as const, available: booleanOf(row.available) };
        }),
      );
      // The function raises no ZD422; one would be a database it cannot vouch for.
      if (result.status === "invalid_input") throw new Error("Invalid course assistant response");
      return result;
    },
  };
}
