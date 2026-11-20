// Helpers of the dev fake server tests: one request without a network, a
// session from the role switch and the contract check of a success answer.
// Test code only; not exported from index.ts.
import { createHash } from "node:crypto";

import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { checkVectors, ROUTES, SHARED_ERRORS } from "../../../server/contracts/index.ts";
import { canonicalizeJcs } from "../../../server/domain/index.ts";
import { loadGoldenVectors } from "../../../server/domain/forensics/golden-vectors/index.ts";
import {
  answerDev,
  DEV_HANDLERS,
  EMPTY_DOCUMENT,
  IDS,
  type AccountKey,
  type State,
} from "./index.ts";

const GOLDEN_SEGMENT = loadGoldenVectors().chain.segments[0]?.segment;

export function evidenceSegment(state: State, eventCount = 1): string {
  const work = state.works[0];
  if (work === undefined || GOLDEN_SEGMENT === undefined)
    throw new Error("missing evidence fixture");
  const head = work.segments.at(-1);
  const hash = createHash("sha256").update(Buffer.from(EMPTY_DOCUMENT, "base64")).digest("hex");
  const sequenceFrom = work.lastSequenceTo + 1;
  const segment = canonicalizeJcs({
    ...GOLDEN_SEGMENT,
    documentId: IDS.document,
    evidenceProfileId: "lazni-profil",
    initialDocumentHash: hash,
    finalDocumentHash: hash,
    predecessorSegmentHash:
      head === undefined ? null : createHash("sha256").update(head).digest("hex"),
    segmentId: `izmisljeni-odsječak-${sequenceFrom}`,
    sequenceFrom,
    sequenceTo: sequenceFrom + eventCount - 1,
    events: GOLDEN_SEGMENT.events.slice(0, eventCount).map((event, index) => ({
      ...event,
      sequence: sequenceFrom + index,
      beforeDocumentHash: hash,
      afterDocumentHash: hash,
    })),
  });
  return Buffer.from(segment).toString("base64");
}

// The one string format of the contracts, as server/contracts/vectors.test.ts registers it.
if (!FormatRegistry.Has("date-time"))
  FormatRegistry.Set(
    "date-time",
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
  );

export type Sent = {
  /** Bytes sent as they are (a form body), instead of JSON. */
  raw?: string | Uint8Array;
  method?: string;
  query?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

/** One request through answerDev; a JSON body gets its content type. */
export async function send(state: State, path: string, sent: Sent = {}) {
  const body = sent.raw ?? (sent.body === undefined ? "" : JSON.stringify(sent.body));
  const headers: Record<string, string> = { ...sent.headers };
  if (sent.body !== undefined) headers["content-type"] ??= "application/json";
  const answer = await answerDev(state, DEV_HANDLERS, {
    method: sent.method ?? (sent.body === undefined && sent.raw === undefined ? "GET" : "POST"),
    url: path + (sent.query ?? ""),
    headers,
    body: typeof body === "string" ? Buffer.from(body) : body,
  });
  // A binary answer is read in Base64, as the vectors write it.
  if (answer.bytes !== undefined)
    return { ...answer, json: Buffer.from(answer.bytes).toString("base64") as unknown };
  const isJson = String(answer.headers["content-type"] ?? "").startsWith("application/json");
  return {
    ...answer,
    json:
      answer.body === "" ? undefined : isJson ? (JSON.parse(answer.body) as unknown) : answer.body,
  };
}

/** A cookie header of a session opened by the role switch. */
export async function signIn(state: State, as: AccountKey): Promise<Record<string, string>> {
  const answer = await send(state, `/__lazni/uloga?kao=${as}`);
  const cookie = [answer.headers["set-cookie"] ?? []].flat()[0] ?? "";
  return { cookie: cookie.split(";")[0] ?? "" };
}

/** Contract problems of one answer of `route` (empty when it fits); an error answer names its `code`. */
export function contractProblems(
  route: string,
  answer: Awaited<ReturnType<typeof send>>,
  code?: string,
): string[] {
  const contract = ROUTES.find((r) => r.id === route);
  if (contract === undefined) return [`no route ${route}`];
  const type = answer.headers["content-type"];
  const vector = {
    name: "lazni",
    kind: code === undefined ? "success" : "error",
    ...(code === undefined ? {} : { code }),
    request: {},
    response: {
      status: answer.status,
      ...(typeof type === "string" ? { contentType: type.split(";")[0] } : {}),
      headers: answer.headers,
      ...(answer.json === undefined ? {} : { body: answer.json }),
    },
  };
  return checkVectors(
    [contract],
    { [route]: { route, vectors: [vector] } },
    (s, v) => Value.Check(s, v),
    SHARED_ERRORS,
  ).filter((p) => p.startsWith(`${route}: lazni: `) && !p.includes("request "));
}
