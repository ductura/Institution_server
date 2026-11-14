// Functional check: a user can open their own document,
// and an attempt to open someone else's document is refused.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createApp } from "./app.ts";
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
