// The port of settings.set_value (DAN-801), DAN-826-1a (contract Ductus#1836
// c.6916711449). Types only: server/roles checks a write against the
// catalogue and calls this port; the adapter over withActor follows in
// DAN-826-2. Defined here, as ActorReader, because database imports no area.

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
