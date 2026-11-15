// S-1F-c (DAN-779): `pnpm db:migrate` migrates every database of
// scripts/db/databases.ts, in its order, each through the locked runner as its
// own migrator; migrate-locked.ts refuses a database or URL off that list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { test } from "vitest";

import { DATABASES, databaseNamed, dbmateArgs, parseArgs, urlMismatch } from "./index.ts";

const { scripts } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const compose = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");

test("the databases are main, logs, then legal, with distinct databases, directories, ledgers and migrators", () => {
  assert.deepEqual(
    DATABASES.map((entry) => entry.name),
    ["main", "logs", "legal"],
  );
  for (const key of ["database", "migrationsDir", "ledger", "migrator"] as const) {
    assert.equal(new Set(DATABASES.map((entry) => entry[key])).size, DATABASES.length, key);
  }
  for (const entry of DATABASES) {
    assert.equal(entry.migrationsDir, `db/${entry.name}/migrations`);
    assert.equal(entry.ledger, `db/${entry.name}/migrations.sum`);
    assert.match(compose, new RegExp(`^ {2}${entry.service}:$`, "m"));
  }
  assert.throws(() => databaseNamed("audit"), /unknown database "audit"/);
  assert.throws(() => databaseNamed("Legal"), /unknown database "Legal"/);
  assert.throws(() => databaseNamed(""), /unknown database/);
});

test("pnpm db:migrate runs db:migrate:<name> for every database, in the list's order, and nothing else", () => {
  assert.equal(
    scripts["db:migrate"],
    DATABASES.map((entry) => `pnpm db:migrate:${entry.name}`).join(" && "),
  );
});

test("each db:migrate:<name> migrates its own database as its own migrator through migrate-locked", () => {
  for (const entry of DATABASES) {
    const script = scripts[`db:migrate:${entry.name}`] ?? "";
    const runs = [...script.matchAll(/node scripts\/db\/migrate-locked\.ts (.+?)(?= && |$)/g)];
    assert.equal(runs.length, 1, `${entry.name}: one locked run`);
    const argv = [...(runs[0]?.[1] ?? "").matchAll(/"([^"]+)"|(\S+)/g)].map(
      (match) => match[1] ?? match[2] ?? "",
    );
    const parsed = parseArgs(argv);
    assert.notEqual(typeof parsed, "string", `${entry.name}: ${String(parsed)}`);
    assert.equal(typeof parsed !== "string" && parsed.database.name, entry.name);
  }
  assert.match(
    scripts["db:migrate:logs"] ?? "",
    /^pnpm db:provision:logs && node scripts\/db\/migrate-locked\.ts --database logs /,
  );
  assert.match(
    scripts["db:migrate:legal"] ?? "",
    /^pnpm db:provision:legal && node scripts\/db\/migrate-locked\.ts --database legal /,
  );
  // The legal database is made in the main database, then provisioned in itself.
  assert.deepEqual(
    (scripts["db:provision:legal"] ?? "")
      .split(" && ")
      .map((step) => step.replace(/^.* -d (\S+) .* < (\S+)$/, "$1 $2")),
    ["ductus db/legal/local/create-database.sql", "ductus_legal db/legal/local/migrator.sql"],
  );
  assert.match(
    scripts["db:provision:logs"] ?? "",
    /postgres-logs psql -U ductus -d ductus_logs .* < db\/logs\/local\/migrator\.sql$/,
  );
});

test("migrate-locked refuses an unknown database, a URL of another database and another role", () => {
  const logs = databaseNamed("logs");
  const good =
    "postgres://u:p@127.0.0.1:54330/ductus_logs?sslmode=disable&role=ductus_logs_migrator";
  assert.equal(urlMismatch(good, logs), null);
  assert.deepEqual(parseArgs(["--database", "logs", "--url", good]), { database: logs, url: good });
  assert.match(String(parseArgs(["--database", "nope", "--url", good])), /unknown database/);
  assert.match(String(parseArgs(["--database"])), /unknown database/);
  assert.match(String(parseArgs(["--url", good, "--database", "logs"])), /usage/);
  assert.match(String(parseArgs(["--database", "logs"])), /usage/);
  const cases: [string, RegExp][] = [
    [good.replace("/ductus_logs?", "/ductus?"), /does not name the database ductus_logs/],
    [good.replace("role=ductus_logs_migrator", "role=ductus_migrator"), /must run as/],
    [good.replace("&role=ductus_logs_migrator", ""), /must run as/],
    [`${good}&role=ductus`, /must run as/],
    ["not a url", /not a valid URL/],
    // Finding 1 of the attack run: dbmate obeys these keys, PostgreSQL ignores case.
    [`${good}&database=other`, /only sslmode and role in its query, not database/],
    [`${good}&dbname=other`, /not dbname/],
    [`${good}&ROLE=ductus`, /not ROLE/],
    [`${good}&Role=ductus`, /not Role/],
    [`${good}&port=54329`, /not port/],
    [`${good}&host=10.0.0.1`, /not host/],
    [`${good}&user=ductus`, /not user/],
    [`${good}&options=-c%20role%3Dductus`, /not options/],
  ];
  for (const [url, error] of cases) {
    assert.match(urlMismatch(url, logs) ?? "", error, url);
    assert.ok(!(urlMismatch(url, logs) ?? "").includes("u:p@"), "the URL is never echoed");
  }
  // Without --database it is main, and a logs URL is refused.
  assert.match(String(parseArgs(["--url", good])), /does not name the database ductus /);
});

// S-1F-c a2: the legal and the main database share a cluster, a host and a
// port, so only the database name and the role tell them apart.
test("migrate-locked never runs legal migrations in the main database, or main ones in the legal database", () => {
  const legal =
    "postgres://u:p@127.0.0.1:54329/ductus_legal?sslmode=disable&role=ductus_legal_migrator";
  const main = "postgres://u:p@127.0.0.1:54329/ductus?sslmode=disable&role=ductus_migrator";
  assert.deepEqual(parseArgs(["--database", "legal", "--url", legal]), {
    database: databaseNamed("legal"),
    url: legal,
  });
  assert.match(
    String(parseArgs(["--database", "legal", "--url", main])),
    /does not name the database ductus_legal/,
  );
  assert.match(
    String(
      parseArgs(["--database", "legal", "--url", legal.replace("/ductus_legal?", "/ductus?")]),
    ),
    /does not name the database ductus_legal/,
  );
  assert.match(String(parseArgs(["--url", legal])), /does not name the database ductus /);
  assert.match(
    String(parseArgs(["--url", main.replace("/ductus?", "/ductus_legal?")])),
    /does not name the database ductus /,
  );
  assert.match(
    String(
      parseArgs([
        "--database",
        "legal",
        "--url",
        legal.replace("ductus_legal_migrator", "ductus_migrator"),
      ]),
    ),
    /must run as ductus_legal_migrator/,
  );
});

test("dbmate reads the migrations of the chosen database", () => {
  const args = dbmateArgs("postgres://u:p@h/d", databaseNamed("logs").migrationsDir);
  assert.equal(args[args.indexOf("--migrations-dir") + 1], "db/logs/migrations");
  assert.deepEqual(args.slice(-2), ["up", "--strict"]);
});
