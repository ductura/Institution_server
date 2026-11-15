// DAN-759, D-09: the VS-1 stack starts the fake OIDC provider, so it must
// refuse every environment but local and ci before anything starts.
import { describe, expect, it } from "vitest";

import { assertFakeOidcAllowed } from "@ductura/test-fakes/oidc";

import {
  ALLOWED_NODE_ENV,
  DEFAULT_PORTS,
  parseArgs,
  SLOTS,
  stackConfig,
  stackPorts,
} from "./index.ts";

describe("parseArgs", () => {
  it.each([
    [["up"], { command: "up", env: "local" }],
    [["up", "--env", "local"], { command: "up", env: "local" }],
    [["up", "--env", "ci"], { command: "up", env: "ci" }],
    [["down"], { command: "down", env: "local" }],
    [["status"], { command: "status", env: "local" }],
  ])("accepts %j", (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each([
    [["up", "--env", "production"]],
    [["up", "--env", "staging"]],
    [["up", "--env", "LOCAL"]],
    [["up", "--env", "ci "]],
    [["up", "--env", ""]],
    [["up", "--env"]],
    [["up", "--env=ci"]],
    [["up", "--env", "ci", "--env", "production"]],
    [["up", "--env", "local", "--production"]],
    [["up", "--production"]],
    [["down", "--env", "ci"]],
    [["start"]],
    [[]],
  ])("refuses %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe("stackConfig", () => {
  it("runs as local or ci under a local NODE_ENV", () => {
    for (const nodeEnv of [undefined, "", "development", "test"]) {
      expect(stackConfig("ci", { NODE_ENV: nodeEnv }).env).toBe("ci");
    }
    expect(stackConfig("local", {}).ports).toEqual(DEFAULT_PORTS);
  });

  it.each(["production", "Production", "staging", "prod", " test"])(
    "refuses NODE_ENV=%j, for local and ci alike",
    (nodeEnv) => {
      expect(() => stackConfig("local", { NODE_ENV: nodeEnv })).toThrow(/fake OIDC/u);
      expect(() => stackConfig("ci", { NODE_ENV: nodeEnv })).toThrow(/fake OIDC/u);
    },
  );

  it("allows exactly the NODE_ENV values the fake provider allows", () => {
    for (const nodeEnv of [...ALLOWED_NODE_ENV, "production", "staging", "TEST", "dev", " "]) {
      const provider = ((): boolean => {
        try {
          assertFakeOidcAllowed({ NODE_ENV: nodeEnv });
          return true;
        } catch {
          return false;
        }
      })();
      expect(ALLOWED_NODE_ENV.has(nodeEnv)).toBe(provider);
    }
  });

  it("refuses a stack environment that is not local or ci, even when cast", () => {
    expect(() => stackConfig("production" as "local", {})).toThrow(/local or ci/u);
  });
});

describe("stackPorts", () => {
  it.each(["3000", "3001", "3002", "3003", "3004"])("refuses port %s", (port) => {
    for (const name of ["VS1_POSTGRES_PORT", "VS1_SERVER_PORT", "VS1_OIDC_PORT"]) {
      expect(() => stackPorts({ [name]: port })).toThrow(/3000-3004/u);
    }
  });

  it.each(["", "0", "80", "1023", "65536", "4100 ", "0x1004", "41.0", "-4100"])(
    "refuses the port value %j",
    (port) => {
      expect(() => stackPorts({ VS1_SERVER_PORT: port })).toThrow(/VS1_SERVER_PORT/u);
    },
  );

  it("refuses one port for two services", () => {
    expect(() => stackPorts({ VS1_SERVER_PORT: "4180" })).toThrow(/differ/u);
  });

  it("takes set ports", () => {
    expect(
      stackPorts({ VS1_POSTGRES_PORT: "55000", VS1_SERVER_PORT: "4200", VS1_OIDC_PORT: "4280" }),
    ).toEqual({
      postgres: 55000,
      server: 4200,
      oidc: 4280,
    });
  });
});

describe("SLOTS", () => {
  it("keeps the preloader at / and the web app at /app/, both not attached yet", () => {
    expect(SLOTS).toEqual({
      preloader: { path: "/", artifact: null },
      web: { path: "/app/", artifact: null },
    });
    expect(Object.isFrozen(SLOTS.web)).toBe(true);
  });
});
