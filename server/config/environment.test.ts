import { describe, expect, it } from "vitest";

import { environmentProblems } from "./environment.ts";

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
