// SRV-NF6-SIFRA on the dev fake server: the sealed note comes back byte for
// byte, needs the key its owner keeps now, is 404 for anyone else, and goes
// with the key; a key is set once and rewrapped only under its version.
// Invented bytes only.
import { describe, expect, it } from "vitest";

import { createState, IDS } from "./index.ts";
import { contractProblems, send, signIn } from "./testing.ts";

const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };
const NOTE = `/api/v1/works/${IDS.document}/sealed-self-note`;
const KEY = "/api/v1/me/self-note-key";
const B64 = (byte: number, length: number) => Buffer.alloc(length, byte).toString("base64url");
const KEY_ID = "6f1e2d3c-4b5a-4968-8776-6554433221a1";
const KEY_BODY = {
  v: 1,
  keyId: KEY_ID,
  kdf: { alg: "PBKDF2-SHA-256", iterations: 600000 },
  phrase: { salt: B64(1, 16), iv: B64(2, 12), ct: B64(3, 48) },
  recovery: { salt: B64(4, 16), iv: B64(5, 12), ct: B64(6, 48) },
};
const SEALED = { v: 1, keyId: KEY_ID, iv: B64(7, 12), ct: B64(8, 1296) };

describe("sealed note to self", () => {
  it("keeps the ciphertext unchanged for the owner under the current key", async () => {
    const state = createState();
    const student = { ...(await signIn(state, "student")), ...ORIGIN };
    const other = { ...(await signIn(state, "student-2")), ...ORIGIN };
    const teacher = { ...(await signIn(state, "nastavnik")), ...ORIGIN };

    const early = await send(state, NOTE, {
      method: "PUT",
      headers: student,
      body: { sealed: SEALED },
    });
    expect(early.status).toBe(409);

    const set = await send(state, KEY, {
      method: "PUT",
      headers: student,
      body: { ...KEY_BODY, ifVersion: null },
    });
    expect(contractProblems("me.self-note-key.put", set)).toEqual([]);
    expect(set.json).toMatchObject({ key: { ...KEY_BODY, version: 1 } });
    const again = await send(state, KEY, {
      method: "PUT",
      headers: student,
      body: { ...KEY_BODY, ifVersion: null },
    });
    expect(again.status).toBe(409);
    const stale = await send(state, KEY, {
      method: "PUT",
      headers: student,
      body: { ...KEY_BODY, ifVersion: 2 },
    });
    expect(stale.status).toBe(409);
    const rewrapped = await send(state, KEY, {
      method: "PUT",
      headers: student,
      body: { ...KEY_BODY, phrase: { ...KEY_BODY.phrase, salt: B64(9, 16) }, ifVersion: 1 },
    });
    expect(rewrapped.json).toMatchObject({ key: { version: 2, keyId: KEY_ID } });
    expect((await send(state, KEY, { headers: other })).json).toEqual({ key: null });

    const put = await send(state, NOTE, {
      method: "PUT",
      headers: student,
      body: { sealed: SEALED },
    });
    expect(contractProblems("work.sealed-self-note.put", put)).toEqual([]);
    expect(put.json).toMatchObject({ note: { sealed: SEALED } });
    expect((await send(state, NOTE, { headers: student })).json).toMatchObject({
      note: { sealed: SEALED },
    });
    expect((await send(state, NOTE, { headers: teacher })).status).toBe(404);
    expect((await send(state, NOTE, { headers: other })).status).toBe(404);
    const otherKey = await send(state, NOTE, {
      method: "PUT",
      headers: student,
      body: { sealed: { ...SEALED, keyId: "6f1e2d3c-4b5a-4968-8776-6554433221d1" } },
    });
    expect(otherKey.status).toBe(409);

    await send(state, `/api/v1/works/${IDS.document}/reading-place`, {
      method: "PUT",
      headers: student,
      body: { place: { nodeId: "1f0e2d3c-4b5a-4968-8776-655443322110", offset: 4 } },
    });
    const gone = await send(state, KEY, { method: "DELETE", headers: student });
    expect(gone.json).toEqual({ key: null });
    expect((await send(state, NOTE, { headers: student })).json).toMatchObject({
      note: null,
      readingPlace: { place: { offset: 4 } },
    });
  });
});
