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
