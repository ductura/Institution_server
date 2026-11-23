// OBJ-KONFIG (Ductus#2055): render.staging.yaml, the Render Blueprint of the
// staging, held to render.yaml, to the code and to docs/STAGING.md. Staging is
// built from the migration branch (owner decision 23. 11. 2026.,
// c.7101552311). Nothing here talks to Render.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

type EnvVar = { key: string; sync?: boolean; value?: unknown; [other: string]: unknown };
type Service = {
  type: string;
  name: string;
  region: string;
  branch?: string;
  autoDeployTrigger?: string;
  envVars: EnvVar[];
  [other: string]: unknown;
};
type Database = {
  name: string;
  region: string;
  databaseName: string;
  postgresMajorVersion: string;
};
type Blueprint = { services: Service[]; databases: Database[] };

const staging = parse(read("render.staging.yaml")) as Blueprint;
const production = parse(read("render.yaml")) as Blueprint;
const SERVER = "ductura-institution-server-staging";
/** STG-OIDC: the fake OIDC provider of the staging, its own service (U9). */
const FAKE_OIDC = "ductura-fake-oidc-staging";
const byName = (name: string) => staging.services.find((s) => s.name === name)!;
const service = byName(SERVER);
const fakeOidc = byName(FAKE_OIDC);
const keys = service.envVars.map((v) => v.key);
const productionKeys = production.services[0]!.envVars.map((v) => v.key);

/** The switch of STG-PRIJAVA that lets the production build take the fake provider. */
const STAGING_SWITCH = "DUCTURA_DEPLOYMENT";
const BRANCH = "migracija/kopija-ductus-backend";

describe("render.staging.yaml", () => {
  it("is the production stage of infra/web/Dockerfile from the migration branch, never deployed by a push", () => {
    expect(staging.services.map((s) => s.name)).toEqual([SERVER, FAKE_OIDC]);
    const { branch, autoDeployTrigger, name, envVars, ...image } = service;
    const {
      name: productionName,
      envVars: productionVars,
      ...productionImage
    } = production.services[0]!;
    // The same image, region and health check as production; no dockerTarget,
    // so the test-server stage never reaches Render (D-09).
    expect(image).toEqual(productionImage);
    expect(Object.keys(service)).not.toContain("dockerTarget");
    expect(branch).toBe(BRANCH);
    expect(autoDeployTrigger).toBe("off");
    expect(name).not.toBe(productionName);
    expect(envVars.length).toBeGreaterThan(productionVars.length - 1);
  });

  it("names every variable without a value: each is entered in Render, none is in the repository", () => {
    for (const variable of [...service.envVars, ...fakeOidc.envVars]) {
      expect(variable).toEqual({ key: variable.key, sync: false });
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names every variable of production and the staging switch", () => {
    expect([...keys].sort()).toEqual([...productionKeys, STAGING_SWITCH].sort());
  });

  it("never sets a switch of local work or tests", () => {
    for (const name of [
      "NODE_ENV",
      "DUCTURA_MODE",
      "DUCTUS_DEV_SIGNING_KEY_FILE",
      "HOST",
      "PORT",
    ]) {
      expect(keys).not.toContain(name);
    }
  });

  it("keeps the staging switch out of production", () => {
    expect(productionKeys).not.toContain(STAGING_SWITCH);
    expect(read("render.yaml")).not.toContain(STAGING_SWITCH);
  });

  it("has its own databases, in the service's region, on the PostgreSQL major of CI", () => {
    const ci = read(".github/workflows/ci.yml").match(/postgresql\/(\d+)\/bin/u)?.[1];
    expect(staging.databases.map((d) => d.databaseName)).toEqual(
      production.databases.map((d) => d.databaseName),
    );
    const productionNames = new Set(production.databases.map((d) => d.name));
    for (const database of staging.databases) {
      expect(productionNames.has(database.name)).toBe(false);
      expect(database.region).toBe(service.region);
      expect(database.postgresMajorVersion).toBe(ci);
    }
  });

  it("is described in docs/STAGING.md, every variable by name, with the branch and the Blueprint path", () => {
    const doc = read("docs/STAGING.md");
    for (const name of keys) expect(doc).toContain(`\`${name}\``);
    expect(doc).toContain(`\`${BRANCH}\``);
    expect(doc).toContain("`render.staging.yaml`");
    for (const database of staging.databases) expect(doc).toContain(`\`${database.name}\``);
  });

  it("runs the fake OIDC provider as its own service from infra/fake-oidc/Dockerfile (STG-OIDC)", () => {
    const { envVars, ...rest } = fakeOidc;
    expect(rest).toEqual({
      type: "web",
      name: FAKE_OIDC,
      runtime: "docker",
      region: service.region,
      branch: BRANCH,
      autoDeployTrigger: "off",
      dockerfilePath: "./infra/fake-oidc/Dockerfile",
      dockerContext: ".",
      healthCheckPath: "/.well-known/openid-configuration",
    });
    // The staging switch is fixed in its image; these four are entered in Render.
    expect(envVars.map((v) => v.key).sort()).toEqual(
      ["APP_ORIGIN", "FAKE_OIDC_CLIENT_SECRET", "FAKE_OIDC_COOKIE_KEY", "ISSUER"].sort(),
    );
    expect(read("infra/fake-oidc/Dockerfile")).toMatch(/^ENV DUCTURA_DEPLOYMENT=staging /mu);
  });

  it("keeps the fake OIDC provider out of production", () => {
    expect(production.services.map((s) => s.name)).not.toContain(FAKE_OIDC);
    expect(read("render.yaml")).not.toContain("fake-oidc");
  });

  it("describes the fake OIDC service and its variables in docs/STAGING.md", () => {
    const doc = read("docs/STAGING.md");
    expect(doc).toContain(`\`${FAKE_OIDC}\``);
    expect(doc).toContain("`infra/fake-oidc/Dockerfile`");
    for (const { key } of fakeOidc.envVars) expect(doc).toContain(`\`${key}\``);
  });
});
