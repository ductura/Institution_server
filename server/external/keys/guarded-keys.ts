// Keys behind the outside-service pattern (S-1E-c, DAN-837; server/metrics
// createExternalCaller). `verify` and `publicVerificationKey` are idempotent
// and may be retried within the deadline; `sign` goes once. A failure the
// provider answers itself (access denied, key not found) passes unchanged;
// only transport faults count against availability.
import type { Result } from "../../domain/index.ts";
import type { ExternalCaller, ExternalCallResult } from "../../metrics/index.ts";
import { kmsTransportError } from "./signing-errors.ts";
import type { SigningKeyProvider } from "./signing-key-provider.ts";

const TRANSIENT = new Set(["SIGNING_TIMEOUT", "SIGNING_UNAVAILABLE", "SIGNING_SERVICE_ERROR"]);
const failed = (answer: Result<unknown>): boolean => !answer.ok && TRANSIENT.has(answer.error.code);

function settle<T>(result: ExternalCallResult<Result<T>>): Result<T> {
  if (result.ok) return result.value;
  if (result.answer !== undefined) return result.answer;
  return {
    ok: false,
    error: kmsTransportError(result.failure === "timeout" ? "timeout" : "network"),
  };
}

/** The same provider, each call under `caller` (made with service "keys"). */
export function guardKeys(
  provider: SigningKeyProvider,
  caller: ExternalCaller,
): SigningKeyProvider {
  return {
    sign: async (message) =>
      settle(await caller.call("sign", () => provider.sign(message), { failed })),
    verify: async (message, signature) =>
      settle(
        await caller.call("verify", () => provider.verify(message, signature), {
          failed,
          retry: true,
        }),
      ),
    publicVerificationKey: async () =>
      settle(
        await caller.call("public_key", () => provider.publicVerificationKey(), {
          failed,
          retry: true,
        }),
      ),
  };
}
