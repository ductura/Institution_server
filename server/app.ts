import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { canRead, canWrite, parseBearer } from "./access.ts";
import type { Store } from "./store.ts";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
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
    if (!userId) return send(res, 401, { error: "Prijava je obavezna." });

    if (url.pathname === "/api/documents" && req.method === "GET") {
      return send(res, 200, store.listFor(userId));
    }

    const m = url.pathname.match(/^\/api\/documents\/([\w-]+)$/);
    if (!m?.[1]) return send(res, 404, { error: "Nije pronađeno." });
    const doc = store.get(m[1]);
    if (!doc) return send(res, 404, { error: "Dokument ne postoji." });

    if (req.method === "GET") {
      if (!canRead(userId, doc)) return send(res, 403, { error: "Nemate pristup ovom dokumentu." });
      return send(res, 200, doc);
    }
    if (req.method === "PUT") {
      if (!canWrite(userId, doc)) {
        return send(res, 403, { error: "Nemate pravo mijenjati ovaj dokument." });
      }
      const body = await readJson(req);
      const next = { ...doc };
      const title = text(body.title, doc.title);
      const content = text(body.content, doc.content);
      if (title !== undefined) next.title = title;
      if (content !== undefined) next.content = content;
      return send(res, 200, store.put(next));
    }
    return send(res, 405, { error: "Metoda nije podržana." });
  });
}
