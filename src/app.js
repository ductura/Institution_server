import { createServer } from 'node:http';
import { parseBearer, canRead, canWrite } from './access.js';

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function createApp({ store }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return send(res, 200, { ok: true });

    const userId = parseBearer(req.headers.authorization);
    if (!userId) return send(res, 401, { error: 'Prijava je obavezna.' });

    if (url.pathname === '/api/documents' && req.method === 'GET') {
      return send(res, 200, store.listFor(userId));
    }

    const m = url.pathname.match(/^\/api\/documents\/([\w-]+)$/);
    if (!m) return send(res, 404, { error: 'Nije pronađeno.' });
    const doc = store.get(m[1]);
    if (!doc) return send(res, 404, { error: 'Dokument ne postoji.' });

    if (req.method === 'GET') {
      if (!canRead(userId, doc)) return send(res, 403, { error: 'Nemate pristup ovom dokumentu.' });
      return send(res, 200, doc);
    }
    if (req.method === 'PUT') {
      if (!canWrite(userId, doc)) return send(res, 403, { error: 'Nemate pravo mijenjati ovaj dokument.' });
      const body = await readJson(req);
      return send(res, 200, store.put({ ...doc, title: body.title ?? doc.title, content: body.content ?? doc.content }));
    }
    return send(res, 405, { error: 'Metoda nije podržana.' });
  });
}
