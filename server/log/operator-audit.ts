import { types } from "node:util";

import { checkEvent } from "./events/index.ts";
import type { LogWriter } from "./writer.ts";

/**
 * The audit trail of operator actions (S-1J.4, DAN-841, part 841-1). An action
 * of an account of kinds 3–5 runs through `audited`, which runs it only when
 * its `admin.action` record passes the catalog, and then hands exactly one
 * record with the outcome to the log service. The record holds the catalog's
 * keys only: who (account kind, institution, request id), what, when and the
 * outcome; nothing else of the actor (an address, a token) is read. The id of
 * the person is left out until the owner decides (contract Ductus#1836).
 *
 * The write is not awaited: a request never waits for the log (writer.ts),
 * and the writer bounds a slow log database itself (S-1K.3-b). `audited`
 * checks no permission; that is server/roles.
 */

export const OPERATOR_AUDIT_ERROR_CODES = Object.freeze(["OPERATOR_AUDIT_REFUSED"] as const);

type AuditError = { readonly code: string; readonly messageKey: string };
export type OperatorActionResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AuditError };

export type OperatorAudit = <T>(
  actor: unknown,
  action: unknown,
  run: () => OperatorActionResult<T> | Promise<OperatorActionResult<T>>,
) => Promise<OperatorActionResult<T>>;

export type OperatorAuditOptions = {
  readonly write: LogWriter;
  /** The clock; a fake one in tests. */
  readonly now: () => Date;
};

const REFUSED = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    code: "OPERATOR_AUDIT_REFUSED",
    messageKey: "operatorAudit.operator_audit_refused",
  }),
});

const ACTOR_KEYS = ["requestId", "accountKind", "institutionId"] as const;
type Actor = Record<(typeof ACTOR_KEYS)[number], string>;

/** The three keys as own string data of a plain object, read without running caller code. */
function readActor(actor: unknown): Actor | undefined {
  if (typeof actor !== "object" || actor === null || types.isProxy(actor)) return undefined;
  const proto: unknown = Object.getPrototypeOf(actor);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const read: Partial<Actor> = {};
  for (const key of ACTOR_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(actor, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    if (typeof descriptor.value !== "string") return undefined;
    read[key] = descriptor.value;
  }
  return read as Actor;
}

/** The clock's time as the catalog writes it, or undefined. */
function timeOf(now: () => Date): string | undefined {
  try {
    const date: unknown = now();
    return types.isDate(date) ? Date.prototype.toISOString.call(date) : undefined;
  } catch {
    return undefined;
  }
}

const recordOf = (actor: Actor, action: string, outcome: string, time: string) => ({
  time,
  event: "admin.action",
  requestId: actor.requestId,
  accountKind: actor.accountKind,
  fields: { action, outcome, institutionId: actor.institutionId },
});

export function createOperatorAudit({ write, now }: OperatorAuditOptions): OperatorAudit {
  return async (actor, action, run) => {
    const who = readActor(actor);
    const started = timeOf(now);
    if (who === undefined || started === undefined || typeof action !== "string") return REFUSED;
    if (!checkEvent(recordOf(who, action, "succeeded", started)).ok) return REFUSED;

    const finish = (outcome: "succeeded" | "failed"): void => {
      // The end time, or the start time when the clock fails meanwhile.
      const record = recordOf(who, action, outcome, timeOf(now) ?? started);
      try {
        Promise.resolve(write(record)).catch(() => undefined);
      } catch {
        // A port that throws loses this record only; the action's answer stands.
      }
    };
    let result: OperatorActionResult<unknown>;
    try {
      result = await run();
    } catch (error) {
      finish("failed");
      throw error;
    }
    const ok = typeof result === "object" && result !== null && result.ok === true;
    finish(ok ? "succeeded" : "failed");
    return result as never;
  };
}
