// Readiness outcomes (S-1E-d, DAN-839-3a; port of Ductus src/server/ready.ts at
// b36c82b): classifyQueue, classifyStorage, signingOutcome and singleFlight.
// A service answer becomes a word of the ready contract only when it is
// recognised exactly; anything else throws an Error with an own `code`. These
// are log-only readiness codes, not AppError (docs/CODE_STYLE.md §8): the core
// (ready.ts) turns a throw into "nedostupno" and keeps only the code. The real
// probes (839-3b) use them.
import { SIGNING_ERRORS, type SigningKeyProvider } from "../external/keys/index.ts";

type Answer = "ok" | "nije_konfigurirano";

const refusal = (code: string): Error => Object.assign(new Error("readiness refused"), { code });

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
export function classifyQueue(row: unknown): Answer {
  let queue: unknown;
  try {
    queue = field(plainRecord(row), "queue");
  } catch {
    throw refusal("QUEUE_WORKER");
  }
  if (queue === "ok" || queue === "nije_konfigurirano") return queue;
  throw refusal("QUEUE_WORKER");
}

/**
 * Storage domains as verifyAll reports them: no domain is not configured,
 * every domain verified is ok, and anything else is a fault.
 */
export function classifyStorage(states: unknown): Answer {
  if (states === "not_configured") return "nije_konfigurirano";
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
  if (values === null) throw refusal("STORAGE_DOMAIN");
  if (values.length === 0) return "nije_konfigurirano";
  if (values.every((state) => state === "verified")) return "ok";
  throw refusal("STORAGE_DOMAIN");
}

const SIGNING_CODES: ReadonlySet<string> = new Set(SIGNING_ERRORS.map((error) => error.code));
const SIGNING_NOT_CONFIGURED = "SIGNING_KEY_NOT_CONFIGURED";

/**
 * Ok when the port gives its public key; a key not configured is
 * "nije_konfigurirano"; another code of the port is thrown as itself, and an
 * unknown shape, code, throw or rejection as SIGNING.
 */
export async function signingOutcome(
  publicKey: SigningKeyProvider["publicVerificationKey"],
): Promise<Answer> {
  let code: unknown;
  try {
    const result = plainRecord(await publicKey());
    if (field(result, "ok") === true) return "ok";
    code =
      field(result, "ok") === false ? field(plainRecord(field(result, "error")), "code") : null;
  } catch {
    code = null;
  }
  if (code === SIGNING_NOT_CONFIGURED) return "nije_konfigurirano";
  throw refusal(typeof code === "string" && SIGNING_CODES.has(code) ? code : "SIGNING");
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
