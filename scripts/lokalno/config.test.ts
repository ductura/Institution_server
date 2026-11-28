// The configuration of `pnpm lokalno` (Ductus#2028, contract §1 and §3.2).
// No PostgreSQL: the database steps are run by hand (docs/LOKALNO.md).
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadAuthConfig } from "../../server/external/srce-auth/index.ts";
import {
  demoAccountClaims,
  parseSimulatedAccountsFile,
} from "../../packages/test-fakes/oidc/index.ts";
import {
  accountsFileFor,
  adminTarget,
  assertLocal,
  baseEnv,
  PORTS,
  ensureSecrets,
  ISSUER,
  localSwitches,
  loginUrl,
  oidcEnv,
  SEED_ACCOUNTS_FILE,
  seedStatements,
  serverEnv,
  stackOptions,
  TOKEN_FILE,
} from "./config.ts";
import { localLogins } from "./database.ts";
import { databaseUrl, parseFlags } from "./lokalno.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SECRETS = {
  appPassword: "a".repeat(40),
  authPassword: "b".repeat(40),
  provisioningToken: "c".repeat(43),
};

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const tempDir = (): string => (dir = mkdtempSync(join(tmpdir(), "lokalno-")));

describe("local switches (SRV-ANALIZA-LOKALNO)", () => {
  it("passes the analysis switch only as exactly 1, which baseEnv would drop", () => {
    expect(baseEnv({ DUCTUS_ANALYSIS_LOCAL: "1" })).not.toHaveProperty("DUCTUS_ANALYSIS_LOCAL");
    expect(localSwitches({ DUCTUS_ANALYSIS_LOCAL: "1" })).toEqual({ DUCTUS_ANALYSIS_LOCAL: "1" });
    for (const value of [undefined, "", "0", "true", " 1"])
      expect(localSwitches({ DUCTUS_ANALYSIS_LOCAL: value })).toEqual({});
    expect(localSwitches({ DUCTUS_AUTH_PROVIDER: "fake-oidc", DUCTURA_DEPLOYMENT: "x" })).toEqual(
      {},
    );
  });
});

describe("contract §1: ports, issuer and origin", () => {
  it("the provider and the server agree on the issuer and the callback of the edge origin", () => {
    const options = stackOptions(false);
    const oidc = oidcEnv(options);
    const server = serverEnv(options, { host: "localhost", port: "5432" }, SECRETS);
    expect(oidc).toMatchObject({
      NODE_ENV: "development",
      PORT: "8090",
      ISSUER: "http://localhost:8090",
      REDIRECT_URI: "http://localhost:8000/api/v1/auth/callback",
      POST_LOGOUT_REDIRECT_URI: "http://localhost:8000/",
      BACKCHANNEL_LOGOUT_URI: "http://127.0.0.1:4000/api/v1/auth/backchannel-logout",
    });
    expect(oidc).not.toHaveProperty("FAKE_OIDC_ACCOUNTS_FILE");
    expect(server).toMatchObject({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: "4000",
      APP_ORIGIN: "http://localhost:8000",
      DUCTUS_AUTH_PROVIDER: "fake-oidc",
      OIDC_ISSUER: "http://localhost:8090",
      OIDC_REDIRECT_URI: "http://localhost:8000/api/v1/auth/callback",
      DUCTURA_PROVISIONING_TOKEN: SECRETS.provisioningToken,
    });
    // The server's own check accepts the configuration.
    expect(loadAuthConfig(server).redirectUri.origin).toBe("http://localhost:8000");
  });

  it("--izravno moves only the origin, to the server itself", () => {
    const options = stackOptions(true, "/x/oidc-racuni.json");
    expect(oidcEnv(options)).toMatchObject({
      REDIRECT_URI: "http://localhost:4000/api/v1/auth/callback",
      FAKE_OIDC_ACCOUNTS_FILE: "/x/oidc-racuni.json",
    });
    expect(serverEnv(options, { host: "127.0.0.1", port: "5432" }, SECRETS).APP_ORIGIN).toBe(
      "http://localhost:4000",
    );
    expect(parseFlags(["--izravno"])).toEqual({ direct: true });
    expect(parseFlags([])).toEqual({ direct: false });
    expect(() => parseFlags(["--x"])).toThrow("usage");
  });

  it("INT-08: serverEnv with evidence names the storage domain, the S3 credentials and the signing seed", () => {
    const credentials = { keyId: "vs1abc", secret: "s".repeat(40) };
    const server = serverEnv(stackOptions(false), { host: "127.0.0.1", port: "5432" }, SECRETS, {
      institutionId: "11111111-1111-4111-8111-111111111111",
      seed: "/home/x/.ductura/seed",
      s3Port: PORTS.s3,
      credentials,
    });
    expect(server).toMatchObject({
      NODE_ENV: "development",
      EVIDENCE_S3_VS1_KEY_ID: "vs1abc",
      EVIDENCE_S3_VS1_SECRET: credentials.secret,
      DUCTUS_DEV_SIGNING_KEY_FILE: "/home/x/.ductura/seed",
    });
    const domains = JSON.parse(server.EVIDENCE_STORAGE_DOMAINS ?? "") as {
      domains: { endpoint: string; institutionId: string }[];
    };
    expect(domains.domains).toHaveLength(1);
    expect(domains.domains[0]).toMatchObject({
      endpoint: `http://127.0.0.1:${PORTS.s3}`,
      institutionId: "11111111-1111-4111-8111-111111111111",
    });
    // Without evidence none of it is set; and the caller's EVIDENCE_* never reaches a child.
    const plain = serverEnv(stackOptions(false), { host: "127.0.0.1", port: "5432" }, SECRETS);
    expect(plain).not.toHaveProperty("EVIDENCE_STORAGE_DOMAINS");
    expect(baseEnv({ EVIDENCE_STORAGE_DOMAINS: "x", VS1_S3_ROOT: "/x", keep: "1" })).toEqual({
      keep: "1",
    });
  });

  it("the logins are the local app and auth roles of the database ductus", () => {
    const server = serverEnv(stackOptions(false), { host: "[::1]", port: "5433" }, SECRETS);
    const app = new URL(server.APP_DATABASE_URL ?? "");
    const auth = new URL(server.AUTH_DATABASE_URL ?? "");
    expect([app.username, app.hostname, app.port, app.pathname]).toEqual([
      "ductus_app_local",
      "[::1]",
      "5433",
      "/ductus",
    ]);
    expect([auth.username, auth.password]).toEqual(["ductus_auth_local", SECRETS.authPassword]);
    expect(localLogins(SECRETS).map(([login, group]) => [login, group])).toEqual([
      ["ductus_app_local", "ductus_app"],
      ["ductus_auth_local", "ductus_auth"],
    ]);
  });

  it("db/main/local/seed.sql stores the simulator's issuer and loses only its psql guard", () => {
    const seed = readFileSync(join(ROOT, "db/main/local/seed.sql"), "utf8");
    const plain = seedStatements(seed);
    expect(plain).toContain(`SELECT id, '${ISSUER}'`);
    expect(plain).not.toMatch(/^\s*\\/mu);
    expect(plain).toContain("INSERT INTO identity.institution (slug, aai_home_org)");
    expect(() => seedStatements("SELECT 1;\n")).toThrow("guard");
    expect(() => seedStatements("\\set ON_ERROR_STOP on\n\\if x\n\\endif\n\\gset\n")).toThrow(
      "psql command",
    );
  });
});

