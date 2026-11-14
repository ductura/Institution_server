import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadAuthConfig } from "../external/srce-auth/index.ts";

// Ported from Ductus tests/unit/auth/build-mode.test.ts at d52a92c3 (S-0.18).
// D-09 rests there on `next build` fixing NODE_ENV to "production" and on
// deps.ts passing that literal to loadAuthConfig. The server has no Next.js
// build, so the same invariant is checked where it now lives: nothing in the
// repository starts the server with a development NODE_ENV, and a NODE_ENV the
// server is started without counts as production, so it can never select the
// fake provider. The deps.ts literal moves with deps.ts (S-1E-a).
const ROOT = process.cwd();
const FAKE = {
  DUCTUS_AUTH_PROVIDER: "fake-oidc",
  OIDC_ISSUER: "http://127.0.0.1:9400",
  OIDC_CLIENT_ID: "ductus-test",
  OIDC_CLIENT_SECRET: "test-only-client-secret",
  OIDC_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
};

describe("build mode", () => {
  it("never builds with development NODE_ENV", () => {
    // No Next.js build that could fix NODE_ENV (allowDevelopmentBuild).
    for (const name of ["next.config.ts", "next.config.js", "next.config.mjs"]) {
      expect(existsSync(join(ROOT, name))).toBe(false);
    }
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts.start).toBeDefined();
    expect(scripts.start).not.toMatch(/NODE_ENV/);
    expect(JSON.stringify(scripts)).not.toContain("allowDevelopmentBuild");
  });

  it("treats a server started without NODE_ENV as production for the login configuration", () => {
    expect(() => loadAuthConfig(FAKE)).toThrow(/prohibited in production/);
    expect(() => loadAuthConfig({ ...FAKE, NODE_ENV: "" })).toThrow(/prohibited in production/);
  });
});
