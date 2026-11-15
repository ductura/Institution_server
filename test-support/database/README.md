# Testne baze (S-1F-e, DAN-785)

Svaka baza iz `scripts/db/databases.ts` (`main`, `logs`, `legal` i svaka buduća) ima testnu inačicu iz istih migracija. Nova baza je novi redak u tom popisu, uz `db/<ime>/migrations`, `migrations.sum` i `local/migrator.sql`; ovdje se ne mijenja ništa.

```ts
import { createTestDatabase } from "../../test-support/database/create-test-database.ts";

const db = await createTestDatabase("logs");
await db.query("SELECT 1");
await db.reset(); // stanje odmah nakon migracija
await db.close();
```

| Inačica    | Projekt i naredba                      | Što je                                                                                                                         |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pglite`   | `integration`, `pnpm test:integration` | U procesu. Migrira jednom po imenu i procesu; svako otvaranje i svaki `reset()` daje novu kopiju, pa test ne vidi tuđe stanje. |
| `postgres` | dolazi s DAN-785 b (`integration-pg`)  | Već migrirana lokalna ili CI baza; svaki test u jednoj transakciji koja se poništava. Do tada otvaranje baca grešku.           |

Inačicu bira samo varijabla `DUCTURA_TEST_DATABASE`, koju postavlja projekt u `vitest.config.ts`; čita se jednom. Bez nje vrijedi `pglite`.

## Test ovlasti

PGlite ne dokazuje ovlasti, RLS ni SECURITY DEFINER (S-0.3). Test ovlasti ima dvije neovisne brane:

1. Datoteka je `*.pg.integration.test.ts`. Projekti `integration` i `database` je isključuju; projekt koji je pokreće na pravom PostgreSQL-u dolazi s DAN-785 b.
2. Poziv ima `{ authority: true }`; na PGliteu `createTestDatabase` to odbija prije nego što išta otvori.

Unit test (`create-test-database.test.ts`) drži globove projekata i to da nijedna `*.pg.integration.test.ts` ne imenuje PGlite.
