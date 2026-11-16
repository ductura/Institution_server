// What the evidence routes do before and while reading a body (DAN-811, VS-1
// narrow cut, step 2; docs/vs1-rute.md "Zaštita prije tijela"). Port of
// Ductus src/server/evidence/ingest-http.ts at 078c780 (readGuardedBody after
// method and origin, which are the router's and pipeline step 7 here, and
// parseClosedObject) for node:http. Every check from the headers comes before
// a single body byte is read.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteContract } from "../contracts/index.ts";
import type { ActorReader } from "../database/index.ts";

import { evidenceSession } from "./evidence-session.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendRouteRefusal } from "./problem.ts";

/** A refusal as the route's contract answers it: {status} and its headers. */
export type EvidenceAnswer = {
  readonly status: number;
  readonly body: { readonly status: string; readonly stage?: string };
  readonly headers?: { readonly "retry-after"?: string };
  /** The body was not read to its end: the connection closes with the answer. */
  readonly close?: true;
};

export type GuardedBody =
  | { readonly ok: true; readonly token: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly answer: EvidenceAnswer };

const refuse = (status: number, code: string): GuardedBody => ({
  ok: false,
  answer: { status, body: { status: code }, close: true },
});

/** The one value of a header sent exactly once; a repeated header is no value. */
function single(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

/**
 * `ductus-protocol` exactly once and one of `protocols` (426), Content-Type
 * exactly once and application/json (415), the session cookie (#100: 401, or
 * 503 context), then the body as raw bytes under `maxBytes` (413) and
 * `timeoutMs` (408, 400). The body is never decoded here.
 */
export async function readEvidenceBody(
  request: IncomingMessage,
  actors: ActorReader,
  limits: {
    readonly protocols: readonly string[];
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly live: boolean;
  },
): Promise<GuardedBody> {
  const protocol = single(request, "ductus-protocol");
  if (protocol === undefined || !limits.protocols.includes(protocol)) {
    return refuse(426, "upgrade_required");
  }
  const type = single(request, "content-type");
  if (type?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return refuse(415, "unsupported_media_type");
  }
  const session = await evidenceSession(request, actors, limits);
  if (!session.ok) {
    const retry = session.headers["retry-after"];
    return {
      ok: false,
      answer: {
        status: session.status,
        body: session.body,
        headers: retry ? { "retry-after": retry } : {},
        close: true,
      },
    };
  }
  const body = await readBodyWithLimit(request, limits.maxBytes, limits.timeoutMs);
  if (!body.ok) {
    const code =
      body.status === 413 ? "too_large" : body.status === 408 ? "timeout" : "bad_request";
    return refuse(body.status, code);
  }
  return { ok: true, token: session.token, bytes: body.bytes };
}

/**
 * Answers a refusal of an evidence route as its contract has it ({status},
 * sendRouteRefusal). When the body was left unread the connection closes, so
 * its rest is never parsed as another request (as refuse() does).
 */
export function sendEvidenceAnswer(
  response: ServerResponse,
  contract: RouteContract,
  answer: EvidenceAnswer,
): void {
  if (answer.close === true && !response.headersSent) response.setHeader("Connection", "close");
  sendRouteRefusal(response, contract, answer.status, answer.body, answer.headers);
}

/**
 * A JSON object with exactly the given keys, from strict UTF-8: a byte order
 * mark stays a character and fails the parse. Anything else is null.
 */
export function parseClosedObject(
  bytes: Uint8Array,
  keys: readonly string[],
): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) return null;
  return value as Record<string, unknown>;
}
