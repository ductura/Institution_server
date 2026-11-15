import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jobsFor, POSTGRES_MAJOR } from "./index.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const SMOKE = readFileSync(resolve(ROOT, "db/tests/00-environment.sql"), "utf8");
const ALL_JOBS = ["scope", ...jobsFor("full")];

/** The text of one top-level job, up to the next job. */
function job(name: string): string {
  const start = CI.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(0);
  const next = CI.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? CI.slice(start) : CI.slice(start, start + 1 + next);
}

describe("ci.yml", () => {
  it("has exactly the jobs ci-ok knows, plus ci-ok", () => {
    const jobs = [...CI.split("\njobs:\n")[1]!.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(
      (match) => match[1],
    );
    expect(jobs).toEqual([...ALL_JOBS, "ci-ok"]);
  });

  it("uses no runner context in expressions (not available in job env)", () => {
    expect(CI).not.toMatch(/\$\{\{\s*runner\./);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = [...CI.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/);
  });

  it("reads only, and never runs on pull_request_target", () => {
    expect(CI).not.toMatch(/pull_request_target|workflow_run|write-all|: write\b/);
    expect([...CI.matchAll(/permissions:/g)]).toHaveLength(1);
    expect(CI).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
    expect([...CI.matchAll(/persist-credentials: false/g)]).toHaveLength(4);
  });

  it("ci-ok always runs after every job and decides from protected main", () => {
    const ciOk = job("ci-ok");
    expect(ciOk).toContain(`needs: [${ALL_JOBS.join(", ")}]`);
    expect(ciOk).toMatch(/\n {4}if: always\(\)\n/);
    expect(ciOk).toContain("node scripts/ci/ci-ok.ts");
    expect(ciOk).toContain(
      `jq -e 'length == ${ALL_JOBS.length} and all(.[]; .result == "success")'`,
    );
    for (const name of ["scope", "ci-ok"]) {
      expect(job(name)).toContain(
        "ref: ${{ github.event.pull_request.base.ref == 'main' && github.event.pull_request.base.sha || 'main' }}",
      );
    }
  });

  it("skips the database job only on the docs profile", () => {
    const database = job("database");
    expect(database).toContain("needs: scope");
    expect(database).toMatch(/\n {4}if: needs\.scope\.outputs\.profile == 'full'\n/);
    expect(job("checks")).not.toMatch(/\n {4}(if|needs):/);
    expect(job("scope")).toContain('node scripts/ci/scope.ts >> "$GITHUB_OUTPUT"');
  });

  // S-0.13 (DAN-726), review cxcrs17 and QA cxcqs17 finding 2: the database
  // job builds the migrated database and runs the migration tests against it;
  // checks run the integration project without a database, so it leaves them out.
  it("the database job applies every migration through the locked runner and runs the migration tests", () => {
    const database = job("database");
    const migrator = database.indexOf("-f db/main/local/migrator.sql");
    const migrate = database.indexOf(
      'node scripts/db/migrate-locked.ts --url "$DATABASE_URL?sslmode=disable&role=ductus_migrator"',
    );
    const count = database.indexOf('[ "$applied" -eq "$files" ]');
    const tests = database.search(/\n {8}run: pnpm test:database\n/);
    expect(migrator).toBeGreaterThan(database.indexOf("pg_prove"));
    expect(migrate).toBeGreaterThan(migrator);
    expect(count).toBeGreaterThan(migrate);
    expect(tests).toBeGreaterThan(count);
    expect(database).toContain('-o "-p 54329 -k $RUNNER_TEMP -c listen_addresses=127.0.0.1"');
    expect(database).toContain(
      "DATABASE_URL: postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus",
    );
    expect(database).toContain("run: pnpm install --frozen-lockfile");
    expect(job("checks")).not.toContain("test:database");
    const config = readFileSync(resolve(ROOT, "vitest.config.ts"), "utf8");
    expect(config).toContain('const DATABASE = "tests/db/**/*.integration.test.ts";');
    expect(config).toMatch(
      /name: "integration",\n\s+include: \[INTEGRATION\],\n\s+exclude: \[DATABASE, PG\],/,
    );
    expect(config).toMatch(/name: "database",\n\s+include: \[DATABASE\],/);
  });

  // S-1F-c (DAN-779): the logs database is provisioned and migrated in its own
  // cluster before the migration tests, which get its URL.
  it("the database job brings up the logs database through the locked runner before the migration tests", () => {
    const database = job("database");
    const cluster = database.indexOf('-o "-p 54330 -k $RUNNER_TEMP -c listen_addresses=127.0.0.1"');
    const bootstrap = database.indexOf("-f db/logs/local/migrator.sql");
    const migrate = database.indexOf(
      'node scripts/db/migrate-locked.ts --database logs --url "$LOGS_DATABASE_URL?sslmode=disable&role=ductus_logs_migrator"',
    );
    const count = database.indexOf("find db/logs/migrations -maxdepth 1 -name '*.sql'");
    const tests = database.search(/\n {8}run: pnpm test:database\n/);
    expect(cluster).toBeGreaterThan(database.indexOf('[ "$applied" -eq "$files" ]'));
    expect(bootstrap).toBeGreaterThan(cluster);
    expect(migrate).toBeGreaterThan(bootstrap);
    expect(count).toBeGreaterThan(migrate);
    expect(tests).toBeGreaterThan(count);
    const testStep = database.slice(database.indexOf("- name: Testovi migracija"), tests);
    expect(testStep).toContain(
      "LOGS_DATABASE_URL: postgres://ductus:ductus-logs-local-only@127.0.0.1:54330/ductus_logs",
    );
  });

  // S-1F-c a2 (DAN-779): the legal database is created, provisioned and
  // migrated in the main cluster after the main migrations, before the tests.
  it("the database job brings up the legal database through the locked runner before the migration tests", () => {
    const database = job("database");
    const create = database.indexOf("-f db/legal/local/create-database.sql");
    const bootstrap = database.indexOf("-f db/legal/local/migrator.sql");
    const migrate = database.indexOf(
      'node scripts/db/migrate-locked.ts --database legal --url "$LEGAL_DATABASE_URL?sslmode=disable&role=ductus_legal_migrator"',
    );
    const count = database.indexOf("find db/legal/migrations -maxdepth 1 -name '*.sql'");
    const tests = database.search(/\n {8}run: pnpm test:database\n/);
    expect(create).toBeGreaterThan(database.indexOf("-f db/main/local/app-login.sql"));
    expect(bootstrap).toBeGreaterThan(create);
    expect(migrate).toBeGreaterThan(bootstrap);
    expect(count).toBeGreaterThan(migrate);
    expect(tests).toBeGreaterThan(count);
  });

  it("checks run every repository check and test project", () => {
    const checks = job("checks");
    for (const script of [
      "typecheck",
      "lint",
      "format:check",
      "test:unit",
      "test:property",
      "test:integration",
    ]) {
      expect(checks).toMatch(new RegExp(`\\n {8}run: pnpm ${script}\\n`));
    }
  });

  it("installs PostgreSQL with the production major version and runs pgTAP", () => {
    const database = job("database");
    const majors = [...database.matchAll(/postgresql[-/](\d+)/g)].map((match) => Number(match[1]));
    expect(majors.length).toBeGreaterThanOrEqual(3);
    for (const major of majors) expect(major).toBe(POSTGRES_MAJOR);
    expect(database).toContain(`postgresql-${POSTGRES_MAJOR}-pgtap`);
    expect(database).toContain(`PGBIN: /usr/lib/postgresql/${POSTGRES_MAJOR}/bin`);
    expect(database).toMatch(/grep -qx "fpr:::::::::\$PGDG_KEY_FINGERPRINT:"/);
    expect(database).toContain('pg_prove --psql-bin "$PGBIN/psql"');
    expect(database).toContain("No pgTAP test files found.");
    expect(database).not.toMatch(/docker|services:|container:/i);
  });

  it("the pgTAP smoke test expects the same major version", () => {
    expect(SMOKE).toContain(
      `/ 10000, ${POSTGRES_MAJOR}, 'PostgreSQL major version matches production'`,
    );
    expect(SMOKE).toMatch(/SELECT plan\(2\);/);
  });
});
