import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import {
  NotificationId,
  NOTIFICATIONS_PAGE_SIZE,
  ROUTES,
  workIdFromPath,
  type RouteContract,
} from "../../contracts/index.ts";
import {
  createMentorshipConsultationStore,
  type SlotPreparation,
  type WithActor,
} from "../../database/index.ts";
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

// SRV-MENTOR-1 (NF-6: MK-7, MK-3, MK-10, MK-5). Thin: the contract checks the
// input, the database decides who may and answers. Each family keeps the
// refusals of the routes it stands next to: a mentorship or a consultation
// record that is not the caller's reads 404 (mentorship.*, consultation
// records), a slot of a work without relation 403 (work.consultation-slots.*).

const find = (id: string): RouteContract => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const OPEN = find("mentorship.open.post");
const MENTORSHIPS = find("mentorship.student-mentorships.get");
const NOTIFICATIONS = find("notifications.mentorship-opened.list.get");
const SLOTS = find("work.consultation-slot-details.get");
const REQUEST = find("work.consultation-slot-requests.post");
const CLOSE = find("work.consultation-slot-close.post");
const TASKS = find("work.consultation-tasks.get");
const ADD_TASK = find("work.consultation-tasks.post");
const MARK_TASK = find("work.consultation-task-mark.post");

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;

