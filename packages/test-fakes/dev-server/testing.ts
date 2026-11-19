// Helpers of the dev fake server tests: one request without a network, a
// session from the role switch and the contract check of a success answer.
// Test code only; not exported from index.ts.
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { checkVectors, ROUTES } from "../../../server/contracts/index.ts";
import { answerDev, DEV_HANDLERS, type AccountKey, type State } from "./index.ts";

// The one string format of the contracts, as server/contracts/vectors.test.ts registers it.
if (!FormatRegistry.Has("date-time"))
  FormatRegistry.Set(
    "date-time",
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
  );

export type Sent = {
  method?: string;
  query?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

/** One request through answerDev; a JSON body gets its content type. */
export async function send(state: State, path: string, sent: Sent = {}) {
  const body = sent.body === undefined ? "" : JSON.stringify(sent.body);
  const headers: Record<string, string> = { ...sent.headers };
  if (sent.body !== undefined) headers["content-type"] ??= "application/json";
  const answer = await answerDev(state, DEV_HANDLERS, {
    method: sent.method ?? (sent.body === undefined ? "GET" : "POST"),
    url: path + (sent.query ?? ""),
    headers,
    body: Buffer.from(body),
  });
  return { ...answer, json: answer.body === "" ? undefined : (JSON.parse(answer.body) as unknown) };
}

/** A cookie header of a session opened by the role switch. */
export async function signIn(state: State, as: AccountKey): Promise<Record<string, string>> {
  const answer = await send(state, `/__lazni/uloga?kao=${as}`);
  const cookie = [answer.headers["set-cookie"] ?? []].flat()[0] ?? "";
  return { cookie: cookie.split(";")[0] ?? "" };
}

/** Contract problems of one success answer of `route` (empty when it fits). */
export function contractProblems(
  route: string,
  answer: Awaited<ReturnType<typeof send>>,
): string[] {
  const contract = ROUTES.find((r) => r.id === route);
  if (contract === undefined) return [`no route ${route}`];
  const type = answer.headers["content-type"];
  const vector = {
    name: "lazni",
    kind: "success",
    request: {},
    response: {
      status: answer.status,
      ...(typeof type === "string" ? { contentType: type.split(";")[0] } : {}),
      headers: answer.headers,
      ...(answer.json === undefined ? {} : { body: answer.json }),
    },
  };
  return checkVectors([contract], { [route]: { route, vectors: [vector] } }, (s, v) =>
    Value.Check(s, v),
  ).filter((p) => p.startsWith(`${route}: lazni: `) && !p.includes("request "));
}
