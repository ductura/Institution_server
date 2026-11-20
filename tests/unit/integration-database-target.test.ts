import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// DAN-352: an integration test that creates or drops a database checks first
// that DATABASE_URL names this machine (F-167, tests/db/loopback-database-url.ts).
// pg reads ?host= and ?port= past the hostname that URL parsing shows, so a
// hostname check alone is not enough; the shared guard refuses any query.
// notification-store-migration keeps its own exact allowlist of local URLs.
const DIR = fileURLToPath(new URL("../db/", import.meta.url));
const OWN_ALLOWLIST = new Set(["notification-store-migration.integration.test.ts"]);
const CREATES_OR_DROPS = /\b(CREATE|DROP)\s+DATABASE\b/i;
// The call (not the import): `requireLoopbackDatabaseUrl(` with the URL on the same or the next line.
const GUARD = /requireLoopbackDatabaseUrl\(\s*\S/;

const files = readdirSync(DIR, { recursive: true, encoding: "utf8" }).filter((name) =>
  name.endsWith(".integration.test.ts"),
);
const creating = files.filter((name) =>
  CREATES_OR_DROPS.test(readFileSync(join(DIR, name), "utf8")),
);

describe("integration tests that create or drop a database", () => {
  it("are found, so the list below is not empty by accident", () => {
    expect(creating).toContain("plain-label-check.integration.test.ts");
    expect(creating).toContain("institution-key-migration.integration.test.ts");
    expect(creating).toContain("submission-closes-package-migration.integration.test.ts");
  });

  it.each(creating)("%s refuses a DATABASE_URL that is not a plain local URL", (name) => {
    const source = readFileSync(join(DIR, name), "utf8");
    if (OWN_ALLOWLIST.has(name)) {
      expect(source).toMatch(/const ADMIN_URL = localAdminUrl\(process\.env\.DATABASE_URL\);/);
      return;
    }
    expect(source).toMatch(
      /import \{[^}]*\brequireLoopbackDatabaseUrl\b[^}]*\} from "\.\/loopback-database-url\.ts";/,
    );
    // The guard runs at load time, before any pool or client exists.
    expect(source).toMatch(GUARD);
    const guard = source.search(GUARD);
    const firstConnection = source.search(/new (pg\.)?(Pool|Client)\(/);
    expect(guard).toBeGreaterThan(-1);
    if (firstConnection >= 0) expect(firstConnection).toBeGreaterThan(guard);
  });
});
