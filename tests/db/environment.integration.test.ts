import pg from "pg";
import { describe, expect, it } from "vitest";

// Ported from Ductus tests/integration/environment.integration.test.ts
// (d52a92c3, S-0.17, DAN-730): the case of the main database, which this
// repository runs natively in the CI job `database` (no Docker). The other four
// cases of that file check compose services this repository does not have yet
// (object store, Mailpit, the fake OIDC provider on its port) and come with
// the areas that bring those services.
const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const DATABASE_URL = env(
  "DATABASE_URL",
  "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus",
);

describe("local environment", () => {
  it("Postgres 17 accepts connections", async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ server_version: string }>("show server_version");
      expect(rows[0]!.server_version).toMatch(/^17\./);
    } finally {
      await client.end();
    }
  });
});
