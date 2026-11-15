import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { canRead, canWrite, parseBearer } from "./access.ts";
import type { Store } from "./store.ts";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// Error codes of this skeleton app. The text of each is in locales/hr.json
// under `app.<code in lowercase>` (docs/CODE_STYLE.md §8); the texts were
// written here before S-1L.2 (DAN-780).
type AppErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "DOCUMENT_NOT_FOUND"
  | "READ_FORBIDDEN"
  | "WRITE_FORBIDDEN"
  | "METHOD_NOT_ALLOWED";

function fail(res: ServerResponse, status: number, code: AppErrorCode): void {
  send(res, status, { error: { code, messageKey: `app.${code.toLowerCase()}` } });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function text(value: unknown, fallback: string | undefined): string | undefined {
  return value === undefined || value === null ? fallback : (value as string);
}

export function createApp({ store }: { store: Store }): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(res, 200, { ok: true });

    const userId = parseBearer(req.headers.authorization);
    if (!userId) return fail(res, 401, "UNAUTHENTICATED");

    if (url.pathname === "/api/documents" && req.method === "GET") {
      return send(res, 200, store.listFor(userId));
    }

    const m = url.pathname.match(/^\/api\/documents\/([\w-]+)$/);
    if (!m?.[1]) return fail(res, 404, "NOT_FOUND");
    const doc = store.get(m[1]);
    if (!doc) return fail(res, 404, "DOCUMENT_NOT_FOUND");

    if (req.method === "GET") {
      if (!canRead(userId, doc)) return fail(res, 403, "READ_FORBIDDEN");
      return send(res, 200, doc);
    }
    if (req.method === "PUT") {
      if (!canWrite(userId, doc)) {
        return fail(res, 403, "WRITE_FORBIDDEN");
      }
      const body = await readJson(req);
      const next = { ...doc };
      const title = text(body.title, doc.title);
      const content = text(body.content, doc.content);
      if (title !== undefined) next.title = title;
      if (content !== undefined) next.content = content;
      return send(res, 200, store.put(next));
    }
    return fail(res, 405, "METHOD_NOT_ALLOWED");
  });
}
