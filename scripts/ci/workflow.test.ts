import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DATABASES } from "../db/index.ts";
import { jobsFor, POSTGRES_MAJOR } from "./index.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const SMOKE = readFileSync(resolve(ROOT, "db/tests/00-environment.sql"), "utf8");
const ALL_JOBS = ["scope", ...jobsFor("full")];
// The vitest projects split across the legs of a job matrix (vitest --shard).
const SHARD_ENV = "\n          SHARD: ${{ matrix.shard }}/${{ strategy.job-total }}\n";
const MATRIX = (legs: string) =>
  `\n      fail-fast: false\n      matrix:\n        shard: [${legs}]\n`;
// checks runs three legs, database two.
const LEGS: Readonly<Record<string, string>> = { checks: "1, 2, 3", database: "1, 2" };
const LEG_NAME = /^ {4}name: .+ \(\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}\)$/;
// pnpm test:database as its two vitest runs, each with the leg's shard.
const DATABASE_TESTS =
  /\n {8}run: \|\n {10}pnpm exec vitest run --project database --shard="\$SHARD"\n {10}pnpm test:integration:pg --shard="\$SHARD"\n/;

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
    const tests = database.search(DATABASE_TESTS);
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
    // wal_level=logical: the replication test of the chain base (DAN-868-1a).
    const cluster = database.indexOf(
      '-o "-p 54330 -k $RUNNER_TEMP -c listen_addresses=127.0.0.1 -c wal_level=logical"',
    );
    const bootstrap = database.indexOf("-f db/logs/local/migrator.sql");
    const migrate = database.indexOf(
      'node scripts/db/migrate-locked.ts --database logs --url "$LOGS_DATABASE_URL?sslmode=disable&role=ductus_logs_migrator"',
    );
    const count = database.indexOf("find db/logs/migrations -maxdepth 1 -name '*.sql'");
    const tests = database.search(DATABASE_TESTS);
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
    const tests = database.search(DATABASE_TESTS);
    expect(create).toBeGreaterThan(database.indexOf("-f db/main/local/app-login.sql"));
    expect(bootstrap).toBeGreaterThan(create);
    expect(migrate).toBeGreaterThan(bootstrap);
    expect(count).toBeGreaterThan(migrate);
    expect(tests).toBeGreaterThan(count);
  });

  // S-1F-d (DAN-797): the pgTAP of every database runs in the database job,
  // which ci-ok requires on the full profile, after that database is migrated,
  // with nothing that would let the step fail without failing the job.
  it("the database job runs the pgTAP of every database after its migration, gating ci-ok", () => {
    const database = job("database");
    const scripts = (
      JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(database).not.toMatch(/continue-on-error|\|\| true|set \+e/);
    expect(jobsFor("full")).toContain("database");
    expect(job("ci-ok")).toContain("database");
    const migrated: Record<string, string> = {
      main: "pnpm db:up:native",
      logs: "find db/logs/migrations -maxdepth 1 -name '*.sql'",
      legal: "find db/legal/migrations -maxdepth 1 -name '*.sql'",
    };
    for (const entry of DATABASES) {
      const script = entry.name === "main" ? "test:db:native" : `test:db:${entry.name}`;
      const run = database.search(
        new RegExp(`\\n {8}run: PATH="\\$PGBIN:\\$PATH" pnpm ${script}\\n`),
      );
      expect(run, entry.name).toBeGreaterThan(database.lastIndexOf(migrated[entry.name]!));
      const step = database.slice(database.lastIndexOf("\n      - ", run), run);
      expect(step, entry.name).not.toMatch(/\n {8}if:/);
      if (entry.name !== "main") {
        expect(scripts[script]).toBe(`node scripts/db/pgtap.ts ${entry.name}`);
        expect(step).toContain(`PGDATABASE: ${entry.database}`);
        expect(step).toContain(`PGPORT: "${entry.service === "postgres-logs" ? 54330 : 54329}"`);
      }
    }
  });

  it("checks run every repository check and test project", () => {
    const checks = job("checks");
    for (const script of ["typecheck", "lint", "format:check", "test:equality", "test:property"]) {
      expect(checks).toMatch(new RegExp(`\\n {8}run: pnpm ${script}\\n`));
    }
    for (const script of ["test:unit", "test:integration"]) {
      expect(checks).toContain(`${SHARD_ENV}        run: pnpm ${script} --shard="$SHARD"\n`);
    }
    // Each static check runs on one leg that exists, the property tests on two
    // legs (two seeds per run, as before); the sharded tests run on every leg.
    const legs: Record<string, string> = {
      "pnpm typecheck": "matrix.shard == 1",
      "node scripts/db/migrations-ledger.ts --base": "matrix.shard == 1",
      "pnpm lint": "matrix.shard == 1",
      "pnpm format:check": "matrix.shard == 1",
      "pnpm test:equality": "matrix.shard == 2",
      "pnpm test:property": "matrix.shard != 1",
    };
    for (const [command, leg] of Object.entries(legs)) {
      const at = checks.indexOf(command);
      const step = checks.slice(checks.lastIndexOf("\n      - ", at), at);
      expect(step, command).toContain(`\n        if: ${leg}\n`);
    }
    for (const script of ["test:unit", "test:integration"]) {
      const at = checks.indexOf(`run: pnpm ${script} `);
      expect(checks.slice(checks.lastIndexOf("\n      - ", at), at), script).not.toContain("if:");
    }
  });

  // Both test jobs run as legs (checks three, database two). Each leg runs its
  // share of the files of the unit, integration, database and integration-pg
  // projects; database runs every other step (migrations, pgTAP, VS-1) on both
  // legs, checks each other step on one or two legs. ci-ok sees one result per
  // job, failed when any leg failed.
  it("splits the vitest projects across the legs of checks and database, nothing else", () => {
    for (const name of ["checks", "database"]) {
      const body = job(name);
      const matrix = body.indexOf(MATRIX(LEGS[name]!));
      expect(body.split("\n")[2], name).toMatch(LEG_NAME);
      expect(matrix, name).toBeGreaterThan(body.indexOf("\n    strategy:\n"));
      expect(matrix, name).toBeLessThan(body.indexOf("\n    steps:\n"));
      expect([...body.matchAll(/--shard="\$SHARD"/g)], name).toHaveLength(2);
    }
    expect([...CI.matchAll(/strategy:|--shard=/g)]).toHaveLength(6);
    const database = job("database");
    const tests = database.search(DATABASE_TESTS);
    expect(database.slice(database.indexOf("- name: Testovi migracija"), tests)).toContain(
      SHARD_ENV,
    );
    // The two runs are exactly what `pnpm test:database` runs locally.
    const scripts = (
      JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["test:database"]).toBe(
      "vitest run --project database && pnpm test:integration:pg",
    );
    expect(scripts["test:integration:pg"]).toBe("vitest run --project integration-pg");
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
