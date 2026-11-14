import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBearer, canRead, canWrite } from '../src/access.js';
import { createStore } from '../src/store.js';

test('parseBearer čita ID korisnika i odbacuje neispravna zaglavlja', () => {
  assert.equal(parseBearer('Bearer Ana@FPZG.hr'), 'ana@fpzg.hr');
  assert.equal(parseBearer('Basic abc'), null);
  assert.equal(parseBearer(''), null);
  assert.equal(parseBearer(undefined), null);
});

test('canRead: vlasnik i suradnik da, ostali ne', () => {
  const doc = { ownerId: 'ana', sharedWith: ['ivo'] };
  assert.equal(canRead('ana', doc), true);
  assert.equal(canRead('ivo', doc), true);
  assert.equal(canRead('marko', doc), false);
  assert.equal(canRead(null, doc), false);
});

test('canWrite: samo vlasnik', () => {
  const doc = { ownerId: 'ana', sharedWith: ['ivo'] };
  assert.equal(canWrite('ana', doc), true);
  assert.equal(canWrite('ivo', doc), false);
});

test('store vraća samo dokumente vlasnika', () => {
  const store = createStore([{ id: '1', ownerId: 'ana' }, { id: '2', ownerId: 'ivo' }]);
  assert.deepEqual(store.listFor('ana').map((d) => d.id), ['1']);
  assert.equal(store.get('x'), null);
});
