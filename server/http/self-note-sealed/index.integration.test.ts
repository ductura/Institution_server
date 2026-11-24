// SRV-NF6-SIFRA: the HTTP edge of the sealed note to self and the wrapped
// note key over a scripted transaction. Who may is the database's
// (db/main/tests/242); this checks the edge: session, media type, body shape,
// that the bytes reach the database and come back unchanged, and the closed
// answers. Invented bytes only.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createSelfNoteSealedRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "A".repeat(43);
const AT = new Date("2026-11-24T09:00:00.000Z");
const KEY_ID = "6f1e2d3c-4b5a-4968-8776-6554433221a1";
const bytes = (seed: number, length: number) =>
  Buffer.from(Array.from({ length }, (_, i) => (i * 7 + seed) % 256));
const IV = bytes(50, 12);
const CT = bytes(51, 1296);
const SEALED = { v: 1, keyId: KEY_ID, iv: IV.toString("base64url"), ct: CT.toString("base64url") };
const NOTE_ROW = {
  keyId: KEY_ID,
  iv: IV,
  ct: CT,
  noteUpdatedAt: AT,
  readingPlace: null,
  readingUpdatedAt: null,
};
const NOTE_STATE = { note: { sealed: SEALED, updatedAt: AT.toISOString() }, readingPlace: null };
const WRAPS = {
  phrase: { salt: bytes(21, 16), iv: bytes(22, 12), ct: bytes(23, 48) },
  recovery: { salt: bytes(24, 16), iv: bytes(25, 12), ct: bytes(26, 48) },
};
const b64 = (part: { salt: Buffer; iv: Buffer; ct: Buffer }) => ({
  salt: part.salt.toString("base64url"),
  iv: part.iv.toString("base64url"),
  ct: part.ct.toString("base64url"),
});
const KEY_WRITE = {
  v: 1,
  keyId: KEY_ID,
  kdf: { alg: "PBKDF2-SHA-256", iterations: 600000 },
  phrase: b64(WRAPS.phrase),
  recovery: b64(WRAPS.recovery),
};
const KEY_ROW = {
  keyId: KEY_ID,
  version: 1,
  iterations: 600000,
  phraseSalt: WRAPS.phrase.salt,
  phraseIv: WRAPS.phrase.iv,
  phraseCt: WRAPS.phrase.ct,
  recoverySalt: WRAPS.recovery.salt,
  recoveryIv: WRAPS.recovery.iv,
  recoveryCt: WRAPS.recovery.ct,
  updatedAt: AT,
};
const KEY_STATE = { key: { ...KEY_WRITE, version: 1, updatedAt: AT.toISOString() } };

const query = vi.fn<ActorTransaction["query"]>();
const withActor: WithActor = (_token, run) => run({ query: query as ActorTransaction["query"] });
let server: Running;

beforeEach(async () => {
  query.mockReset();
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createSelfNoteSealedRoutesFor({ withActor }),
  });
});
afterEach(() => server.close());

const base = () => `http://127.0.0.1:${server.port}/api/v1`;
const note = (id = "izmisljeni-rad") => `${base()}/works/${id}/sealed-self-note`;
const key = () => `${base()}/me/self-note-key`;
const cookie = { cookie: `__Host-ductus_session=${TOKEN}` };
const send = (method: string, url: string, body?: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...cookie,
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });

it("passes the sealed bytes to the database and answers them unchanged", async () => {
  query.mockResolvedValue({ rows: [NOTE_ROW], rowCount: 1 });
  const written = await send("PUT", note(), JSON.stringify({ sealed: SEALED }));
  expect(written.status).toBe(200);
  expect(await written.json()).toEqual(NOTE_STATE);
  const [sql, args] = query.mock.calls[0]!;
  expect(sql).toMatch(
    /collaboration\.set_work_sealed_self_note\(\$1, \$2::uuid, \$3::bytea, \$4::bytea\)/,
  );
  expect(args).toEqual(["izmisljeni-rad", KEY_ID, IV, CT]);
  const read = await fetch(note(), { headers: cookie });
  expect(await read.json()).toEqual(NOTE_STATE);
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  expect(await (await fetch(note(), { headers: cookie })).json()).toEqual({
    note: null,
    readingPlace: null,
  });
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  expect((await send("DELETE", note())).status).toBe(200);
  expect(query.mock.calls.at(-1)![0]).toMatch(/clear_work_self_note\(\$1, 'note'\)/);
});

