import { describe, expect, it } from "vitest";

import {
  appOrigin,
  environmentProblems,
  listenAddress,
  listenProblems,
  originProblems,
} from "./environment.ts";

// DAN-299: the startup check. Passwords and hosts below are invented.
const GOOD = "postgres://ductus_app_local:invented-secret@127.0.0.1:54329/ductus";

describe("environmentProblems", () => {
  it("accepts a postgres or postgresql URL with a host", () => {
    expect(environmentProblems({ APP_DATABASE_URL: GOOD })).toEqual([]);
    expect(
      environmentProblems({ APP_DATABASE_URL: "postgresql://u:p@db.example.invalid:5432/ductus" }),
    ).toEqual([]);
  });

  it("names a missing, empty, malformed or foreign value by its variable only", () => {
    const cases: [string | undefined, string][] = [
      [undefined, "APP_DATABASE_URL is not set"],
      ["", "APP_DATABASE_URL is not set"],
      ["   ", "APP_DATABASE_URL is not set"],
      ["invented-secret-not-a-url", "APP_DATABASE_URL is not a URL"],
      ["mysql://u:invented-secret@127.0.0.1/ductus", "APP_DATABASE_URL is not a postgres URL"],
      ["postgres:///ductus?password=invented-secret", "APP_DATABASE_URL names no host"],
    ];
    for (const [value, problem] of cases) {
      const problems = environmentProblems({ APP_DATABASE_URL: value });
      expect(problems, String(value)).toEqual([problem]);
      expect(problems.join(" ")).not.toContain("invented-secret");
    }
  });

  it("does not ask for the login variables, so a D-09 production build still starts", () => {
    expect(
      environmentProblems({
        APP_DATABASE_URL: GOOD,
        NODE_ENV: "production",
        DUCTUS_AUTH_PROVIDER: "fake-oidc",
      }),
    ).toEqual([]);
  });
});

// The two cases of describe("instrumentation register()") in Ductus
// src/server/env.test.ts (d52a92c3) test instrumentation.ts, the Next.js entry
// that refuses to start on these problems. They come with this repository's
// entry point (S-1B-a), which takes that role.

// S-1B-a (DAN-775): where the entry point listens.
describe("listenProblems and listenAddress", () => {
  it("defaults to the loopback and port 4000", () => {
    expect(listenProblems({})).toEqual([]);
    expect(listenAddress({})).toEqual({ host: "127.0.0.1", port: 4000 });
    expect(listenAddress({ PORT: "0", HOST: "0.0.0.0" })).toEqual({ host: "0.0.0.0", port: 0 });
  });

  it.each(["", "abc", "-1", "70000", "4000.5", " 4000", "0x10", "invented-secret"])(
    "refuses PORT %j by name only",
    (port) => {
      const problems = listenProblems({ PORT: port });
      expect(problems).toEqual(["PORT is not a port number"]);
      expect(problems.join(" ")).not.toContain("invented-secret");
    },
  );

  // Review and QA on 3332cee: a space inside the value passed.
  it.each(["", " ", " 0.0.0.0", "127.0 .0.1", "127.0.0.1\t", "local\nhost", "0.0.0.0\u00a0"])(
    "refuses HOST %j",
    (host) => {
      expect(listenProblems({ HOST: host })).toEqual(["HOST is empty or has spaces"]);
    },
  );
});

// S-1B-b (DAN-777): the origin a state-changing request must carry.
describe("originProblems and appOrigin", () => {
  it.each(["https://ductura.invalid", "http://127.0.0.1:4000", "https://ductura.invalid:8443"])(
    "accepts the bare origin %j",
    (origin) => {
      expect(originProblems({ APP_ORIGIN: origin })).toEqual([]);
      expect(appOrigin({ APP_ORIGIN: origin })).toBe(origin);
    },
  );

  it("is optional; without it every state-changing request is refused (null)", () => {
    expect(originProblems({})).toEqual([]);
    expect(appOrigin({})).toBeNull();
  });

  it.each([
    "",
    "null",
    "https://invented-secret.invalid/",
    "https://invented-secret.invalid/x",
    "https://INVENTED-SECRET.invalid",
    "ftp://invented-secret.invalid",
    "file:///invented-secret",
    "invented-secret.invalid",
    " https://invented-secret.invalid",
    "https://user:invented-secret@ductura.invalid",
  ])("refuses APP_ORIGIN %j by name only and never uses it", (origin) => {
    const problems = originProblems({ APP_ORIGIN: origin });
    expect(problems).toEqual(["APP_ORIGIN is not a bare http(s) origin"]);
    expect(problems.join(" ")).not.toContain("invented-secret");
    expect(appOrigin({ APP_ORIGIN: origin })).toBeNull();
  });
});
