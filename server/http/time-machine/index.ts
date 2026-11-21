import { isWorkId, ROUTES, workIdFromPath } from "../../contracts/index.ts";
import {
  blocksOf,
  diffBlocks,
  MAX_COMPARE_BLOCKS,
  verifyVersionedDocumentSnapshot,
} from "../../evidence/index.ts";
import type { InstitutionEvidencePayloadReader } from "../../external/storage/index.ts";
import { liveSessionTokenFromCookie } from "../../session/index.ts";
import {
  type Databases,
  reportServerError,
  requestIdOf,
  type Route,
  sendJson,
  sendProblem,
} from "../index.ts";

import { createTimeMachineStore, type TimeMachineStore } from "./store.ts";

const CONTRACT = ROUTES.find((route) => route.id === "work.version.get")!;

function revisionOf(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}(?![\s\S])/u.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

export function createWorkVersionRoute(read: TimeMachineStore["read"]): Route {
  return {
    contract: CONTRACT,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return sendProblem(response, 401, "unauthorized");
      const documentId = workIdFromPath(params?.documentId ?? "");
      if (documentId === null || !isWorkId(documentId)) {
        return sendProblem(response, 404, "not_found");
      }
      const revision = revisionOf(params?.revision ?? "");
      const target = request.url ?? "";
      const queryStart = target.indexOf("?");
      const query = new URLSearchParams(queryStart === -1 ? "" : target.slice(queryStart + 1));
      const from = revisionOf(query.get("compareFrom") ?? "");
      if (
        revision === null ||
        (query.size !== 0 && (query.size !== 1 || from === null || from >= revision))
      ) {
        return sendProblem(response, 422, "invalid_input");
      }

      try {
        const readout = await read(
          token,
          documentId,
          from === null ? [revision] : [from, revision],
        );
        if (readout.status === "unauthenticated") return sendProblem(response, 401, "unauthorized");
        if (readout.status === "not_found") return sendProblem(response, 404, "not_found");
        if (readout.status !== "found") return sendProblem(response, 503, "unavailable");
        const texts: string[] = [];
        for (const { body, hash } of readout.snapshots) {
          const checked = await verifyVersionedDocumentSnapshot(Buffer.from(body, "utf8"));
          if (!checked.ok || checked.sha256 !== hash)
            return sendProblem(response, 503, "unavailable");
          texts.push(checked.text);
        }
        if (from === null && texts.length === 1) {
          return sendJson(response, 200, { revision, document: texts[0] });
        }
        if (from === null || texts.length !== 2) return sendProblem(response, 503, "unavailable");
        const before = blocksOf(texts[0]!);
        const after = blocksOf(texts[1]!);
        if (before === null || after === null) return sendProblem(response, 503, "unavailable");
        if (before.length > MAX_COMPARE_BLOCKS || after.length > MAX_COMPARE_BLOCKS) {
          return sendProblem(response, 422, "invalid_input");
        }
        return sendJson(response, 200, { from, to: revision, blocks: diffBlocks(before, after) });
      } catch (error) {
        reportServerError("route", error, requestIdOf(response), CONTRACT.id);
        return sendProblem(response, 503, "unavailable");
      }
    },
  };
}

export function createWorkVersionRouteFor(
  main: Pick<Databases["main"], "withActor">,
  deps: { readonly payloads: InstitutionEvidencePayloadReader },
): Route {
  const store = createTimeMachineStore(main.withActor, deps.payloads);
  return createWorkVersionRoute(store.read);
}
