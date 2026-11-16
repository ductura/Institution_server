// Storage behind the outside-service pattern (S-1E-c, DAN-837; server/metrics
// createExternalCaller). Reads and HEAD are idempotent and may be retried
// within the deadline; `putImmutable` goes once, as the S3 store expects the
// client to retry. Every failure stays the port's own `unavailable`.
import type { ExternalCaller, ExternalCallResult } from "../../metrics/index.ts";
import type {
  EvidencePayloadPresence,
  EvidencePayloadStore,
  InstitutionEvidencePayloadReader,
} from "./port.ts";

export type GuardableStorage = EvidencePayloadStore &
  InstitutionEvidencePayloadReader &
  EvidencePayloadPresence;

export const STORAGE_TIMEOUT = "storage_timeout";
export const STORAGE_DOWN = "storage_down";

type Unavailable = { status: "unavailable"; reason: string };
const failed = (answer: { status: string }): boolean => answer.status === "unavailable";

function settle<T extends { status: string }>(result: ExternalCallResult<T>): T | Unavailable {
  if (result.ok) return result.value;
  if (result.answer !== undefined) return result.answer;
  const reason =
    result.failure === "timeout"
      ? STORAGE_TIMEOUT
      : result.failure === "down"
        ? STORAGE_DOWN
        : "storage_unavailable";
  return { status: "unavailable", reason };
}

/** The same ports, each call under `caller` (made with service "storage"). */
export function guardStorage(store: GuardableStorage, caller: ExternalCaller): GuardableStorage {
  return {
    putImmutable: async (input) =>
      settle(await caller.call("put", () => store.putImmutable(input), { failed })),
    readImmutable: async (input) =>
      settle(await caller.call("read", () => store.readImmutable(input), { failed, retry: true })),
    headImmutable: async (input) =>
      settle(await caller.call("head", () => store.headImmutable(input), { failed, retry: true })),
  };
}
