// DAN-811 part a, plan of attack ductura/server#107 part B: the closed JSON
// object of an evidence body, from strict UTF-8. Identifiers are invented.
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { ActorReader } from "../database/index.ts";

import { parseClosedObject, readEvidenceBody } from "./evidence-request.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (text: string, keys = ["assignmentId"]) => parseClosedObject(bytes(text), keys);

describe("parseClosedObject", () => {
  it("takes an object with exactly the keys", () => {
    expect(parse(`{"assignmentId":"${A}"}`)).toEqual({ assignmentId: A });
    expect(parse(`{"start":true,"assignmentId":"${A}"}`, ["assignmentId", "start"])).toEqual({
      assignmentId: A,
      start: true,
    });
  });

  it.each([
    ["an empty body", ""],
    ["null", "null"],
    ["an array", `["${A}"]`],
    ["a number", "1"],
    ["a string", `"${A}"`],
    ["trailing data", `{"assignmentId":"${A}"} {}`],
    ["a missing key", "{}"],
    ["an unknown key", `{"assignmentId":"${A}","role":"teacher"}`],
    ["a user id next to the key", `{"assignmentId":"${A}","userId":"${B}"}`],
    ["__proto__", `{"assignmentId":"${A}","__proto__":{"start":true}}`],
    ["constructor", `{"assignmentId":"${A}","constructor":1}`],
    ["a key only in another case", `{"AssignmentId":"${A}"}`],
    ["a key with a trailing space", `{"assignmentId ":"${A}"}`],
  ])("B4/B5: %s is null", (_name, text) => {
    expect(parse(text)).toBeNull();
  });

  it("B4: a byte order mark before the object is null, not skipped", () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(`{"assignmentId":"${A}"}`)]);
    expect(parseClosedObject(body, ["assignmentId"])).toBeNull();
  });

  it.each([
    ["a lone continuation byte", [0x80]],
    ["an overlong slash", [0xc0, 0xaf]],
    ["a surrogate half", [0xed, 0xa0, 0x80]],
    ["a cut sequence", [0xe2, 0x82]],
  ])("B4: invalid UTF-8 (%s) in a value is null", (_name, bad) => {
    const head = bytes('{"assignmentId":"');
    const tail = bytes('"}');
    expect(
      parseClosedObject(new Uint8Array([...head, ...bad, ...tail]), ["assignmentId"]),
    ).toBeNull();
  });

  it("B5: __proto__ in the body never reaches the prototype", () => {
    expect(parse(`{"__proto__":{"polluted":true}}`, ["__proto__"])).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("B9: a repeated key keeps the last value, as JSON.parse in Ductus", () => {
    expect(parse(`{"assignmentId":"${A}","assignmentId":"${B}"}`)).toEqual({ assignmentId: B });
  });

  it("B10: deeply nested JSON inside the limit is a value, never a throw", () => {
    const deep = `{"assignmentId":${"[".repeat(500)}${"]".repeat(500)}}`;
    expect(() => parse(deep)).not.toThrow();
    expect(parse(deep)).toEqual({ assignmentId: expect.any(Array) });
  });
});

describe("readEvidenceBody: the session's own refusals keep their headers", () => {
  const TOKEN = "izmisljeni-token-evidencije-000000000000001";
  function request(
    change: Record<string, string | undefined> = {},
  ): IncomingMessage & { pulled: () => boolean } {
    let pulled = false;
    const body = new Readable({
      read() {
        pulled = true;
        this.push(null);
      },
    });
    const all: Record<string, string | undefined> = {
      "ductus-protocol": "1",
      "content-type": "application/json",
      cookie: `__Host-ductus_session=${TOKEN}`,
      ...change,
    };
    const headers = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));
    const distinct = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]]));
    return Object.assign(body, {
      headers,
      headersDistinct: distinct,
      pulled: () => pulled,
    }) as never;
  }
  const actors = (answer: () => Promise<{ userId: string | null; institutionId: string | null }>) =>
    ({
      currentActor: answer,
      currentActorWithInstitution: () => Promise.reject(new Error("not used")),
    }) as ActorReader;
  const limits = { protocols: ["1"], maxBytes: 1024, timeoutMs: 1000, live: true };

  const counted = () => {
    let calls = 0;
    const reader = {
      currentActor: async () => {
        calls += 1;
        return {
          userId: "00000000-0000-4000-8000-0000000000e1",
          institutionId: "00000000-0000-4000-8000-0000000000e2",
        };
      },
      currentActorWithInstitution: () => Promise.reject(new Error("not used")),
    } as ActorReader;
    return { reader, calls: () => calls };
  };

  it.each([
    ["no protocol", { "ductus-protocol": undefined }, 426],
    ["protocol 2", { "ductus-protocol": "2" }, 426],
    ["no media type", { "content-type": undefined }, 415],
    ["text/plain", { "content-type": "text/plain" }, 415],
    ["no cookie", { cookie: undefined }, 401],
    ["a cookie of the wrong form", { cookie: "__Host-ductus_session=kratko" }, 401],
  ])(
    "A1, A2, A5: %s is %s before a single body byte and before the database",
    async (_name, change, status) => {
      const r = request(change);
      const { reader, calls } = counted();
      const read = await readEvidenceBody(r, reader, limits);
      expect(read.ok === false && read.answer.status).toBe(status);
      expect(r.pulled()).toBe(false);
      expect(calls()).toBe(0);
    },
  );

  it("the body is read only after every check passed", async () => {
    const r = request();
    const { reader, calls } = counted();
    const read = await readEvidenceBody(r, reader, limits);
    expect(read.ok).toBe(true);
    expect(r.pulled()).toBe(true);
    expect(calls()).toBe(1);
  });

  it("a database that cannot answer is 503 context with retry-after 5, the body unread", async () => {
    const r = request();
    const read = await readEvidenceBody(
      r,
      actors(() => Promise.reject(new Error("down"))),
      limits,
    );
    expect(read).toEqual({
      ok: false,
      answer: {
        status: 503,
        body: { status: "unavailable", stage: "context" },
        headers: { "retry-after": "5" },
        close: true,
      },
    });
    expect(r.pulled()).toBe(false);
  });

  it("a closed session is 401 without retry-after", async () => {
    const read = await readEvidenceBody(
      request(),
      actors(async () => ({ userId: null, institutionId: null })),
      limits,
    );
    expect(read).toEqual({
      ok: false,
      answer: { status: 401, body: { status: "unauthenticated" }, headers: {}, close: true },
    });
  });
});
