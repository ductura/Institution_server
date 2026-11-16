// Functional check: a user can open their own document,
// and an attempt to open someone else's document is refused.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, expect, it } from "vitest";

import { APP_ERRORS, createApp } from "./app.ts";
import { createStore } from "./store.ts";

const A = "student-a@primjer.invalid";
const B = "student-b@primjer.invalid";

let server: Server;
let base: string;

beforeAll(async () => {
  const store = createStore([
    { id: "a-1", ownerId: A, title: "Rad studenta A", content: "Uvod" },
    { id: "b-1", ownerId: B, title: "Rad studenta B", content: "Tajno" },
  ]);
  server = createApp({ store }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const as = (userId: string) => ({ headers: { authorization: `Bearer ${userId}` } });

it("health answers without login", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("a user opens their own document", async () => {
  const res = await fetch(`${base}/api/documents/a-1`, as(A));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { title: string }).title).toBe("Rad studenta A");
});

it("access to someone else's document is refused", async () => {
  const res = await fetch(`${base}/api/documents/b-1`, as(A));
  expect(res.status).toBe(403);
  expect(await res.text()).not.toMatch(/Tajno/);
});

it("without login there is no access", async () => {
  const res = await fetch(`${base}/api/documents/a-1`);
  expect(res.status).toBe(401);
});

it("another user cannot change the document", async () => {
  const res = await fetch(`${base}/api/documents/b-1`, {
    method: "PUT",
    ...as(A),
    body: JSON.stringify({ content: "x" }),
  });
  expect(res.status).toBe(403);
  const check = await fetch(`${base}/api/documents/b-1`, as(B));
  expect(((await check.json()) as { content: string }).content).toBe("Tajno");
});

// DAN-782: every error answers {code, messageKey}, never a sentence.
it.each([
  ["no login", "/api/documents/a-1", {}, APP_ERRORS.loginRequired],
  ["unknown path", "/api/nepoznato/x/y", as(A), APP_ERRORS.notFound],
  ["unknown document", "/api/documents/nema-1", as(A), APP_ERRORS.documentNotFound],
  ["someone else's document", "/api/documents/b-1", as(A), APP_ERRORS.documentReadForbidden],
  [
    "change of someone else's document",
    "/api/documents/b-1",
    { method: "PUT", ...as(A), body: "{}" },
    APP_ERRORS.documentWriteForbidden,
  ],
  [
    "unsupported method",
    "/api/documents/a-1",
    { method: "DELETE", ...as(A) },
    APP_ERRORS.methodNotAllowed,
  ],
] as const)("answers %s with a code and a key", async (_name, route, init, expected) => {
  const res = await fetch(`${base}${route}`, init);
  expect(res.status).toBe(expected.status);
  const raw = await res.text();
  expect(JSON.parse(raw)).toEqual(expected.body);
  expect(raw).toMatch(/^[\x20-\x7e]*$/u);
  expect(raw).not.toMatch(/"error"/u);
});
