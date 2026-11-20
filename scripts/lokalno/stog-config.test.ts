import { describe, expect, it } from "vitest";

import { parseFlags, stackOptions } from "./index.ts";
import {
  COMPOSE_DATABASE_URL,
  databaseFor,
  frontEnv,
  frontScript,
  healthTargets,
  loginLink,
  stogOptions,
} from "./stog-config.ts";

describe("stogOptions", () => {
  it("defaults to the sibling front on 3000 with the compose database", () => {
    const options = stogOptions("/work/Institution_server", {});
    expect(options.frontDir).toBe("/work/Institution_front_web_chrome");
    expect(options.origin).toBe("http://localhost:3000");
    expect(options.composeDatabase).toBe(true);
  });
  it("takes a configurable front folder, port and external database", () => {
    const options = stogOptions("/work/s", {
      STOG_FRONT_DIR: "/x/front",
      STOG_FRONT_PORT: "3100",
      STOG_BAZA: "vanjska",
    });
    expect(options).toMatchObject({
      frontDir: "/x/front",
      frontPort: 3100,
      composeDatabase: false,
    });
    expect(databaseFor(options, { DATABASE_URL: "postgres://u@localhost/ductus" })).toContain(
      "localhost",
    );
  });
  it("refuses bad ports and databases", () => {
    expect(() => stogOptions("/", { STOG_FRONT_PORT: "4000" })).toThrow("collides");
    expect(() => stogOptions("/", { STOG_FRONT_PORT: "x" })).toThrow("STOG_FRONT_PORT");
    expect(() => stogOptions("/", { STOG_BAZA: "prod" })).toThrow("STOG_BAZA");
  });
  it("uses the compose database by default", () => {
    expect(databaseFor(stogOptions("/", {}), {})).toBe(COMPOSE_DATABASE_URL);
  });
});

describe("front wiring", () => {
  const options = stogOptions("/w/s", {});
  it("prefers next:dev, falls back to dev", () => {
    expect(frontScript({ scripts: { dev: "a", "next:dev": "b" } })).toBe("next:dev");
    expect(frontScript({ scripts: { dev: "a" } })).toBe("dev");
    expect(frontScript({ scripts: {} })).toBeUndefined();
    expect(frontScript(null)).toBeUndefined();
  });
  it("points the front's /api/v1 at the server, not the edge", () => {
    const env = frontEnv(options, { PATH: "/bin" });
    expect(env.INSTITUTION_SERVER_URL).toBe("http://127.0.0.1:4000");
    expect(env.PORT).toBe("3000");
    expect(env.PATH).toBe("/bin");
  });
  it("sets the server's browser origin to the front", () => {
    const flags = parseFlags([`--izvor=${options.origin}`]);
    expect(flags.origin).toBe("http://localhost:3000");
    const stack = stackOptions(false, undefined, flags.origin);
    expect(stack.origin).toBe("http://localhost:3000");
    expect(loginLink(options)).toBe("http://localhost:3000/api/v1/auth/login?returnTo=/");
  });
  it("refuses a non-local origin", () => {
    expect(() => parseFlags(["--izvor=http://example.com"])).toThrow("localhost");
    expect(() => parseFlags(["--izvor=nope"])).toThrow("URL");
  });
});

describe("healthTargets", () => {
  it("covers database, simulator, server, front and the front's proxy", () => {
    const names = healthTargets(stogOptions("/", {})).map((t) => t.name);
    expect(names).toEqual(["postgres", "oidc", "server", "front", "front→server"]);
  });
  it("skips the Docker database when external", () => {
    const names = healthTargets(stogOptions("/", { STOG_BAZA: "vanjska" })).map((t) => t.name);
    expect(names).not.toContain("postgres");
  });
});