it.each([
  ["a short ciphertext", { sealed: { ...SEALED, ct: bytes(1, 1295).toString("base64url") } }],
  ["a padded iv", { sealed: { ...SEALED, iv: `${SEALED.iv}==` } }],
  ["a standard base64 alphabet", { sealed: { ...SEALED, ct: `${SEALED.ct.slice(0, -1)}+` } }],
  ["another version", { sealed: { ...SEALED, v: 2 } }],
  ["an uppercase key id", { sealed: { ...SEALED, keyId: KEY_ID.toUpperCase() } }],
  ["text in the clear next to it", { sealed: SEALED, text: "Izmišljena bilješka." }],
  [
    "a place in the clear inside it",
    { sealed: { ...SEALED, place: { nodeId: KEY_ID, offset: 1 } } },
  ],
])("refuses a sealed note with %s and never reaches the database", async (_name, body) => {
  expect((await send("PUT", note(), JSON.stringify(body))).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("reads, sets, rewraps and deletes the caller's wrapped key", async () => {
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  expect(await (await fetch(key(), { headers: cookie })).json()).toEqual({ key: null });
  query.mockResolvedValueOnce({ rows: [KEY_ROW], rowCount: 1 });
  const set = await send("PUT", key(), JSON.stringify({ ...KEY_WRITE, ifVersion: null }));
  expect(set.status).toBe(200);
  expect(await set.json()).toEqual(KEY_STATE);
  expect(query.mock.calls[1]![1]).toEqual([
    KEY_ID,
    null,
    600000,
    WRAPS.phrase.salt,
    WRAPS.phrase.iv,
    WRAPS.phrase.ct,
    WRAPS.recovery.salt,
    WRAPS.recovery.iv,
    WRAPS.recovery.ct,
  ]);
  query.mockResolvedValueOnce({ rows: [{ ...KEY_ROW, version: 2 }], rowCount: 1 });
  await send("PUT", key(), JSON.stringify({ ...KEY_WRITE, ifVersion: 1 }));
  expect(query.mock.calls[2]![1]![1]).toBe(1);
  query.mockResolvedValueOnce({ rows: [{ deleted: true }], rowCount: 1 });
  const gone = await send("DELETE", key());
  expect(gone.status).toBe(200);
  expect(await gone.json()).toEqual({ key: null });
});

it.each([
  [
    "too few iterations",
    { ...KEY_WRITE, kdf: { alg: "PBKDF2-SHA-256", iterations: 1000 }, ifVersion: null },
  ],
  ["another kdf", { ...KEY_WRITE, kdf: { alg: "Argon2id", iterations: 600000 }, ifVersion: null }],
  [
    "a short wrap",
    { ...KEY_WRITE, recovery: { ...KEY_WRITE.recovery, ct: "AAAA" }, ifVersion: null },
  ],
  ["a phrase in the clear", { ...KEY_WRITE, ifVersion: null, secret: "izmisljena-fraza" }],
  ["no ifVersion", KEY_WRITE],
  ["version 0", { ...KEY_WRITE, ifVersion: 0 }],
])("refuses a key with %s and never reaches the database", async (_name, body) => {
  expect((await send("PUT", key(), JSON.stringify(body))).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("answers 409 for a key that is not the one kept, 404 for another's work, 503 for a fault and a malformed row", async () => {
  const fail = (code: string) => Object.assign(new Error("x"), { code });
  query.mockRejectedValueOnce(fail("ZD409"));
  expect((await send("PUT", note(), JSON.stringify({ sealed: SEALED }))).status).toBe(409);
  query.mockRejectedValueOnce(fail("ZD409"));
  expect((await send("PUT", key(), JSON.stringify({ ...KEY_WRITE, ifVersion: null }))).status).toBe(
    409,
  );
  query.mockRejectedValueOnce(fail("ZD403"));
  expect((await fetch(note(), { headers: cookie })).status).toBe(404);
  query.mockRejectedValueOnce(fail("ZD401"));
  expect((await fetch(key(), { headers: cookie })).status).toBe(401);
  query.mockRejectedValueOnce(new Error("boom"));
  expect((await fetch(note(), { headers: cookie })).status).toBe(503);
  query.mockResolvedValueOnce({ rows: [{ ...NOTE_ROW, ct: bytes(1, 1295) }], rowCount: 1 });
  expect((await fetch(note(), { headers: cookie })).status).toBe(503);
  query.mockResolvedValueOnce({ rows: [{ ...KEY_ROW, phraseSalt: "nije-bajt" }], rowCount: 1 });
  expect((await fetch(key(), { headers: cookie })).status).toBe(503);
  query.mockResolvedValueOnce({ rows: [KEY_ROW, KEY_ROW], rowCount: 2 });
  expect((await fetch(key(), { headers: cookie })).status).toBe(503);
});

it("refuses a missing session, a wrong media type, broken JSON and a work id that is not one", async () => {
  expect((await fetch(note())).status).toBe(401);
  expect((await fetch(key())).status).toBe(401);
  expect((await send("PUT", key(), "{}", { "content-type": "text/plain" })).status).toBe(415);
  expect((await send("PUT", note(), "{")).status).toBe(400);
  expect((await fetch(note("%20rad"), { headers: cookie })).status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

// SRV-NF6-SIFRA-2 (S2): starting over only under the key (and version) named.
const checked = (id = KEY_ID, search = "") => `${key()}/${id}${search}`;

it("starts over under the key named and passes the version, or null without one", async () => {
  query.mockResolvedValueOnce({ rows: [{ deleted: true }], rowCount: 1 });
  const named = await send("DELETE", checked(KEY_ID, "?ifVersion=2"));
  expect(named.status).toBe(200);
  expect(await named.json()).toEqual({ key: null });
  const [sql, args] = query.mock.calls[0]!;
  expect(sql).toMatch(/collaboration\.delete_self_note_key_checked\(\$1::uuid, \$2::integer\)/);
  expect(args).toEqual([KEY_ID, 2]);
  query.mockResolvedValueOnce({ rows: [{ deleted: true }], rowCount: 1 });
  expect((await send("DELETE", checked())).status).toBe(200);
  expect(query.mock.calls[1]![1]).toEqual([KEY_ID, null]);
});

it("answers 409 when the key or the version named is not the one kept, and 503 for a row that is not a deletion", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD409" }));
  const stale = await send("DELETE", checked(KEY_ID, "?ifVersion=1"));
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { code: string }).code).toBe("conflict");
  query.mockResolvedValueOnce({ rows: [{ deleted: false }], rowCount: 1 });
  expect((await send("DELETE", checked())).status).toBe(503);
});

it.each([
  ["an uppercase key id", KEY_ID.toUpperCase(), ""],
  ["a key id that is not a UUID", "nije-kljuc", ""],
  ["version 0", KEY_ID, "?ifVersion=0"],
  ["a signed version", KEY_ID, "?ifVersion=%2B1"],
  ["a leading zero", KEY_ID, "?ifVersion=01"],
  ["a version of ten digits", KEY_ID, "?ifVersion=1000000000"],
  ["an empty version", KEY_ID, "?ifVersion="],
  ["the version twice", KEY_ID, "?ifVersion=1&ifVersion=1"],
  ["another parameter", KEY_ID, "?keyVersion=1"],
])(
  "refuses a checked start over with %s and never reaches the database",
  async (_name, id, search) => {
    expect((await send("DELETE", checked(id, search))).status).toBe(422);
    expect(query).not.toHaveBeenCalled();
  },
);

it("refuses a checked start over without a session, with a body or from another site", async () => {
  expect((await fetch(checked(), { method: "DELETE", headers: { origin: ORIGIN } })).status).toBe(
    401,
  );
  expect((await send("DELETE", checked(), "{}")).status).toBe(413);
  expect(
    (await send("DELETE", checked(), undefined, { origin: "https://drugo.invalid" })).status,
  ).toBe(403);
  expect(query).not.toHaveBeenCalled();
});
