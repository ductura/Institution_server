// The port of settings.set_value (DAN-801), DAN-826-1a (contract Ductus#1836
// c.6916711449): server/roles checks a write against the catalogue and calls
// this port; the adapter over withActor is below (DAN-826-2a). Defined here,
// as ActorReader, because database imports no area.
import { count } from "./open-work.ts";
import type { WithActor } from "./with-actor.ts";

/** A level of settings.value, lowest first. */
export type SettingWriteLevel =
  "personal" | "course" | "institution" | "system" | "network_security";
export type SettingWriteValue = boolean | number | string;
/** The bound as settings.value.bound holds it. */
export type SettingWriteBound = { locked: true } | { min?: number; max?: number };

/** One write, already checked against the catalogue; value and bound null remove the row. */
export type SettingWriteInput = {
  readonly level: SettingWriteLevel;
  /** The course id for the course level, null for every other. */
  readonly course: string | null;
  readonly key: string;
  readonly value: SettingWriteValue | null;
  readonly bound: SettingWriteBound | null;
};

export type SettingsWriteOutcome =
  | {
      readonly status: "saved";
      readonly key: string;
      readonly value: SettingWriteValue | null;
      readonly bound: SettingWriteBound | null;
      /** False when the row already held it. */
      readonly changed: boolean;
    }
  /** No live session (ZD401). */
  | { readonly status: "unauthenticated" }
  /** A level or course that is not the caller's, or does not exist (ZD403; C-23). */
  | { readonly status: "not_found" }
  /** A higher bound is crossed (ZD409). */
  | { readonly status: "bound_crossed" }
  /** The database refused the shape (ZD422). */
  | { readonly status: "invalid" }
  /** The reason is a closed code for the server's own record, never for the answer. */
  | { readonly status: "unavailable"; readonly reason: string };

/** One call is one withActor transaction of settings.set_value. */
export type SettingsWriter = {
  setValue(token: string, write: SettingWriteInput): Promise<SettingsWriteOutcome>;
};

// DAN-826-2a (contract Ductus#1836 c.6935304942): the adapter. One write is
// one withActor transaction of one statement; the table is never written
// directly. The database's own refusals become outcomes; every other error is
// thrown again, so the caller records it and nothing hides a fault.
const SET_SQL = "SELECT settings.set_value($1, $2::uuid, $3, $4::jsonb, $5::jsonb) AS change";

const REFUSED: ReadonlyMap<unknown, SettingsWriteOutcome> = new Map([
  ["ZD401", { status: "unauthenticated" }],
  ["ZD403", { status: "not_found" }],
  ["ZD409", { status: "bound_crossed" }],
  ["ZD422", { status: "invalid" }],
]);
const MALFORMED: SettingsWriteOutcome = { status: "unavailable", reason: "set_malformed" };

/** JSON text for a jsonb parameter, or SQL NULL. */
const jsonb = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

export function createSettingsWriter(withActor: WithActor): SettingsWriter {
  return {
    async setValue(token, write) {
      const { level, course, key, value, bound } = write;
      let rows: Record<string, unknown>[];
      try {
        rows = await withActor(token, async (tx) => {
          const params = [level, course, key, jsonb(value), jsonb(bound)];
          return (await tx.query<Record<string, unknown>>(SET_SQL, params)).rows;
        });
      } catch (error) {
        // Only the code is read; the message never leaves this folder.
        const code = (error as { code?: unknown } | null)?.code;
        const refused = typeof code === "string" ? REFUSED.get(code) : undefined;
        if (refused === undefined) throw error;
        return refused;
      }
      const row = rows.length === 1 ? rows[0] : undefined;
      if (row === undefined || !("change" in row)) return MALFORMED;
      const id = row.change;
      if (id !== null && count(id) === null) return MALFORMED;
      return { status: "saved", key, value, bound, changed: id !== null };
    },
  };
}
