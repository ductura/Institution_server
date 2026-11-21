// The readiness probes of GET /api/v1/ready (SRV-1812, plan M11.3; the wiring
// of S-1E-d DAN-839-3 over the Ductus probes of DAN-585): the main database
// with its migrations, the evidence storage port and the signing port. Each
// answer becomes a word of the ready contract in ready.ts; a failure carries
// only a code of the limited shape, for the log, never a message.
//
// Only the database is required: without it, or before its migrations are
// done, nothing can be served, so the route answers 503. Storage and signing
// are reported, so one shared fault does not take every replica out of
// traffic; the routes that need them answer 503 on their own (DAN-585).
import { createSchemaReadinessReader, type SchemaReadinessReader } from "../database/index.ts";
import type { SigningKeyProvider } from "../external/keys/index.ts";
import { logEvent, type LogEvent } from "../log/index.ts";

import type { Databases } from "./databases.ts";
import { type EvidenceIngestDependencies, STORAGE_NOT_CONFIGURED } from "./evidence-deps.ts";
import { type ReadyCapability, type ReadyReport, createReadyCheck } from "./ready.ts";
import {
  classifyStorage,
  type ReadyAnswer,
  signingOutcome,
  singleFlight,
} from "./ready-outcomes.ts";

/** Each probe's own limit; together they stay inside READY_TIMEOUT_MS (3 s). */
export const CAPABILITY_TIMEOUT_MS = Object.freeze({
  database: 1_500,
  storage: 2_000,
  signing: 1_000,
});

/** The database is reachable but its migrations are not done: running, or never run. */
export const MIGRATIONS_RUNNING = "MIGRATIONS_RUNNING";
export const MIGRATIONS_MISSING = "MIGRATIONS_MISSING";

export type ReadinessDependencies = {
  /** The migration state of the main database (server/database, catalogue only). */
  readonly schema: SchemaReadinessReader;
  /** The evidence storage of this process, as commit and replay use it. */
  readonly payloads: EvidenceIngestDependencies["payloads"];
  /** The signer of this process; only its public key is asked for. */
  readonly signer: Pick<SigningKeyProvider, "publicVerificationKey">;
};

const coded = (code: string): Error => Object.assign(new Error("readiness"), { code });

/** A Result of ready-outcomes as a probe answer: its AppError code is thrown, never a message. */
function unwrap(
  result: { ok: true; value: ReadyAnswer } | { ok: false; error: { code: string } },
): ReadyAnswer {
  if (result.ok) return result.value;
  throw coded(result.error.code);
}

/** The three probes over `deps`; the database probe holds at most one connection (single flight). */
export function readinessCapabilities(deps: ReadinessDependencies): ReadyCapability[] {
  const database = singleFlight(async (): Promise<ReadyAnswer> => {
    const state = await deps.schema();
    if (state.migrated) return "ok";
    throw coded(state.reason === "migrating" ? MIGRATIONS_RUNNING : MIGRATIONS_MISSING);
  });
  return [
    {
      name: "database",
      required: true,
      timeoutMs: CAPABILITY_TIMEOUT_MS.database,
      probe: database,
    },
    {
      name: "storage",
      required: false,
      timeoutMs: CAPABILITY_TIMEOUT_MS.storage,
      probe: async () => {
        const { payloads } = deps;
        if (payloads === STORAGE_NOT_CONFIGURED) return unwrap(classifyStorage("not_configured"));
        const verifyAll = (payloads as { verifyAll?: () => Promise<unknown> }).verifyAll;
        if (typeof verifyAll !== "function") throw coded("STORAGE_DOMAIN");
        return unwrap(classifyStorage(await verifyAll.call(payloads)));
      },
    },
    {
      name: "signing",
      required: false,
      timeoutMs: CAPABILITY_TIMEOUT_MS.signing,
      probe: async () => unwrap(await signingOutcome(() => deps.signer.publicVerificationKey())),
    },
  ];
}

/**
 * Wraps a readiness check so each change of its outcome is logged once, as
 * `ready.changed` with `ready` and the closed codes of the failed
 * capabilities: never a message, an address or a value. A steady state
 * writes nothing, so a load balancer asking every second floods no log.
 */
export function loggedReadyCheck(
  check: () => Promise<ReadyReport>,
  log: LogEvent,
): () => Promise<ReadyReport> {
  let last: string | undefined;
  return async () => {
    const report = await check();
    const codes: Record<string, string> = {};
    for (const [name, code] of Object.entries(report.codes))
      if (code !== undefined) codes[name] = code;
    const key = JSON.stringify([report.ready, codes]);
    if (key !== last) {
      last = key;
      log(report.ready ? "info" : "warn", "ready.changed", { ready: report.ready, codes });
    }
    return report;
  };
}

/** The readiness check of the entry point: the main database, this process's storage and signer. */
export function readinessCheckFor(
  main: Databases["main"],
  deps: Pick<ReadinessDependencies, "payloads" | "signer">,
  log: LogEvent = logEvent,
): () => Promise<ReadyReport> {
  const schema = createSchemaReadinessReader(main.withActor, CAPABILITY_TIMEOUT_MS.database);
  const capabilities = readinessCapabilities({
    schema,
    payloads: deps.payloads,
    signer: deps.signer,
  });
  return loggedReadyCheck(createReadyCheck(capabilities), log);
}
