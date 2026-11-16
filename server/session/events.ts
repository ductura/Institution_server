// DAN-830-1 (S-1D-b; contract Ductus#1836 c.6917690910): the log events of
// session transitions. Each transition of server/session/state.ts maps to
// exactly one catalog event; `record` checks it against the catalog and hands
// it to the log service, which redacts and stores it (S-1K.3-a). Only the
// request id and account kind of the actor are read, so a token, a cookie or
// an address has no way into the record. The write is not awaited: a route
// never waits for the log, and a log port that fails changes no answer.
import { types } from "node:util";

import { catalogMessageKey, checkEvent, type CatalogResult, type LogWriter } from "../log/index.ts";

import {
  ENDED_REASONS,
  type EndedReason,
  INTERRUPTED_REASONS,
  type InterruptedReason,
} from "./state.ts";

/** A session reaching a state; `in_progress` is no session yet (authn.login_started). */
export type SessionTransition =
  | { readonly to: "active"; readonly secondFactor: boolean }
  | { readonly to: "interrupted"; readonly reason: InterruptedReason }
  | { readonly to: "ended"; readonly reason: EndedReason };

type Mapped = { readonly event: string; readonly field: string; readonly value: string };

const revoked = (reason: string): Mapped => ({
  event: "session.revoked",
  field: "reason",
  value: reason,
});

// A Map, so `__proto__`, `toString` and other inherited names map to nothing.
const EVENTS: ReadonlyMap<string, Mapped> = new Map([
  ["interrupted:idle", { event: "session.expired", field: "reason", value: "idle" }],
  ["ended:expired", { event: "session.expired", field: "reason", value: "absolute" }],
  ...INTERRUPTED_REASONS.filter((r) => r !== "idle").map(
    (r) => [`interrupted:${r}`, revoked(r)] as const,
  ),
  ...ENDED_REASONS.filter((r) => r !== "expired").map((r) => [`ended:${r}`, revoked(r)] as const),
]);

export type SessionEvents = (actor: unknown, transition: unknown) => CatalogResult;

export type SessionEventsOptions = {
  readonly write: LogWriter;
  /** The clock; a fake one in tests. */
  readonly now: () => Date;
};

const refuse = (code: "UNKNOWN_EVENT" | "NOT_A_PLAIN_OBJECT"): CatalogResult =>
  Object.freeze({ ok: false, error: Object.freeze({ code, messageKey: catalogMessageKey(code) }) });

/** Own data properties of a plain object, read without running caller code. */
function ownData(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const read = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key === "string" && descriptor !== undefined && "value" in descriptor) {
      read.set(key, descriptor.value);
    }
  }
  return read;
}

/** The event and fields of a transition: exactly `to` and `reason`, or `to` and `secondFactor`. */
function eventOf(
  transition: unknown,
): { event: string; fields: Record<string, unknown> } | undefined {
  const read = ownData(transition);
  if (read === undefined || Reflect.ownKeys(transition as object).length !== 2) return undefined;
  if (read.get("to") === "active" && read.has("secondFactor")) {
    return { event: "session.created", fields: { secondFactor: read.get("secondFactor") } };
  }
  const to = read.get("to");
  const reason = read.get("reason");
  if (typeof to !== "string" || typeof reason !== "string" || !read.has("reason")) return undefined;
  const mapped = EVENTS.get(`${to}:${reason}`);
  return mapped && { event: mapped.event, fields: { [mapped.field]: mapped.value } };
}

function timeOf(now: () => Date): string | undefined {
  try {
    const date: unknown = now();
    return types.isDate(date) ? Date.prototype.toISOString.call(date) : undefined;
  } catch {
    return undefined;
  }
}

export function createSessionEvents({ write, now }: SessionEventsOptions): SessionEvents {
  return (actor, transition) => {
    const mapped = eventOf(transition);
    if (mapped === undefined) return refuse("UNKNOWN_EVENT");
    const who = ownData(actor);
    if (who === undefined) return refuse("NOT_A_PLAIN_OBJECT");
    const checked = checkEvent({
      time: timeOf(now),
      event: mapped.event,
      requestId: who.get("requestId"),
      accountKind: who.get("accountKind"),
      fields: mapped.fields,
    });
    if (!checked.ok) return checked;
    try {
      Promise.resolve(write(checked.value)).catch(() => undefined);
    } catch {
      // A port that throws loses this record only; the caller's answer stands.
    }
    return checked;
  };
}
