// The one way server/http answers an error (S-1L.3, DAN-789): the problem
// body {code, messageKey, status, requestId} of a contract error, plus the v1
// word `error` (server/contracts, errorBody). Only errors of SERVER_ERRORS are
// answered; a code or status outside it is a programming error and becomes
// 500 internal, so no route can answer a key without a text in locales/.
// The body never carries an error's message, name, stack or SQL.
import type { ServerResponse } from "node:http";

import { type ErrorSpec, INTERNAL, SERVER_ERRORS } from "../contracts/index.ts";

import { writeJson } from "./json.ts";
import { requestIdOf } from "./request-id.ts";

export type Problem = {
  readonly error: string;
  readonly code: string;
  readonly messageKey: string;
  readonly status: number;
  readonly requestId: string;
};

const BY_STATUS_AND_CODE: ReadonlyMap<string, ErrorSpec> = new Map(
  SERVER_ERRORS.map((spec) => [`${spec.status} ${spec.code}`, spec]),
);

/** The contract error for this status and code, or undefined when there is none. */
export function knownError(status: number, code: string): ErrorSpec | undefined {
  return BY_STATUS_AND_CODE.get(`${status} ${code}`);
}

/**
 * The problem body of a contract error; anything unknown gives the body of
 * 500 internal. Built from the contract's own spec, never from the caller's
 * text, so the key and status always match the code.
 */
export function problemOf(status: number, code: string, requestId: string): Problem {
  const spec = knownError(status, code) ?? INTERNAL.error;
  return {
    error: spec.code,
    code: spec.code,
    messageKey: spec.key,
    status: spec.status,
    requestId,
  };
}

/** The problem body for this response, with its request id. */
export function problemFor(response: ServerResponse, status: number, code: string): Problem {
  return problemOf(status, code, requestIdOf(response));
}

/**
 * Answers the contract error for this status and code as a problem body; an
 * unknown pair answers 500 internal instead.
 */
export function sendProblem(
  response: ServerResponse,
  status: number,
  code: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  const problem = problemFor(response, status, code);
  writeJson(response, problem.status, problem, headers);
}
