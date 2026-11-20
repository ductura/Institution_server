// The work's source list over HTTP (SRV-7C, Ductus#2028): the student reads
// the list of an own work and adds, changes and removes the sources they
// added. The rules are the database's (institution.work_sources,
// save_work_source, delete_work_source, SRV-7B); this file reads the request,
// checks its shape and maps the answer. The session alone names the student.
import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import { ROUTES, workIdFromPath, WorkSourceRecord } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type PathParams,
  type Route,
} from "../index.ts";

const LIST = ROUTES.find((route) => route.id === "student.work-sources.get")!;
const SAVE = ROUTES.find((route) => route.id === "student.work-sources.put")!;
const REMOVE = ROUTES.find((route) => route.id === "student.work-sources.delete")!;

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;
const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const COLUMNS =
  'id, record, doi, isbn, undated, requirement, created_at AS "createdAt", updated_at AS "updatedAt"';
const LIST_SQL = `SELECT ${COLUMNS} FROM institution.work_sources($1::uuid, NULL)`;
const SAVE_SQL = `SELECT ${COLUMNS} FROM institution.save_work_source($1::uuid, $2::jsonb, $3::text, $4::text, $5::boolean)`;
const REMOVE_SQL = "SELECT institution.delete_work_source($1::uuid, $2::uuid) AS removed";

type Row = {
  id: unknown;
  record: unknown;
  doi: unknown;
  isbn: unknown;
  undated: unknown;
  requirement: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};
type Refusal = "unauthorized" | "not_found" | "invalid_input";

function sqlState(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** One answer for every refusal of access, as the database gives one (ZD403). */
function refusalOf(error: unknown): Refusal | undefined {
  const code = sqlState(error);
  if (code === "ZD401") return "unauthorized";
  if (code === "ZD403") return "not_found";
  if (code === "ZD422") return "invalid_input";
  return undefined;
}

function instant(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid work source timestamp");
  }
  return value.toISOString();
}

/** The wire shape of a row; a row that is not what the table holds makes the answer 503. */
function sourceOf(row: Row) {
  const { id, record, doi, isbn, undated, requirement } = row;
  if (typeof id !== "string" || !Value.Check(WorkSourceRecord, record)) {
    throw new Error("invalid work source row");
  }
  if (typeof undated !== "boolean" || (doi !== null && typeof doi !== "string")) {
    throw new Error("invalid work source row");
  }
  if (isbn !== null && typeof isbn !== "string") throw new Error("invalid work source row");
  if (requirement !== null && requirement !== "recommended" && requirement !== "required") {
    throw new Error("invalid work source row");
  }
  return {
    id,
    record,
    doi,
    isbn,
    undated,
    requirement,
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
  };
}

function refuseWith(response: ServerResponse, code: Refusal): void {
  if (code === "unauthorized") return sendProblem(response, 401, code);
  if (code === "not_found") return sendProblem(response, 404, code);
  sendProblem(response, 422, code);
}

function unavailable(response: ServerResponse, route: string, error: unknown): void {
  reportServerError("route", error, requestIdOf(response), route);
  sendProblem(response, 503, "unavailable");
}

type Input = {
  record: { id: string } & Record<string, unknown>;
  doi: string | null;
  isbn: string | null;
  undated: boolean;
};

/** The body of a save, or undefined: the shape, the record's deep shape and its id against the path. */
function inputOf(body: unknown, sourceId: string): Input | undefined {
  if (!Value.Check(SAVE.request.body!, body)) return undefined;
  const { record, doi, isbn, undated } = body as Record<string, unknown>;
  if (!Value.Check(WorkSourceRecord, record) || record.id !== sourceId) return undefined;
  return {
    record: record as Input["record"],
    doi: (doi as string | null | undefined) ?? null,
    isbn: (isbn as string | null | undefined) ?? null,
    undated: (undated as boolean | undefined) ?? false,
  };
}

/** A UUID of a path, decoded once; undefined when it is not one. */
function pathId(params: PathParams | undefined, name: string): string | undefined {
  const id = workIdFromPath(params?.[name] ?? "");
  return id !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)
    ? id
    : undefined;
}

export function createWorkSourceRoutesFor({ withActor }: { withActor: WithActor }): Route[] {
  return [
    {
      contract: LIST,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        const assignmentId = pathId(params, "assignmentId");
        if (assignmentId === undefined) return sendProblem(response, 404, "not_found");
        try {
          const sources = await withActor(token, async (tx) => {
            const { rows } = await tx.query<Row>(LIST_SQL, [assignmentId]);
            return rows.map(sourceOf);
          });
          sendJson(response, 200, { sources });
        } catch (error) {
          const refusal = refusalOf(error);
          if (refusal !== undefined) return refuseWith(response, refusal);
          unavailable(response, LIST.id, error);
        }
      },
    },
    {
      contract: SAVE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const types = request.headersDistinct["content-type"];
        if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          SAVE.request.maxBodyBytes ?? 0,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        const assignmentId = pathId(params, "assignmentId");
        const sourceId = pathId(params, "sourceId");
        if (assignmentId === undefined || sourceId === undefined || !SOURCE_ID.test(sourceId)) {
          return sendProblem(response, 404, "not_found");
        }
        const input = inputOf(json.value, sourceId);
        if (input === undefined) return sendProblem(response, 422, "invalid_input");
        try {
          const source = await withActor(token, async (tx) => {
            const { rows } = await tx.query<Row>(SAVE_SQL, [
              assignmentId,
              JSON.stringify(input.record),
              input.doi,
              input.isbn,
              input.undated,
            ]);
            // Confirmed inside the transaction, so a malformed result rolls back.
            if (rows.length !== 1 || rows[0] === undefined)
              throw new Error("unconfirmed work source");
            return sourceOf(rows[0]);
          });
          sendJson(response, 200, source);
        } catch (error) {
          const refusal = refusalOf(error);
          if (refusal !== undefined) return refuseWith(response, refusal);
          return unavailable(response, SAVE.id, error);
        }
        void recordActivity(token, withActor).catch(() => undefined);
      },
    },
    {
      contract: REMOVE,
      async handle(request, response, params) {
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");
        const assignmentId = pathId(params, "assignmentId");
        const sourceId = pathId(params, "sourceId");
        if (assignmentId === undefined || sourceId === undefined) {
          return sendProblem(response, 404, "not_found");
        }
        try {
          const removed = await withActor(token, async (tx) => {
            const { rows } = await tx.query<{ removed: unknown }>(REMOVE_SQL, [
              assignmentId,
              sourceId,
            ]);
            if (rows.length !== 1 || typeof rows[0]?.removed !== "boolean") {
              throw new Error("unconfirmed work source removal");
            }
            return rows[0].removed;
          });
          if (!removed) return sendProblem(response, 404, "not_found");
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        } catch (error) {
          const refusal = refusalOf(error);
          if (refusal !== undefined) return refuseWith(response, refusal);
          return unavailable(response, REMOVE.id, error);
        }
        void recordActivity(token, withActor).catch(() => undefined);
      },
    },
  ];
}
