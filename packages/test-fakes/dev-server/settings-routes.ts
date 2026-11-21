// Settings and support routes of the dev fake server. The catalogue is the
// contract's own example; values live in memory per level and scope. Only the
// caller's scope is readable: another course or level reads as 404 (C-23).
import { randomBytes } from "node:crypto";

import type { Operations } from "../../contracts/index.ts";
import { successBody } from "./contract.ts";
import type { Handlers } from "./server.ts";
import { teachesCourse, type Account, type State } from "./state.ts";

type Catalogue = Operations["settings.catalogue.get"]["success"]["body"];
type Level = Operations["settings.values.get"]["success"]["body"]["level"];
type Bound = { locked: true } | { min?: number; max?: number } | null;

/** At most this many problem reports per account (an hour in the real server). */
export const MAX_REPORTS = 5;

const catalogue = (): Catalogue => successBody("settings.catalogue.get") as Catalogue;

/** The owner key of a level in the caller's scope, or null when it is not theirs. */
function scope(
  state: State,
  account: Account | null,
  level: Level,
  course: string | null,
): string | null {
  if (account === null) return null;
  if (level === "personal") return course === null ? `personal:-:${account.id}` : null;
  if (level === "course") {
    const found = state.courses.find((c) => c.id === course?.toLowerCase());
    return found !== undefined && teachesCourse(found, account) ? `course:${found.id}:-` : null;
  }
  if (level === "institution" && course === null && account.roles.includes("institution_admin"))
    return "institution:-:-";
  return null;
}

function validValue(key: string, level: Level, value: unknown): boolean {
  const spec = catalogue().keys.find((k) => k.key === key);
  if (spec === undefined || !spec.levels.includes(level)) return false;
  if (value === null) return true;
  if (spec.kind === "boolean") return typeof value === "boolean";
  if (spec.kind === "enum") return typeof value === "string" && (spec.values ?? []).includes(value);
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= (spec.min ?? Number.MIN_SAFE_INTEGER) &&
    value <= (spec.max ?? Number.MAX_SAFE_INTEGER)
  );
}

/** Levels that may hold a bound (server/domain/settings BOUND_LEVELS). */
const BOUND_LEVELS: readonly Level[] = ["institution", "system", "network_security"];

/**
 * The bound checks of checkWriteOf: a bound only at a bound level, a lock or
 * an integer range whose ends fit the key, min <= max, and a value inside it.
 */
function validBound(key: string, level: Level, value: unknown, bound: Bound): boolean {
  if (bound === null) return true;
  if (!BOUND_LEVELS.includes(level)) return false;
  if ("locked" in bound) return true;
  if (catalogue().keys.find((k) => k.key === key)?.kind !== "integer") return false;
  const { min, max } = bound;
  if (![min, max].every((end) => end === undefined || validValue(key, level, end))) return false;
  if (min !== undefined && max !== undefined && min > max) return false;
  return (
    typeof value !== "number" ||
    ((min === undefined || value >= min) && (max === undefined || value <= max))
  );
}

function submitReport({ state, account }: { state: State; account: Account | null }) {
  if (account === null) return { error: "unauthorized" } as const;
  const sent = state.reports.get(account.id) ?? 0;
  if (sent >= MAX_REPORTS) return { error: "too_many_reports" } as const;
  state.reports.set(account.id, sent + 1);
  return {
    status: 201,
    body: { reference: `PR-${randomBytes(5).toString("hex").toUpperCase()}` },
  } as const;
}

export const SETTINGS_HANDLERS: Handlers = {
  "settings.catalogue.get": () => ({ status: 200, body: catalogue() }),
  "settings.values.get": ({ state, account, query }) => {
    const course = query.course ?? null;
    const owner = scope(state, account, query.level, course);
    if (owner === null) return { error: "not_found" };
    const values = [...state.settings]
      .filter(([name]) => name.startsWith(`${owner}:`))
      .map(([name, row]) => ({
        key: name.slice(owner.length + 1),
        value: row.value,
        bound: row.bound,
        updatedAt: row.updatedAt,
      }));
    const inherited = catalogue()
      .keys.filter((k) => k.levels.includes(query.level))
      .map((k) => ({ key: k.key, value: k.default, source: "default" as const, bound: null }));
    return {
      status: 200,
      body: { level: query.level, course: course?.toLowerCase() ?? null, values, inherited },
    };
  },
  "settings.values.put": ({ state, account, body, now }) => {
    if (!validValue(body.key, body.level, body.value)) return { error: "invalid_input" };
    if (body.locked && (body.min !== null || body.max !== null)) return { error: "invalid_input" };
    const bound: Bound = body.locked
      ? { locked: true }
      : body.min === null && body.max === null
        ? null
        : {
            ...(body.min === null ? {} : { min: body.min }),
            ...(body.max === null ? {} : { max: body.max }),
          };
    // The catalogue refuses (422) before the level is checked (404).
    if (!validBound(body.key, body.level, body.value, bound)) return { error: "invalid_input" };
    const owner = scope(state, account, body.level, body.course);
    if (owner === null) return { error: "not_found" };
    const name = `${owner}:${body.key}`;
    const old = state.settings.get(name);
    const changed =
      JSON.stringify([old?.value ?? null, old?.bound ?? null]) !==
      JSON.stringify([body.value, bound]);
    if (body.value === null && bound === null) state.settings.delete(name);
    else state.settings.set(name, { value: body.value, bound, updatedAt: now.toISOString() });
    return { status: 200, body: { key: body.key, value: body.value, bound, changed } };
  },
  "support.problem-report.post": submitReport,
  "support.problem-reports.post": submitReport,
};
