import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { canRead, canWrite, parseBearer } from "./access.ts";
import type { Store } from "./store.ts";

// The transitional server answers an error as {code, messageKey} (DAN-782,
// docs/CODE_STYLE.md §8); the Croatian text is in locales/hr.json under `app`.
const error = (status: number, code: string, messageKey: string) =>
  ({ status, body: { code, messageKey } }) as const;

/** Every error of the transitional server, one status and one key each. */
export const APP_ERRORS = {
  loginRequired: error(401, "APP_LOGIN_REQUIRED", "app.login_required"),
  notFound: error(404, "APP_NOT_FOUND", "app.not_found"),
  documentNotFound: error(404, "APP_DOCUMENT_NOT_FOUND", "app.document_not_found"),
  documentReadForbidden: error(403, "APP_DOCUMENT_READ_FORBIDDEN", "app.document_read_forbidden"),
  documentWriteForbidden: error(
    403,
    "APP_DOCUMENT_WRITE_FORBIDDEN",
    "app.document_write_forbidden",
  ),
  methodNotAllowed: error(405, "APP_METHOD_NOT_ALLOWED", "app.method_not_allowed"),
} as const;

type AppErrorName = keyof typeof APP_ERRORS;

/** A success answer; an error goes through fail() and APP_ERRORS only. */
function ok(res: ServerResponse, body: unknown): void {
  write(res, 200, body);
}

function write(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function fail(res: ServerResponse, name: AppErrorName): void {
  const { status, body } = APP_ERRORS[name];
  write(res, status, body);
}

function text(value: unknown, fallback: string | undefined): string | undefined {
  return value === undefined || value === null ? fallback : (value as string);
}

export function createApp({ store }: { store: Store }): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return ok(res, { ok: true });

    const userId = parseBearer(req.headers.authorization);
    if (!userId) return fail(res, "loginRequired");

    if (url.pathname === "/api/documents" && req.method === "GET") {
      return ok(res, store.listFor(userId));
    }

    const m = url.pathname.match(/^\/api\/documents\/([\w-]+)$/);
    if (!m?.[1]) return fail(res, "notFound");
    const doc = store.get(m[1]);
    if (!doc) return fail(res, "documentNotFound");

    if (req.method === "GET") {
      if (!canRead(userId, doc)) return fail(res, "documentReadForbidden");
      return ok(res, doc);
    }
    if (req.method === "PUT") {
      if (!canWrite(userId, doc)) return fail(res, "documentWriteForbidden");
      const body = await readJson(req);
      const next = { ...doc };
      const title = text(body.title, doc.title);
      const content = text(body.content, doc.content);
      if (title !== undefined) next.title = title;
      if (content !== undefined) next.content = content;
      return ok(res, store.put(next));
    }
    return fail(res, "methodNotAllowed");
  });
}
