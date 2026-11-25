// /api/v1/student/qual/materials and /api/v1/student/qual/materials/{id}
// (SRV-V18-KODIRANJE-GRADIVO; contracts student.qual-materials.get and .post,
// student.qual-material.get and .delete): the student's own material for
// qualitative coding, a typed or pasted text. The session decides who asks, the
// database (app.*qual_material* RPCs) whether the material is the caller's:
// another person's, an unknown and a malformed id all read the same 404 (C-23).
// A body outside the contract is 422 before any round trip, and an answer outside
// the contract is 503, never sent. Nothing here calls the assistant.
import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import { createQualitativeCodingStore, type WithActor } from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import { reportServerError } from "./error-catalog.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { parseJson } from "./request-json.ts";
import { type Route, sendJson } from "./router.ts";
import { refuse } from "./security-headers.ts";

const BODY_TIMEOUT_MS = 5_000;

function contractOf(id: string) {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  const success = contract.responses[0];
  return { contract, body: success !== undefined && "body" in success ? success.body : undefined };
}
const LIST = contractOf("student.qual-materials.get");
const CREATE = contractOf("student.qual-materials.post");
const READ = contractOf("student.qual-material.get");
const REMOVE = contractOf("student.qual-material.delete");

/** A GET is same-origin or carries no Sec-Fetch-Site. */
function sameOrigin(headers: { readonly [name: string]: string[] | undefined }): boolean {
  const site = headers["sec-fetch-site"];
  return site === undefined || (site.length === 1 && site[0] === "same-origin");
}

/** The refusals the database gives, as they are on the wire. Anything else is a failure (503). */
function refusalOf(error: unknown): { status: number; code: string } | undefined {
  switch ((error as { code?: unknown } | null)?.code) {
    case "ZD401":
      return { status: 401, code: "unauthorized" };
    case "ZD403":
      return { status: 403, code: "forbidden" };
    case "ZD404":
      return { status: 404, code: "not_found" };
    case "ZD409":
      return { status: 409, code: "conflict" };
    case "ZD422":
      return { status: 422, code: "invalid_input" };
    default:
      return undefined;
  }
}

async function guarded(
  response: ServerResponse,
  id: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal !== undefined) return sendProblem(response, refusal.status, refusal.code);
    reportServerError("route", error, requestIdOf(response), id);
    sendProblem(response, 503, "unavailable");
  }
}

/** The answer is sent only if it is what the contract says. */
function sendChecked(
  response: ServerResponse,
  { contract, body }: ReturnType<typeof contractOf>,
  status: number,
  answer: unknown,
): void {
  if (body !== undefined && Value.Check(body, answer)) return sendJson(response, status, answer);
  reportServerError(
    "route",
    new Error("answer outside the contract"),
    requestIdOf(response),
    contract.id,
  );
  sendProblem(response, 503, "unavailable");
}

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const idOf = (segment: string | undefined) =>
  segment !== undefined && LOWER_UUID.test(segment) ? segment : null;

export function createQualitativeMaterialsRoutesFor(main: { withActor: WithActor }): Route[] {
  const store = createQualitativeCodingStore(main.withActor);
  return [
    {
      contract: LIST.contract,
      async handle(request, response) {
        if (!sameOrigin(request.headersDistinct)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        await guarded(response, LIST.contract.id, async () =>
          sendChecked(response, LIST, 200, { materials: await store.listMaterials(token) }),
        );
      },
    },
    {
      contract: CREATE.contract,
      async handle(request, response) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const types = request.headersDistinct["content-type"];
        if (
          types?.length !== 1 ||
          types[0]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
        ) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          CREATE.contract.request.maxBodyBytes!,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(CREATE.contract.request.body!, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const { title, kind, text } = json.value as { title: string; kind: string; text: string };
        await guarded(response, CREATE.contract.id, async () => {
          const id = await store.createMaterial(token, title, kind, text);
          sendChecked(response, CREATE, 201, await store.readMaterial(token, id));
        });
      },
    },
    {
      contract: READ.contract,
      async handle(request, response, params) {
        if (!sameOrigin(request.headersDistinct)) return sendProblem(response, 403, "forbidden");
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const id = idOf(params?.id);
        if (id === null) return sendProblem(response, 404, "not_found");
        await guarded(response, READ.contract.id, async () =>
          sendChecked(response, READ, 200, await store.readMaterial(token, id)),
        );
      },
    },
    {
      contract: REMOVE.contract,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const id = idOf(params?.id);
        if (id === null) return sendProblem(response, 404, "not_found");
        await guarded(response, REMOVE.contract.id, async () => {
          await store.deleteMaterial(token, id);
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        });
      },
    },
  ];
}
