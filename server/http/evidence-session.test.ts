// DAN-805, plan of attack ductura/server#98 parts C and D: the session step of
// the evidence routes on IncomingMessage, against the contract vectors
// (DAN-758). Every token and identifier is invented.
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorReader, CurrentActor } from "../session/index.ts";

import { evidenceSession } from "./evidence-session.ts";

const TOKEN = "T".repeat(20) + "_-" + "t".repeat(21);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const LIVE_ACTOR = {
  userId: "00000000-0000-4000-8000-0000000000a1",
  institutionId: "00000000-0000-4000-8000-0000000000b2",
};

type Vector = {
  name: string;
  response: { status: number; headers: Record<string, string>; body: unknown };
};
function vector(route: string, name: string): Vector["response"] {
  const file = new URL(`../contracts/vectors/${route}.json`, import.meta.url);
  const { vectors } = JSON.parse(readFileSync(file, "utf8")) as { vectors: Vector[] };
  const found = vectors.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no vector ${route} ${name}`);
  return found.response;
}

// A request whose body records whether a byte was pulled.
function request(headers: Record<string, string>): IncomingMessage & { pulled: () => boolean } {
  let pulled = false;
  const body = new Readable({
    read() {
      pulled = true;
      this.push(null);
    },
  });
  return Object.assign(body, { headers, pulled: () => pulled }) as unknown as IncomingMessage & {
    pulled: () => boolean;
  };
}

function reader(answer: () => Promise<CurrentActor>): ActorReader & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async currentActor() {
      calls += 1;
      return answer();
    },
    async currentActorWithInstitution() {
      throw new Error("not used");
    },
  };
}

const live = { live: true, maxBytes: 1024 };
const refusalOf = (result: Awaited<ReturnType<typeof evidenceSession>>) => {
  if (result.ok) throw new Error("expected a refusal");
  return { status: result.status, headers: result.headers, body: result.body };
};

afterEach(() => vi.restoreAllMocks());

describe("evidenceSession", () => {
  it("passes a live session with its token, verified, without reading the body", async () => {
    const req = request({ cookie: COOKIE, "content-length": "10" });
    const actors = reader(async () => LIVE_ACTOR);
    expect(await evidenceSession(req, actors, live)).toEqual({
      ok: true,
      token: TOKEN,
      verified: true,
    });
    expect(actors.calls()).toBe(1);
    expect(req.pulled()).toBe(false);
  });

  it("C5, C6: 401 is exactly the unauthenticated vector of open and commit", async () => {
    const result = refusalOf(
      await evidenceSession(
        request({}),
        reader(async () => LIVE_ACTOR),
        live,
      ),
    );
    for (const route of ["evidence.open.post", "evidence.commit.post"]) {
      const expected = vector(route, "unauthenticated");
      expect(result).toEqual({
        status: expected.status,
        headers: expected.headers,
        body: expected.body,
      });
    }
  });

  it("C2: a dead session of the right form is 401 before a body byte is read", async () => {
    const req = request({ cookie: COOKIE, "content-length": "1024" });
    const result = await evidenceSession(
      req,
      reader(async () => ({ userId: null, institutionId: null })),
      live,
    );
    expect(refusalOf(result).status).toBe(401);
    expect(req.pulled()).toBe(false);
  });

  it("B7, C6: a database that cannot answer is the 503 context vector, never 401", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = reader(async () => {
      throw new Error("connection terminated");
    });
    const expected = vector("evidence.open.post", "unavailable");
    expect(refusalOf(await evidenceSession(request({ cookie: COOKIE }), failing, live))).toEqual({
      status: expected.status,
      headers: expected.headers,
      body: expected.body,
    });
  });

  it("C1: a declared length the body reader refuses is not worth a database round trip", async () => {
    for (const length of ["1025", "99999999", "01", "-1", "1e3"]) {
      const actors = reader(async () => LIVE_ACTOR);
      const req = request({ cookie: COOKIE, "content-length": length });
      expect(await evidenceSession(req, actors, live)).toEqual({
        ok: true,
        token: TOKEN,
        verified: false,
      });
      expect(actors.calls()).toBe(0);
      expect(req.pulled()).toBe(false);
    }
  });

  it("C3: without live the form alone passes, and the database is not asked", async () => {
    const actors = reader(async () => ({ userId: null, institutionId: null }));
    const result = await evidenceSession(request({ cookie: COOKIE }), actors, {
      live: false,
      maxBytes: 1024,
    });
    expect(result).toEqual({ ok: true, token: TOKEN, verified: false });
    expect(actors.calls()).toBe(0);
  });

  it("A3 over HTTP: a planted second session cookie is 401 without asking the database", async () => {
    const actors = reader(async () => LIVE_ACTOR);
    const req = request({ cookie: `${COOKIE}; __Host-ductus_session=${"p".repeat(43)}` });
    expect(refusalOf(await evidenceSession(req, actors, live)).status).toBe(401);
    expect(actors.calls()).toBe(0);
  });

  it("B6: identity in headers is ignored; only the token is presented", async () => {
    const seen: string[] = [];
    const actors: ActorReader = {
      async currentActor(token) {
        seen.push(token);
        return LIVE_ACTOR;
      },
      async currentActorWithInstitution() {
        throw new Error("not used");
      },
    };
    const req = request({
      cookie: COOKIE,
      "x-user-id": "someone-else",
      "x-institution-id": "other",
    });
    expect(await evidenceSession(req, actors, live)).toEqual({
      ok: true,
      token: TOKEN,
      verified: true,
    });
    expect(seen).toEqual([TOKEN]);
  });

  it("C4: a step that throws anywhere is 503 context, never a pass", async () => {
    const broken = {
      get headers(): never {
        throw new Error("broken headers");
      },
    } as unknown as IncomingMessage;
    expect(
      refusalOf(
        await evidenceSession(
          broken,
          reader(async () => LIVE_ACTOR),
          live,
        ),
      ).status,
    ).toBe(503);
  });

  it("D1: no refusal carries set-cookie, and refusals cannot be changed by a caller", async () => {
    const results = [
      await evidenceSession(
        request({}),
        reader(async () => LIVE_ACTOR),
        live,
      ),
      await evidenceSession(
        request({ cookie: COOKIE }),
        reader(async () => Promise.reject(new Error("x"))),
        live,
      ),
    ];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const result of results) {
      const refusal = refusalOf(result);
      expect(Object.keys(refusal.headers).map((name) => name.toLowerCase())).not.toContain(
        "set-cookie",
      );
      expect(Object.isFrozen(refusal.headers) && Object.isFrozen(refusal.body)).toBe(true);
    }
  });

  it("B9: the token never reaches a log line, an error or the answer", async () => {
    const lines: unknown[][] = [];
    for (const method of ["error", "warn", "log", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args));
    }
    const failing = reader(async () => {
      throw new Error(`database said ${TOKEN}`);
    });
    const result = await evidenceSession(request({ cookie: COOKIE }), failing, live);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).not.toContain("database said");
  });
});
