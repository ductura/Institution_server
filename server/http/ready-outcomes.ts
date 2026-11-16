// Readiness outcomes (S-1E-d, DAN-839-3a; port of Ductus src/server/ready.ts at
// b36c82b): classifyQueue, classifyStorage, signingOutcome and singleFlight.
// A service answer becomes a word of the ready contract only when it is
// recognised exactly; anything else is an expected failure, returned as a
// Result with an AppError (docs/CODE_STYLE.md §8), never thrown. The real
// probes (839-3b) hand the code to the core (ready.ts), which reports
// "nedostupno" with that code and never a message.
import { SIGNING_ERRORS, type SigningKeyProvider } from "../external/keys/index.ts";

// Result and AppError of server/domain, read through the signing port: http
// may not import domain (scripts/lint-rules/area-boundary.ts).
type PortResult = Awaited<ReturnType<SigningKeyProvider["publicVerificationKey"]>>;
type AppError = Extract<PortResult, { ok: false }>["error"];
type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type ReadyAnswer = "ok" | "nije_konfigurirano";

const error = (code: string, messageKey: string): AppError => Object.freeze({ code, messageKey });
/** The worker queue is not there to take jobs, or its row is not recognised. */
export const READY_QUEUE_WORKER = error("QUEUE_WORKER", "ready.queue_worker");
/** A storage domain is not verified, or the states are not recognised. */
export const READY_STORAGE_DOMAIN = error("STORAGE_DOMAIN", "ready.storage_domain");
/** The signing port answered with a shape or code it does not have, or threw. */
export const READY_SIGNING = error("SIGNING", "ready.signing");
/** Every error the outcomes return besides the signing port's own, for the locale test. */
export const READY_ERRORS: readonly AppError[] = [
  READY_QUEUE_WORKER,
  READY_STORAGE_DOMAIN,
  READY_SIGNING,
];

const answer = (value: ReadyAnswer): Result<ReadyAnswer> => ({ ok: true, value });
const failure = (fault: AppError): Result<ReadyAnswer> => ({ ok: false, error: fault });

/** The own data properties of a plain record, or null for anything else. */
function plainRecord(value: unknown): Map<PropertyKey, PropertyDescriptor> | null {
  if (typeof value !== "object" || value === null) return null;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const fields = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(value)) {
    const found = Object.getOwnPropertyDescriptor(value, key);
    if (found === undefined || !("value" in found)) return null;
    fields.set(key, found);
  }
  return fields;
}

const field = (fields: Map<PropertyKey, PropertyDescriptor> | null, key: string): unknown =>
  fields?.get(key)?.value;

/** The worker queue row of the catalogue query: only the two exact words pass. */
export function classifyQueue(row: unknown): Result<ReadyAnswer> {
  let queue: unknown;
  try {
    queue = field(plainRecord(row), "queue");
  } catch {
    return failure(READY_QUEUE_WORKER);
  }
  return queue === "ok" || queue === "nije_konfigurirano"
    ? answer(queue)
    : failure(READY_QUEUE_WORKER);
}

/**
 * Storage domains as verifyAll reports them: no domain is not configured,
 * every domain verified is ok, and anything else is a fault.
 */
export function classifyStorage(states: unknown): Result<ReadyAnswer> {
  if (states === "not_configured") return answer("nije_konfigurirano");
  let values: unknown[] | null;
  try {
    const fields = plainRecord(states);
    values =
      fields === null ||
      [...fields].some(([key, found]) => typeof key !== "string" || found.enumerable !== true)
        ? null
        : [...fields.values()].map((found) => found.value as unknown);
  } catch {
    values = null;
  }
  if (values === null) return failure(READY_STORAGE_DOMAIN);
  if (values.length === 0) return answer("nije_konfigurirano");
  if (values.every((state) => state === "verified")) return answer("ok");
  return failure(READY_STORAGE_DOMAIN);
}

const SIGNING_BY_CODE: ReadonlyMap<string, AppError> = new Map(
  SIGNING_ERRORS.map((fault) => [fault.code, fault]),
);
const SIGNING_NOT_CONFIGURED = "SIGNING_KEY_NOT_CONFIGURED";

/**
 * Ok when the port gives its public key; a key not configured is
 * "nije_konfigurirano"; another code of the port is returned as the port's own
 * AppError (from SIGNING_ERRORS), and an unknown shape, code, throw or
 * rejection as READY_SIGNING. Never throws.
 */
export async function signingOutcome(
  publicKey: SigningKeyProvider["publicVerificationKey"],
): Promise<Result<ReadyAnswer>> {
  let code: unknown;
  try {
    const result = plainRecord(await publicKey());
    if (field(result, "ok") === true) return answer("ok");
    code =
      field(result, "ok") === false ? field(plainRecord(field(result, "error")), "code") : null;
  } catch {
    code = null;
  }
  if (code === SIGNING_NOT_CONFIGURED) return answer("nije_konfigurirano");
  return failure((typeof code === "string" && SIGNING_BY_CODE.get(code)) || READY_SIGNING);
}

/**
 * One call of `fn` at a time: while it is unsettled, later callers get the
 * same promise; once it settles, the next caller starts a new one. A database
 * probe that cannot be cancelled may hold a pool connection until the pool's
 * own query limit; this keeps readiness to one such connection per probe.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= Promise.resolve()
      .then(fn)
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