type Refusals = ReadonlyMap<string, readonly [number, string]>;
const COMMON: [string, readonly [number, string]][] = [
  ["ZD401", [401, "unauthorized"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
];
const NOT_FOUND: Refusals = new Map([
  ...COMMON,
  ["ZD403", [404, "not_found"]],
  ["ZD503", [503, "unavailable"]],
]);
const FORBIDDEN: Refusals = new Map([
  ...COMMON,
  ["ZD403", [403, "forbidden"]],
  // A time PostgreSQL cannot read (e.g. 24:00 on a day that has none).
  ["22007", [422, "invalid_input"]],
  ["22008", [422, "invalid_input"]],
  ["22009", [422, "invalid_input"]],
]);

type Store = ReturnType<typeof createMentorshipConsultationStore>;
type Body = {
  studentId?: string;
  workType?: string;
  topic?: string;
  startsAt?: string;
  preparation?: SlotPreparation;
  action?: string;
  reason?: string;
  text?: string;
  done?: boolean;
};
type Call = {
  readonly token: string;
  readonly documentId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: Body;
  readonly before: string | null;
};

type Spec = {
  readonly contract: RouteContract;
  readonly refusals: Refusals;
  /** A path work id that is malformed reads as this. */
  readonly work?: true;
  readonly answer: (store: Store, call: Call) => Promise<unknown>;
};

const page = <T extends { id: string }>(rows: readonly T[]) => {
  const notifications = rows.slice(0, NOTIFICATIONS_PAGE_SIZE);
  return {
    notifications,
    nextBefore: rows.length > notifications.length ? notifications.at(-1)!.id : null,
  };
};

const SPECS: readonly Spec[] = [
  {
    contract: OPEN,
    refusals: NOT_FOUND,
    answer: async (store, { token, body }) => ({
      mentorshipId: await store.open(
        token,
        body.studentId!.toLowerCase(),
        body.workType!,
        body.topic ?? null,
      ),
    }),
  },
  {
    contract: MENTORSHIPS,
    refusals: FORBIDDEN,
    answer: async (store, { token }) => ({ mentorships: await store.studentMentorships(token) }),
  },
  {
    contract: NOTIFICATIONS,
    refusals: NOT_FOUND,
    answer: async (store, { token, before }) => page(await store.notifications(token, before)),
  },
  {
    contract: SLOTS,
    refusals: FORBIDDEN,
    work: true,
    answer: async (store, { token, documentId }) => ({
      slots: await store.slots(token, documentId),
    }),
  },
  {
    contract: REQUEST,
    refusals: FORBIDDEN,
    work: true,
    answer: (store, { token, documentId, body }) =>
      store.request(
        token,
        documentId,
        body.startsAt!,
        body.topic ?? null,
        body.preparation ?? null,
      ),
  },
  {
    contract: CLOSE,
    refusals: FORBIDDEN,
    work: true,
    answer: (store, { token, documentId, params, body }) =>
      store.close(token, documentId, params.slotId!, body.action!, body.reason ?? null),
  },
  {
    contract: TASKS,
    refusals: NOT_FOUND,
    work: true,
    answer: async (store, { token, documentId }) => ({
      tasks: await store.tasks(token, documentId),
    }),
  },
  {
    contract: ADD_TASK,
    refusals: NOT_FOUND,
    work: true,
    answer: (store, { token, documentId, params, body }) =>
      store.addTask(token, documentId, params.recordId!, body.text!),
  },
  {
    contract: MARK_TASK,
    refusals: NOT_FOUND,
    work: true,
    answer: (store, { token, documentId, params, body }) =>
      store.markTask(token, documentId, params.taskId!, body.done!),
  },
];

/** The JSON body as the contract allows it; otherwise the refusal is sent and ok is false. */
async function readBody(
  request: IncomingMessage,
  response: ServerResponse,
  contract: RouteContract,
): Promise<{ ok: true; body: Body } | { ok: false }> {
  const types = request.headersDistinct["content-type"];
  if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
    refuse(response, 415, "unsupported_media_type");
    return { ok: false };
  }
  const raw = await readBodyWithLimit(request, contract.request.maxBodyBytes!, BODY_TIMEOUT_MS);
  if (!raw.ok) {
    refuse(response, raw.status, raw.reason);
    return { ok: false };
  }
  const json = parseJson(raw.bytes);
  if (!json.ok) {
    sendProblem(response, 400, "invalid_json");
    return { ok: false };
  }
  if (!Value.Check(contract.request.body!, json.value)) {
    sendProblem(response, 422, "invalid_input");
    return { ok: false };
  }
  return { ok: true, body: json.value as Body };
}

/** The cursor of a list, or undefined for a query the contract refuses (422). */
function cursorOf(url: string | undefined): string | null | undefined {
  const query = new URLSearchParams((url ?? "").split("?").slice(1).join("?"));
  const before = query.get("before");
  if (query.size > Number(before !== null)) return undefined;
  if (before !== null && !Value.Check(NotificationId, before)) return undefined;
  return before === null ? null : before.toLowerCase();
}

export function createMentorshipConsultationRoutesFor({
  withActor,
}: {
  withActor: WithActor;
}): Route[] {
  const store = createMentorshipConsultationStore(withActor);
  return SPECS.map(({ contract, refusals, work, answer }) => {
    const success = contract.responses[0]!;
    const mutation = contract.method !== "GET";
    return {
      contract,
      async handle(request, response, rawParams) {
        if (contract === MENTORSHIPS) {
          // As the student's other mentorship reads (SRV-1414).
          const site = request.headersDistinct["sec-fetch-site"];
          if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
            return sendProblem(response, 403, "forbidden");
          }
        }
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return refuse(response, 401, "unauthorized");

        const params: Record<string, string> = { ...rawParams };
        let documentId = "";
        if (work) {
          const id = workIdFromPath(rawParams?.documentId ?? "");
          if (id === null) return refuse(response, 404, "not_found");
          documentId = id;
          params.documentId = id;
          if (!Value.Check(contract.request.params!, params)) {
            return refuse(response, 404, "not_found");
          }
        }

        let before: string | null = null;
        if (contract === NOTIFICATIONS) {
          const cursor = cursorOf(request.url);
          if (cursor === undefined) return sendProblem(response, 422, "invalid_input");
          before = cursor;
        }

        let body: Body = {};
        if (contract.request.body !== undefined) {
          const read = await readBody(request, response, contract);
          if (!read.ok) return;
          body = read.body;
        }

        try {
          const result = await answer(store, { token, documentId, params, body, before });
          if (!Value.Check(success.body!, result)) {
            throw new Error(`${contract.id} answer outside its contract`);
          }
          sendJson(response, success.status, result);
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          const refusal = typeof code === "string" ? refusals.get(code) : undefined;
          if (refusal !== undefined) return sendProblem(response, ...refusal);
          reportServerError("route", error, requestIdOf(response), contract.id);
          return sendProblem(response, 503, "unavailable");
        }
        if (mutation) void recordActivity(token, withActor).catch(() => undefined);
      },
    };
  });
}