describe("the simulator's accounts file (SRV-01)", () => {
  it("is .local/oidc-racuni.json when it exists, else the seed's committed file", () => {
    const local = join("/r/.local", "oidc-racuni.json");
    const seed = join("/r", SEED_ACCOUNTS_FILE);
    expect(accountsFileFor("/r", "/r/.local", () => true)).toBe(local);
    expect(accountsFileFor("/r", "/r/.local", (path) => path === seed)).toBe(seed);
    expect(accountsFileFor("/r", "/r/.local", () => false)).toBeUndefined();
  });

  it("the committed file names the local roles and both submission students", () => {
    const text = readFileSync(join(ROOT, SEED_ACCOUNTS_FILE), "utf8");
    const accounts = parseSimulatedAccountsFile(JSON.parse(text));
    expect(accounts.map((a) => [a.user, a.domain, a.role])).toEqual([
      ["demo-admin", "demo.ductus.test", "nastavnik"],
      ["demo-bez-uloge", "demo.ductus.test", "nastavnik"],
      ["demo-student-3", "demo.ductus.test", "student"],
      ["demo-student-4", "demo.ductus.test", "student"],
    ]);
    const seed = readFileSync(join(ROOT, "db/main/local/seed.sql"), "utf8");
    // The administrator's subject is the simulator's account id; the account
    // without a role is never made by the seed.
    expect(seed).toContain("'sim:nastavnik:demo-admin@demo.ductus.test'");
    expect(seed).not.toContain("'sim:nastavnik:demo-bez-uloge@demo.ductus.test'");
  });

  // SEED-OIDC-OPERATER: the operator is an account of the fake OIDC provider
  // itself (accounts.ts), not of the accounts file, so it signs in whatever
  // file is passed. The seed stores the provider's subject and names, and
  // appoints exactly that subject an administrator.
  it("the seed's operator is the fake OIDC account demo-operater, same subject and names", () => {
    const claims = demoAccountClaims("demo-operater");
    expect(claims).toBeDefined();
    const seed = readFileSync(join(ROOT, "db/main/local/seed.sql"), "utf8");
    const array = (name: string): string[] => {
      const pattern = new RegExp(`${name} constant \\w+\\[\\] := ARRAY\\[([^\\]]*)\\]`, "u");
      const found = pattern.exec(seed);
      if (found?.[1] === undefined) throw new Error(`seed.sql: ${name} not found`);
      return found[1].split(",").map((item) => item.trim().replace(/^'(.*)'$/su, "$1"));
    };
    const at = array("c_subjects").indexOf(claims?.sub ?? "");
    expect(at).toBeGreaterThan(-1);
    expect(array("c_users")[at]).toBe("demo-operater");
    expect(array("c_given")[at]).toBe(claims?.given_name);
    expect(array("c_family")[at]).toBe(claims?.family_name);
    expect(array("c_eligible")[at]).toBe("true");
    expect(seed).toContain(`appoint_institution_admin(v_ids[${at + 1}], 'lokalni-seed')`);
    expect(seed).not.toContain("sim:nastavnik:demo-operater@");
    const file = parseSimulatedAccountsFile(
      JSON.parse(readFileSync(join(ROOT, SEED_ACCOUNTS_FILE), "utf8")),
    );
    expect(file.map((account) => account.user)).not.toContain("demo-operater");
  });
});

