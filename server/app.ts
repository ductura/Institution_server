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
  invalidJson: error(400, "APP_INVALID_JSON", "app.invalid_json"),
  bodyTooLarge: error(413, "APP_BODY_TOO_LARGE", "app.body_too_large"),
} as const;

/** The largest request body the transitional server reads (DAN-800). */
export const MAX_BODY_BYTES = 1024 * 1024;

type AppErrorName = keyof typeof APP_ERRORS;

/** A success answer; an error goes through fail() and APP_ERRORS only. */
function ok(res: ServerResponse, body: unknown): void {
  write(res, 200, body);
}

function write(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** The whole body; "tooLarge" past MAX_BODY_BYTES, "aborted" when it never ends. */
function readBody(req: IncomingMessage): Promise<Buffer | "tooLarge" | "aborted"> {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) return resolve("tooLarge");
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) return void chunks.push(chunk);
      req.off("data", onData).pause();
      resolve("tooLarge");
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    // The error listener stays, so a broken stream is never an unhandled event.
    req.on("error", () => resolve("aborted"));
    req.on("close", () => resolve("aborted"));
  });
}

/**
 * A JSON object body, or null for anything else (not UTF-8, not JSON, not an
 * object). The parse error is dropped: its message quotes the body (DAN-800).
 */
function parseObject(bytes: Buffer): Record<string, unknown> | null {
  if (bytes.length === 0) return {};
  const raw = bytes.toString("utf8");
  // Bytes that are not UTF-8 decode to U+FFFD and do not come back the same.
  if (!Buffer.from(raw, "utf8").equals(bytes)) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fail(res: ServerResponse, name: AppErrorName): void {
  const { status, body } = APP_ERRORS[name];
  if (name === "bodyTooLarge") res.setHeader("connection", "close");
  write(res, status, body);
}

function text(value: unknown, fallback: string | undefined): string | undefined {
  return value === undefined || value === null ? fallback : (value as string);
}

export function createApp({ store }: { store: Store }): Server {
  // Last guard: a throw closes the answer and is never an unhandled rejection,
  // and nothing of it is written anywhere (it may quote the body).
  return createServer((req, res) => {
    handle(store, req, res).catch(() => res.destroy());
  });
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const bytes = await readBody(req);
    if (bytes === "aborted") return void res.destroy();
    if (bytes === "tooLarge") return fail(res, "bodyTooLarge");
    const body = parseObject(bytes);
    if (!body) return fail(res, "invalidJson");
    const next = { ...doc };
    const title = text(body.title, doc.title);
    const content = text(body.content, doc.content);
    if (title !== undefined) next.title = title;
    if (content !== undefined) next.content = content;
    return ok(res, store.put(next));
  }
  return fail(res, "methodNotAllowed");
}
