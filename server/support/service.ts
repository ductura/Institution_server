// Service of server/support: the problem report (DAN-851-2c2; contract
// Ductus#1836 c.6946151955). Port of the deciding part of Ductus
// handleProblemReport (src/server/support/problem-report-route.ts at 81833ca),
// from decoding the body to the RPC, without a change of logic: the port gets
// only a valid UTF-8, canonical JSON body that parseProblemReport accepts, and
// exactly the parser's value. Size, deadline, Content-Type, origin and the
// token's form stay in the route (DAN-851-2d1); who reports comes only from
// the session token, inside the port's RPC.
import {
  type AppError,
  canonicalizeJcs,
  parseProblemReport,
  type Result,
} from "../domain/index.ts";
import type { ProblemReportStore } from "../database/index.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** The body is not UTF-8 or not JSON at all (Ductus 400 invalid_json). */
export const PROBLEM_REPORT_INVALID_JSON = error(
  "PROBLEM_REPORT_INVALID_JSON",
  "problemReport.invalid_json",
);
/** JSON, but not canonical or not a report of the closed classes (Ductus 422 invalid_input). */
export const PROBLEM_REPORT_INVALID_BODY = error(
  "PROBLEM_REPORT_INVALID_BODY",
  "problemReport.invalid_body",
);
export const SUPPORT_ERRORS: readonly AppError[] = [
  PROBLEM_REPORT_INVALID_JSON,
  PROBLEM_REPORT_INVALID_BODY,
];

export type SupportService = {
  /** Submits the report in `bytes` (the body as received) and answers its reference. */
  submitProblemReport(token: string, bytes: Uint8Array): Promise<Result<string>>;
};

const fail = (e: AppError): { ok: false; error: AppError } => ({ ok: false, error: e });

/** The exact JCS text of the value: a duplicate key or a second spelling is refused. */
function canonical(text: string, value: unknown): boolean {
  try {
    return canonicalizeJcs(value) === text;
  } catch {
    return false;
  }
}

/** The problem report service over the database port; it never throws on input. */
export function createSupportService(deps: { store: ProblemReportStore }): SupportService {
  return {
    async submitProblemReport(token, bytes) {
      let text: string;
      let value: unknown;
      try {
        // A byte order mark stays in the text, so it is refused like any other byte.
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        value = JSON.parse(text);
      } catch {
        return fail(PROBLEM_REPORT_INVALID_JSON);
      }
      const report = canonical(text, value) ? parseProblemReport(value) : null;
      if (report === null) return fail(PROBLEM_REPORT_INVALID_BODY);
      return deps.store.submit(token, report);
    },
  };
}
