// SRV-V19-DNEVNIK-RUTE (Ductus#2055; val 19): the six routes of the practice
// journal (server/contracts/routes/practice-journal.ts, docs/contracts/
// practice-journal-v1.md). The handler checks the shape, the database decides
// who may do what from the relation (student of the practice, mentor of its
// mentorship) and answers another's, an unknown and a malformed practice with
// the same 404 (C-23). Nothing here grades, ranks or sanctions: an entry is a
// line of a diary, a signoff a record of who signed which set.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import { createPracticeJournalStore, type WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

const route = (id: string) => ROUTES.find((candidate) => candidate.id === id)!;
const practicePlacementsPost = route("practice.placements.post");
const practicePlacementsGet = route("practice.placements.get");
const practiceEntriesGet = route("practice.entries.get");
const practiceEntriesPost = route("practice.entries.post");
const practiceSignoffsPost = route("practice.signoffs.post");
const practiceSignoffsGet = route("practice.signoffs.get");
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
// The messages of the RPC's own ZD409 (migration 20261219100000): fixed texts,
// never input, which tell two refusals of one SQLSTATE apart.
const PLACEMENT_CLOSED = "placement closed";

type Json = Record<string, unknown>;

function codeOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/** The problem a refusal of the database becomes, or undefined for a failure (503). */
function refusalOf(contract: unknown, error: unknown): readonly [number, string] | undefined {
  switch (codeOf(error)) {
    case "ZD401":
      return [401, "unauthorized"];
    case "ZD404":
      return [404, "not_found"];
    case "ZD422":
      return [422, "invalid_input"];
    case "ZD409": {
      if (contract === practiceSignoffsPost) return [409, "nothing_to_sign"];
      if (contract !== practiceEntriesPost) return undefined;
      const message = error instanceof Error ? error.message : "";
      return message === PLACEMENT_CLOSED ? [409, "placement_closed"] : [409, "conflict"];
    }
    default:
      return undefined;
  }
}

export function createPracticeJournalRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  const store = createPracticeJournalStore(withActor);
  const contracts = [
    practicePlacementsPost,
    practicePlacementsGet,
    practiceEntriesGet,
    practiceEntriesPost,
    practiceSignoffsPost,
    practiceSignoffsGet,
  ] as const;
  return contracts.map((contract) => ({
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");

      // A path id that is not a UUID is the same 404 as another's practice.
      let placementId = "";
      if (contract.request.params !== undefined) {
        const input = { placementId: params?.placementId ?? "" };
        if (!Value.Check(contract.request.params, input)) return refuse(response, 404, "not_found");
        placementId = input.placementId.toLowerCase();
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
      }

      try {
        let body: unknown;
        if (contract === practicePlacementsPost) {
          const placement = input as {
            mentorshipId: string;
            organisationName: string;
            startsOn: string;
            endsOn: string;
          };
          body = await store.openPlacement(token, {
            ...placement,
            mentorshipId: placement.mentorshipId.toLowerCase(),
          });
        } else if (contract === practicePlacementsGet) {
          body = { placements: await store.placements(token) };
        } else if (contract === practiceEntriesGet) {
          body = await store.entries(token, placementId);
        } else if (contract === practiceEntriesPost) {
          const entry = input as {
            date: string;
            hours: number;
            text: string;
            correctsEntryId?: string;
          };
          body = await store.addEntry(token, placementId, {
            ...entry,
            ...(entry.correctsEntryId === undefined
              ? {}
              : { correctsEntryId: entry.correctsEntryId.toLowerCase() }),
          });
        } else if (contract === practiceSignoffsPost) {
          const signoff = input as { throughDate: string; comment?: string };
          body = await store.sign(token, placementId, signoff);
        } else {
          body = { signoffs: await store.signoffs(token, placementId) };
        }
        const success = contract.responses[0]!;
        if (!Value.Check(success.body!, body)) throw new Error("invalid practice journal result");
        sendJson(response, success.status, body);
      } catch (error) {
        const refusal = refusalOf(contract, error);
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
      if (contract.method !== "GET") void recordActivity(token, withActor).catch(() => undefined);
    },
  }));
}
