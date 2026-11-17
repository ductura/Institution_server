// PUT /api/v1/settings/values (S-1J-g, DAN-826-1b; contract Ductus#1836
// c.6934961046). The handler over the settings write service of server/roles
// (826-1a): media type (415) and session cookie (401) before the body is read,
// the body under the contract's limit (413, 408, 400), strict JSON (400),
// then the service, which refuses what the contract or catalogue does not
// take (422) before the port. Origin is pipeline step 7. The port's adapter
// and the mounting follow in 826-2.
import { ROUTES } from "../contracts/index.ts";
import type { SettingsWriteOutcome, SettingsWriter } from "../database/index.ts";
import { createSettingsService } from "../roles/index.ts";
import { sessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const PUT_ID = "settings.values.put";
const found = ROUTES.find((route) => route.id === PUT_ID);
if (found === undefined) throw new Error(`no contract ${PUT_ID}`);
const contract = found;

export const SETTINGS_PUT_MAX_BYTES = contract.request.maxBodyBytes ?? 1024;
export const SETTINGS_PUT_TIMEOUT_MS = 5_000;

export type SettingsValuesPutOptions = {
  readonly writer: SettingsWriter;
  /** For tests: a shorter body deadline. */
  readonly timeoutMs?: number;
};

/** The contract error of each refusal of the port. */
const REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map([
  ["unauthenticated", [401, "unauthorized"]],
  ["not_found", [404, "not_found"]],
  ["bound_crossed", [409, "bound_crossed"]],
  ["invalid", [422, "invalid_input"]],
]);

/** Content-Type exactly once, media type application/json. */
function isJson(values: readonly string[] | undefined): boolean {
  return (
    values?.length === 1 && values[0]?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

/** Strict UTF-8 (a byte order mark stays a character) and JSON.parse; a duplicate key keeps its last value. */
function parseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createSettingsValuesPutRoute(options: SettingsValuesPutOptions): Route {
  const service = createSettingsService(options.writer);
  const timeoutMs = options.timeoutMs ?? SETTINGS_PUT_TIMEOUT_MS;
  return {
    contract,
    async handle(request, response) {
      // Refusals before the whole body was read close the connection (refuse).
      if (!isJson(request.headersDistinct["content-type"])) {
        return refuse(response, 415, "unsupported_media_type");
      }
      const token = sessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");
      const body = await readBodyWithLimit(request, SETTINGS_PUT_MAX_BYTES, timeoutMs);
      if (!body.ok) return refuse(response, body.status, body.reason);
      const parsed = parseJson(body.bytes);
      if (!parsed.ok) return sendProblem(response, 400, "invalid_json");
      let outcome: SettingsWriteOutcome;
      try {
        const result = await service.put(token, parsed.value);
        if (!result.ok) return sendProblem(response, 422, "invalid_input");
        outcome = result.value;
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
      if (outcome.status === "saved") {
        const { key, value, bound, changed } = outcome;
        return sendJson(response, 200, { key, value, bound, changed });
      }
      const [status, code] = REFUSALS.get(outcome.status) ?? [503, "unavailable"];
      sendProblem(response, status, code);
    },
  };
}
