// Funkcionalna provjera: korisnik može otvoriti svoj dokument,
// a pokušaj pristupa tuđem dokumentu bude odbijen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

let server, base;
before(async () => {
  const store = createStore([
    { id: 'ana-1', ownerId: 'ana@fpzg.hr', title: 'Anin rad', content: 'Uvod' },
    { id: 'ivo-1', ownerId: 'ivo@fpzg.hr', title: 'Ivin rad', content: 'Tajno' },
  ]);
  server = createApp({ store }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const as = (user) => ({ headers: { authorization: `Bearer ${user}` } });

test('korisnik otvara svoj dokument', async () => {
  const res = await fetch(`${base}/api/documents/ana-1`, as('ana@fpzg.hr'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).title, 'Anin rad');
});

test('pristup tuđem dokumentu je odbijen', async () => {
  const res = await fetch(`${base}/api/documents/ivo-1`, as('ana@fpzg.hr'));
  assert.equal(res.status, 403);
  assert.doesNotMatch(await res.text(), /Tajno/);
});

test('bez prijave nema pristupa', async () => {
  const res = await fetch(`${base}/api/documents/ana-1`);
  assert.equal(res.status, 401);
});

test('tuđi korisnik ne može mijenjati dokument', async () => {
  const res = await fetch(`${base}/api/documents/ivo-1`, {
    method: 'PUT', ...as('ana@fpzg.hr'), body: JSON.stringify({ content: 'x' }),
  });
  assert.equal(res.status, 403);
});
