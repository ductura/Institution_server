// The settings catalogue (S-1J-f, DAN-806): the closed list of keys a
// settings.value row may hold, at which levels, of which kind, with which
// default (D-298, Ductus#1836 c.6906291102). Pure rules, no I/O. The database
// (settings.set_value, DAN-801) still decides who writes and enforces the
// bounds of higher levels; this catalogue decides what a key may hold.
import type { AppError, Result } from "../index.ts";

/** Levels, lowest first, as in settings.value.level. */
export const SETTING_LEVELS = [
  "personal",
  "course",
  "institution",
  "system",
  "network_security",
] as const;
export type SettingLevel = (typeof SETTING_LEVELS)[number];

/** The levels that may set a bound for the levels below (as the database). */
export const BOUND_LEVELS: readonly SettingLevel[] = ["institution", "system", "network_security"];

export type SettingDefinition =
  | {
      readonly key: string;
      readonly levels: readonly SettingLevel[];
      readonly kind: "boolean";
      readonly default: boolean;
    }
  | {
      readonly key: string;
      readonly levels: readonly SettingLevel[];
      readonly kind: "integer";
      readonly default: number;
      readonly min: number;
      readonly max: number;
    }
  | {
      readonly key: string;
      readonly levels: readonly SettingLevel[];
      readonly kind: "enum";
      readonly default: string;
      readonly values: readonly string[];
    };

const define = (definition: SettingDefinition): SettingDefinition =>
  Object.freeze({
    ...definition,
    levels: Object.freeze([...definition.levels]),
    ...(definition.kind === "enum" ? { values: Object.freeze([...definition.values]) } : {}),
  });

/**
 * The catalogue. Adding a key is a minor change of @ductura/contracts (its
 * vector of settings.catalogue.get must equal this list). The interface
 * language is not here: it keeps its own route (profile.interface-locale).
 */
export const SETTINGS_CATALOGUE: readonly SettingDefinition[] = Object.freeze([
  // D-298, personal: notifications.
  define({ key: "notifications.email", levels: ["personal"], kind: "boolean", default: true }),
  // D-298, personal: display.
  define({ key: "display.reduced_motion", levels: ["personal"], kind: "boolean", default: false }),
  // D-298, network and security: session length. 120 is today's idle limit of
  // the database (two hours), so the default changes nothing.
  define({
    key: "network.session_idle_minutes",
    levels: ["network_security"],
    kind: "integer",
    default: 120,
    min: 15,
    max: 120,
  }),
]);

const BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTINGS_CATALOGUE.map((definition) => [definition.key, definition]),
);

/** The definition of a key, or undefined; never an inherited property. */
export function settingOf(key: unknown): SettingDefinition | undefined {
  return typeof key === "string" ? BY_KEY.get(key) : undefined;
}

export type SettingWrite = {
  readonly level: unknown;
  readonly key: unknown;
  readonly value: unknown;
  readonly bound: unknown;
};

const refuse = (code: string): Result<null> => ({
  ok: false,
  error: { code, messageKey: "errors.invalidInput" } satisfies AppError,
});

const isLevel = (level: unknown): level is SettingLevel =>
  typeof level === "string" && (SETTING_LEVELS as readonly string[]).includes(level);

const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" &&
  raw !== null &&
  !Array.isArray(raw) &&
  Object.getPrototypeOf(raw) === Object.prototype;

/** Does a value fit the kind and the hard limits of a definition? */
export function fitsDefinition(definition: SettingDefinition, value: unknown): boolean {
  switch (definition.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        !Object.is(value, -0) &&
        value >= definition.min &&
        value <= definition.max
      );
    case "enum":
      return typeof value === "string" && definition.values.includes(value);
  }
}

/** A bound as the database takes it, and only inside the catalogue's hard limits. */
function fitsBound(definition: SettingDefinition, bound: unknown): boolean {
  if (!isPlainObject(bound)) return false;
  const keys = Object.keys(bound);
  if (keys.length === 1 && keys[0] === "locked") return bound.locked === true;
  if (definition.kind !== "integer" || keys.length === 0) return false;
  if (keys.some((key) => key !== "min" && key !== "max")) return false;
  const ends = keys.map((key) => bound[key]);
  if (!ends.every((end) => fitsDefinition(definition, end))) return false;
  const { min, max } = bound as { min?: number; max?: number };
  return min === undefined || max === undefined || min <= max;
}

/**
 * May this write reach the database at all? `value` and `bound` are the
 * parsed JSON of the request, null for none; both null removes the row.
 * Refusals: SETTING_UNKNOWN_KEY, SETTING_LEVEL_NOT_ALLOWED,
 * SETTING_INVALID_VALUE, SETTING_INVALID_BOUND.
 */
export function checkSettingWrite(write: SettingWrite): Result<null> {
  const definition = settingOf(write.key);
  if (definition === undefined) return refuse("SETTING_UNKNOWN_KEY");
  return checkWriteOf(definition, write);
}

/** checkSettingWrite against a given definition; exported for its tests. */
export function checkWriteOf(definition: SettingDefinition, write: SettingWrite): Result<null> {
  if (!isLevel(write.level) || !definition.levels.includes(write.level))
    return refuse("SETTING_LEVEL_NOT_ALLOWED");
  if (write.value !== null && !fitsDefinition(definition, write.value))
    return refuse("SETTING_INVALID_VALUE");
  if (write.bound !== null) {
    if (!BOUND_LEVELS.includes(write.level) || !fitsBound(definition, write.bound))
      return refuse("SETTING_INVALID_BOUND");
    const { min, max } = write.bound as { min?: number; max?: number };
    if (
      typeof write.value === "number" &&
      ((min !== undefined && write.value < min) || (max !== undefined && write.value > max))
    )
      return refuse("SETTING_INVALID_BOUND");
  }
  return { ok: true, value: null };
}

/**
 * The bound of the database from the flat fields of settings.values.put:
 * locked alone is a lock, min and/or max a range, none of them no bound
 * (null). A lock with an end, or an end that is not an integer, is
 * SETTING_INVALID_BOUND; whether the range fits the key is checkSettingWrite.
 */
export function boundOfFields(fields: {
  readonly locked: unknown;
  readonly min: unknown;
  readonly max: unknown;
}): Result<{ locked: true } | { min?: number; max?: number } | null> {
  const { locked, min, max } = fields;
  const end = (raw: unknown) => raw === null || Number.isSafeInteger(raw);
  if (typeof locked !== "boolean" || !end(min) || !end(max))
    return {
      ok: false,
      error: { code: "SETTING_INVALID_BOUND", messageKey: "errors.invalidInput" },
    };
  if (locked)
    return min === null && max === null
      ? { ok: true, value: { locked: true } }
      : { ok: false, error: { code: "SETTING_INVALID_BOUND", messageKey: "errors.invalidInput" } };
  if (min === null && max === null) return { ok: true, value: null };
  return {
    ok: true,
    value: {
      ...(min === null ? {} : { min: min as number }),
      ...(max === null ? {} : { max: max as number }),
    },
  };
}

/** The default of a key, or undefined for a key outside the catalogue. */
export function defaultOf(key: unknown): boolean | number | string | undefined {
  return settingOf(key)?.default;
}
