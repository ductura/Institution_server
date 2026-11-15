import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  environmentProblems,
  listenAddress,
  listenProblems,
  shutdownGraceMs,
  shutdownProblems,
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

// S-1B-c (DAN-778): the shutdown deadline. The validator is checked over the
// whole input range, not a sample: every whole number from 0 to 40 000 as
// written, and each with a sign, a leading zero, a space or a unit around it.
describe("shutdownProblems and shutdownGraceMs", () => {
  const PROBLEM = "SHUTDOWN_GRACE_MS is not a whole number from 100 to 30000";

  it("defaults to 8000 ms without the variable", () => {
    expect(shutdownProblems({})).toEqual([]);
    expect(shutdownGraceMs({})).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    expect(DEFAULT_SHUTDOWN_GRACE_MS).toBe(8_000);
  });

  it("accepts exactly the plain whole numbers from 100 to 30000", () => {
    const wrong: string[] = [];
    for (let n = 0; n <= 40_000; n += 1) {
      const plain = String(n);
      const ok = n >= 100 && n <= 30_000;
      if ((shutdownProblems({ SHUTDOWN_GRACE_MS: plain }).length === 0) !== ok) wrong.push(plain);
      if (ok && shutdownGraceMs({ SHUTDOWN_GRACE_MS: plain }) !== n) wrong.push(`value ${plain}`);
      for (const variant of [
        `0${plain}`,
        `+${plain}`,
        `-${plain}`,
        ` ${plain}`,
        `${plain} `,
        `${plain}ms`,
        `${plain}.0`,
        `${plain}e0`,
      ]) {
        if (shutdownProblems({ SHUTDOWN_GRACE_MS: variant }).length === 0) wrong.push(variant);
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    "",
    "abc",
    "1e3",
    "0x3e8",
    "1_000",
    "Infinity",
    "NaN",
    "１０００",
    "1000\n",
    "invented-secret",
  ])("refuses %j by the variable name only", (value) => {
    const problems = shutdownProblems({ SHUTDOWN_GRACE_MS: value });
    expect(problems).toEqual([PROBLEM]);
    expect(problems.join(" ")).not.toContain("invented-secret");
  });
});
