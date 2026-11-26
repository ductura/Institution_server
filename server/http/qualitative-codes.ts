// SRV-V18-KODIRANJE-SIFRARNIK (Ductus#2058; val 18): the four routes of the
// codebook of qualitative coding (server/contracts/routes/qualitative-codes.ts,
// docs/contracts/qualitative-codes-v1.md). The handler checks the shape; the
// database decides who owns what (app.qual_* RPCs): another's, an unknown and a
// malformed code are the same 404 (C-23). The codebook comes back in its own
// order, never by use (V18-8). Nothing here suggests a code or calls an
// assistant (V18-3).
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import { createQualitativeCodingStore, type QualCode, type WithActor } from "../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../session/index.ts";

import {
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "./index.ts";

const route = (id: string) => ROUTES.find((candidate) => candidate.id === id)!;
const studentQualCodesGet = route("student.qual-codes.get");
const studentQualCodesPost = route("student.qual-codes.post");
const studentQualCodePatch = route("student.qual-code.patch");
const studentQualCodeDelete = route("student.qual-code.delete");
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;

function codeOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/** The problem a refusal of the database becomes, or undefined for a failure (503). */
function refusalOf(error: unknown): readonly [number, string] | undefined {
  switch (codeOf(error)) {
    case "ZD401":
      return [401, "unauthorized"];
    case "ZD404":
      return [404, "not_found"];
    case "ZD422":
      return [422, "invalid_input"];
    // A name the codebook has, the 201st code, a code with passages not confirmed.
    case "ZD409":
      return [409, "conflict"];
    default:
      return undefined;
  }
}

/** The code as the contract shows it: the segment count is the codebook's own business, not the wire's. */
const wire = ({ id, name, description, order }: QualCode) => ({ id, name, description, order });

type Json = { name?: string; description?: string; order?: number };

export function createQualitativeCodesRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const store = createQualitativeCodingStore(withActor);
  const contracts = [
    studentQualCodesGet,
    studentQualCodesPost,
    studentQualCodePatch,
    studentQualCodeDelete,
  ] as const;
  const notFound = () => Object.assign(new Error("not found"), { code: "ZD404" });
  const invalid = () => Object.assign(new Error("invalid input"), { code: "ZD422" });

  return contracts.map((contract) => ({
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");

      // A path id that is not a UUID is the same 404 as another's code.
      let id = "";
      if (contract.request.params !== undefined) {
        const input = { id: params?.id ?? "" };
        if (!Value.Check(contract.request.params, input)) return refuse(response, 404, "not_found");
        id = input.id.toLowerCase();
      }

      let input: Json = {};
      if (contract.request.body !== undefined) {
        const types = request.headersDistinct["content-type"];
        if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          contract.request.maxBodyBytes!,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(contract.request.body, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        input = json.value as Json;
        // A change that changes nothing is a malformed one, not a silent success.
        if (contract === studentQualCodePatch && Object.keys(input).length === 0) {
          return sendProblem(response, 422, "invalid_input");
        }
      }

      let confirm = false;
      if (contract === studentQualCodeDelete) {
        const query = new URLSearchParams((request.url ?? "").split("?").slice(1).join("?"));
        const given = [...query.keys()];
        if (given.length > 1 || (given.length === 1 && given[0] !== "confirm")) {
          return sendProblem(response, 422, "invalid_input");
        }
        const value = query.get("confirm");
        if (value !== null && value !== "true") return sendProblem(response, 422, "invalid_input");
        confirm = value === "true";
        if (query.getAll("confirm").length > 1) return sendProblem(response, 422, "invalid_input");
      }

      try {
        let status: number = contract.responses[0]!.status;
        let body: unknown;
        if (contract === studentQualCodesGet) {
          body = { codes: (await store.listCodes(token)).map(wire) };
        } else if (contract === studentQualCodesPost) {
          const created = await store.createCode(token, input.name!, input.description ?? "");
          const code = (await store.listCodes(token)).find((entry) => entry.id === created);
          if (code === undefined) throw new Error("created code not in the codebook");
          body = wire(code);
        } else if (contract === studentQualCodePatch) {
          const codebook = await store.listCodes(token);
          const before = codebook.find((entry) => entry.id === id);
          if (before === undefined) throw notFound();
          // The place is checked before anything is written, so a refusal leaves the code as it was.
          if (input.order !== undefined && input.order > codebook.length) throw invalid();
          if (input.name !== undefined || input.description !== undefined) {
            await store.updateCode(
              token,
              id,
              input.name ?? before.name,
              input.description ?? before.description,
            );
          }
          if (input.order !== undefined && input.order !== before.order) {
            await store.moveCode(token, id, input.order);
          }
          const after = (await store.listCodes(token)).find((entry) => entry.id === id);
          if (after === undefined) throw notFound();
          body = wire(after);
        } else {
          await store.deleteCode(token, id, confirm);
          status = 204;
        }
        if (status === 204) {
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        } else {
          const success = contract.responses[0]!;
          if (!Value.Check(success.body!, body)) throw new Error("invalid codebook result");
          sendJson(response, status, body);
        }
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
      if (contract.method !== "GET") void recordActivity(token, withActor).catch(() => undefined);
    },
  }));
}