describe("DATABASE_URL", () => {
  it("names a superuser on this machine; the database is always ductus", () => {
    expect(adminTarget("postgres://postgres:p%40ss@localhost/ductus")).toEqual({
      host: "localhost",
      port: "5432",
      user: "postgres",
      password: "p@ss",
    });
    expect(adminTarget("postgresql://u@127.0.0.1:5433/postgres?sslmode=disable").port).toBe("5433");
    expect(adminTarget("postgres://u:p@[::1]:5432").host).toBe("[::1]");
  });

  it.each([
    [undefined, "not set"],
    [" ", "not set"],
    ["nije url", "not a URL"],
    ["mysql://u:p@localhost/ductus", "not a postgres URL"],
    ["postgres://u:p@db.example.org/ductus", "localhost"],
    ["postgres://u:p@10.0.0.2/ductus", "localhost"],
    ["postgres://u:p@localhost/drugo", "the database ductus"],
    ["postgres://u:p@localhost/ductus?host=/tmp", "only sslmode"],
    ["postgres://localhost/ductus", "no user"],
  ])("refuses %j without echoing it", (raw, message) => {
    let error: unknown;
    try {
      adminTarget(raw);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain(message);
    if (raw !== undefined && raw.trim() !== "") expect((error as Error).message).not.toContain(raw);
  });

  it("comes from the environment, else from .local/database-url", () => {
    const local = tempDir();
    expect(databaseUrl({}, local)).toBeUndefined();
    writeFileSync(join(local, "database-url"), "postgres://u:p@localhost/ductus\n");
    expect(databaseUrl({}, local)).toBe("postgres://u:p@localhost/ductus");
    expect(databaseUrl({ DATABASE_URL: "postgres://e@localhost" }, local)).toBe(
      "postgres://e@localhost",
    );
  });

  it("loginUrl escapes the user and the password", () => {
    const url = new URL(
      loginUrl({ host: "localhost", port: "5432" }, "a b", "p:@/", "ductus", "r"),
    );
    expect(decodeURIComponent(url.password)).toBe("p:@/");
    expect(url.searchParams.get("role")).toBe("r");
  });
});

describe("local secrets and environment", () => {
  it("are made once, kept, 0600, and the token is also one line of its own", () => {
    const local = tempDir();
    const first = ensureSecrets(local);
    expect(first.provisioningToken.length).toBeGreaterThanOrEqual(32);
    expect(new Set(Object.values(first)).size).toBe(3);
    expect(ensureSecrets(local)).toEqual(first);
    expect(readFileSync(join(local, TOKEN_FILE), "utf8")).toBe(`${first.provisioningToken}\n`);
    if (process.platform !== "win32") {
      expect(statSync(join(local, "lokalno-tajne.json")).mode & 0o777).toBe(0o600);
    }
    writeFileSync(join(local, "lokalno-tajne.json"), '{"appPassword":"kratka"}');
    expect(() => ensureSecrets(local)).toThrow("damaged");
  });

  it("children never take the caller's database, login or listener variables", () => {
    // Names as the environment spells them, so built from pairs.
    const caller = Object.fromEntries([
      ["PATH", "/bin"],
      ["SystemRoot", "C:\\Windows"],
      ["PGPASSWORD", "x"],
      ["DATABASE_URL", "x"],
      ["APP_DATABASE_URL", "x"],
      ["OIDC_ISSUER", "x"],
      ["DUCTUS_AUTH_PROVIDER", "x"],
      ["DUCTURA_PROVISIONING_TOKEN", "x"],
      ["NODE_ENV", "production"],
      ["NODE_OPTIONS", "--require x"],
      ["PORT", "1"],
      ["FAKE_OIDC_MODE", "refuse"],
    ]);
    const base = baseEnv(caller);
    expect(Object.entries(base)).toEqual([
      ["PATH", "/bin"],
      ["SystemRoot", "C:\\Windows"],
    ]);
  });

  it("runs only for local development (D-09)", () => {
    expect(() => assertLocal({})).not.toThrow();
    expect(() => assertLocal({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertLocal({ NODE_ENV: "production" })).toThrow("NODE_ENV");
    expect(() => assertLocal({ NODE_ENV: "staging" })).toThrow("NODE_ENV");
  });
});
