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

const rateLimit = (name: string, value: number): SettingDefinition =>
  define({
    key: `network.rate_limit_${name}`,
    levels: ["network_security"],
    kind: "integer",
    default: value,
    min: 1,
    max: 100_000,
  });

const threshold = (name: string, value: number, max: number): SettingDefinition =>
  define({
    key: `thresholds.${name}`,
    levels: ["institution"],
    kind: "integer",
    default: value,
    min: 1,
    max,
  });

/**
 * The catalogue. Adding a key changes the vector of settings.catalogue.get,
 * which must equal this list; the release sees it as a patch of the fake
 * server (@ductura/test-fakes, scripts/release/level.ts). The interface
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
  // S-1C.3 (DAN-814, Ductus#1836 c.6908215789): requests per minute of the
  // rate limit (server/traffic/rate-limit.ts), per client IP and per account.
  rateLimit("login_per_ip", 30),
  rateLimit("enroll_per_ip", 60),
  rateLimit("enroll_per_account", 10),
  rateLimit("save_per_ip", 1200),
  rateLimit("save_per_account", 120),
  rateLimit("default_per_ip", 3000),
  rateLimit("default_per_account", 300),
  // S-1G-a (DAN-1012-1, Ductus#2028): backup, the system level of the app
  // admin (D-298). Off by default; the owner turns it on in production (V-6).
  // A copy is daily at the latest (ARCHITECTURE §9) and at most 30 are kept,
  // so a setting can shorten how long a copy holds erased data (D-299) but
  // not lengthen it. Destination and encryption are fixed by BACKEND §4.7,
  // not settings: a setting must not send or keep a copy elsewhere.
  define({ key: "backup.enabled", levels: ["system"], kind: "boolean", default: false }),
  define({
    key: "backup.interval_hours",
    levels: ["system"],
    kind: "integer",
    default: 24,
    min: 1,
    max: 24,
  }),
  define({
    key: "backup.copies",
    levels: ["system"],
    kind: "integer",
    default: 30,
    min: 1,
    max: 30,
  }),
  // DAN-1060-1 (Ductus#2028): the thresholds P-01 to P-04 of Ductus DECISIONS
  // ("Zadane vrijednosti pragova"), settings of the institution that only its
  // administrator writes (D-117, D-265 Q18). P-05 is P-02 and has no key. The
  // defaults are those of the table (30 and 200 are breakAboveMinutes and
  // listedAboveCharacters of the process summary, "above" meaning strictly
  // more); the hard limits are not an owner's decision and may be widened.
  threshold("session_gap_minutes", 30, 240),
  threshold("paste_event_chars", 200, 100_000),
  threshold("teacher_refresh_minutes", 5, 60),
  threshold("short_assignment_hours", 24, 168),
  // C-12; the editor prototype uses these style IDs and defaults to FPZG.
  define({
    key: "citation.style",
    levels: ["institution"],
    kind: "enum",
    default: "fpzg",
    values: ["fpzg", "apa", "chicago", "ieee", "vancouver", "fusnote"],
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
