# @ductura/test-fakes

Lažne zamjene za testove servera i klijenata (U9, DAN-741). **Samo lokalno i u CI-ju (D-09).** Svi računi, ključevi i podaci su izmišljeni.

| Uvoz                              | Što                                                                                                                                    | Porijeklo                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@ductura/test-fakes/oidc`        | Lažni AAI OIDC pružatelj, načini `success`, `refuse`, `expired`, `unavailable` ([README](oidc/README.md))                              | premješten iz `test-support/` (S-0.16)                                         |
| `@ductura/test-fakes/fake-server` | Lažni server iz ugovora: vraća vektore, ostalo 501                                                                                     | ponovni izvoz `server/contracts/generated/fake-server/` (U8); generator ostaje |
| `@ductura/test-fakes/clock`       | `createFakeClock`: sat koji se pomiče samo s `advance`                                                                                 | novo                                                                           |
| `@ductura/test-fakes/services`    | `createFakeService`: vanjska usluga kao `fetch` bez porta, `ok`, `slow` (čeka lažni sat), `down`                                       | novo                                                                           |
| `@ductura/test-fakes/fido2`       | `createSoftwareAuthenticator`: softverski FIDO2 (ES256), `clone()` i `withForeignKey()` za negativne testove                           | novo                                                                           |
| `@ductura/test-fakes/pglite`      | `createPgliteDatabase`: migrirana glavna baza u PGlite-u, nova po pozivu; `createFakeLogDatabase`: lažna baza zapisa, samo dopisivanje | novo (U9-b)                                                                    |
| `@ductura/test-fakes`             | sve gore                                                                                                                               |                                                                                |

## PGlite (U9-b)

- **PGlite ne zamjenjuje pgTAP ni pravi PostgreSQL ni u jednom CI koraku.** Služi samo unit i brzim integracijskim testovima. Ovlasti, RLS, SECURITY DEFINER, pgTAP, utrke i pg-boss ostaju na pravom PostgreSQL-u (S-0.3, Ductus#2003, `spikes/pglite/NALAZI.md` §5).
- `createPgliteDatabase({ database: "main" })` čita migracije iz istog direktorija koji dobiva dbmate (`db/main/migrations`, `scripts/db/migrations-ledger.ts`) i prije primjene ih provjerava prema `db/main/migrations.sum`; nesklad ruši tvornicu. Svaka migracija ide u svojoj transakciji, a `ductus_migrator` je korisnik sesije (kao dbmate s `role=`), pa ni `RESET ROLE` ne vraća na superusera; migracija koja sama završi transakciju ruši tvornicu. Uz to, uz `db/main/local/migrator.sql` prije i `app-login.sql` poslije.
- `createFakeLogDatabase()`: `append` i `entries` rade kao `fake_logs_writer` (samo `SELECT` i `INSERT` stupaca `kind` i `payload`, pa ne može krivotvoriti `id` ni `at`); okidači `ENABLE ALWAYS` odbijaju `UPDATE`, `DELETE` i `TRUNCATE` i vlasniku, superuseru i pod `session_replication_role = replica`. Superuser ili vlasnik tablice `fake_logs_owner` koji svjesno skine okidač (DDL) može je promijeniti, kao i u pravom PostgreSQL-u.
- Shema zapisa (`pglite/log-schema.sql`) je privremena: briše je S-1F kad donese `db/logs/migrations` ([plan](../../docs/PLAN.md), U9 i S-1F-e). Test pada dok postoje obje.
- Testovi s PGlite-om su `*.integration.test.ts` (oko 2 s po migriranoj bazi).

## Granica prema produkciji

- Paket je `private` i u korijenskom `package.json` je samo u `devDependencies`.
- Uvoz bilo kojeg ulaza uz `NODE_ENV` izvan nepostavljenog, `development` i `test` baca grešku.
- Lint `local/no-fake-server-import` odbija `@ductura/test-fakes` i `packages/test-fakes/` u produkcijskom kodu.
- `boundary.test.ts` provjerava produkcijsko zatvorenje ovisnosti (`pnpm list --prod`) i da nijedna ne-testna datoteka u `server/` ne učitava paket.
- Uvoz podputa koji nije u `exports` pada.
- `@electric-sql/pglite` je ovisnost samo ovog paketa; `boundary.test.ts` provjerava da nije u produkcijskom zatvorenju i da ga nijedna ne-testna datoteka u `server/` ne imenuje.
