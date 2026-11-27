// deploy-postavke (Ductus#2028): render.yaml, the Render Blueprint of this
// server, held to the code and to docs/DEPLOY.md. The variables are read from
// the source that uses them (the pools of server/database/registry.ts, the
// login of server/external/srce-auth/config.ts), not imported, so the test
// crosses no area boundary. Nothing here talks to Render.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

type EnvVar = { key: string; sync?: boolean; value?: unknown; [other: string]: unknown };
type Blueprint = {
  services: {
    type: string;
    name: string;
    runtime: string;
    region: string;
    dockerfilePath: string;
    dockerContext: string;
    healthCheckPath: string;
    envVars: EnvVar[];
  }[];
  databases: { name: string; region: string; databaseName: string; postgresMajorVersion: string }[];
};
const blueprint = parse(read("render.yaml")) as Blueprint;
const service = blueprint.services[0]!;
const keys = service.envVars.map((v) => v.key);

/** Every name in `pattern`'s first group, in the order found. */
const namesIn = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!);
// The worker process has its own login (F4-PM2-R01B, D-71, D-102): the web service of this
// Blueprint never gets it, and the test below holds that.
const WORKER_VARIABLE = "WORKER_DATABASE_URL";
const POOL_VARIABLES = namesIn(
  read("server/database/registry.ts"),
  /variable: "([A-Z_]+)"/gu,
).filter((name) => name !== WORKER_VARIABLE);
// The login's variables that loadAuthConfig requires (required() and url()).
const LOGIN_REQUIRED = [
  ...new Set(
    namesIn(read("server/external/srce-auth/config.ts"), /(?:required|url)\(env, "([A-Z_]+)"\)/gu),
  ),
];

describe("render.yaml", () => {
  it("is one Docker web service of the production stage of infra/web/Dockerfile", () => {
    expect(blueprint.services).toHaveLength(1);
    expect(service).toMatchObject({
      type: "web",
      runtime: "docker",
      dockerfilePath: "./infra/web/Dockerfile",
      dockerContext: ".",
      healthCheckPath: "/api/v1/health",
    });
    // No target: the last stage is production; the test-server stage never goes to Render (D-09).
    expect(Object.keys(service)).not.toContain("dockerTarget");
    expect(read("server/contracts/routes/platform.ts")).toContain('path: "/api/v1/health"');
  });

  it("names every variable without a value: each is entered in Render, none is in the repository", () => {
    for (const variable of service.envVars) {
      expect(variable).toEqual({ key: variable.key, sync: false });
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names every database pool and every variable the AAI@EduHr login requires", () => {
    expect(POOL_VARIABLES).toEqual([
      "APP_DATABASE_URL",
      "AUTH_DATABASE_URL",
      "LOGS_DATABASE_URL",
      "LEGAL_DATABASE_URL",
    ]);
    expect(LOGIN_REQUIRED).toEqual(
      expect.arrayContaining(["DUCTUS_AUTH_PROVIDER", "OIDC_ISSUER", "OIDC_CLIENT_SECRET"]),
    );
    for (const name of [...POOL_VARIABLES, ...LOGIN_REQUIRED, "APP_ORIGIN"]) {
      expect(keys).toContain(name);
    }
  });

  it("gives the web service no login of the worker process", () => {
    expect(read("server/database/registry.ts")).toContain(`variable: "${WORKER_VARIABLE}"`);
    expect(keys).not.toContain(WORKER_VARIABLE);
    expect(keys).not.toContain("WORKER_EVIDENCE_DOMAIN_ID");
  });

  it("never sets a switch of local work, tests or the fake provider", () => {
    for (const name of [
      "NODE_ENV",
      "DUCTURA_MODE",
      // STG-PRIJAVA: the production Blueprint is never staging; staging is set by hand.
      "DUCTURA_DEPLOYMENT",
      "DUCTUS_DEV_SIGNING_KEY_FILE",
      "HOST",
      "PORT",
    ]) {
      expect(keys).not.toContain(name);
    }
  });

  it("puts the databases in the service's region, on the PostgreSQL major of CI", () => {
    const ci = read(".github/workflows/ci.yml").match(/postgresql\/(\d+)\/bin/u)?.[1];
    expect(blueprint.databases.map((d) => d.databaseName)).toEqual(["ductus", "ductus_logs"]);
    for (const database of blueprint.databases) {
      expect(database.region).toBe(service.region);
      expect(database.postgresMajorVersion).toBe(ci);
    }
  });

  it("is described in docs/DEPLOY.md, every variable by name", () => {
    const doc = read("docs/DEPLOY.md");
    for (const name of keys) expect(doc).toContain(`\`${name}\``);
  });
});
