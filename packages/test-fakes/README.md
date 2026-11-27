# @ductura/test-fakes

Lažne zamjene za testove servera i klijenata (U9, DAN-741). **Samo lokalno i u CI-ju (D-09).** Svi računi, ključevi i podaci su izmišljeni.

| Uvoz                                 | Što                                                                                                                                                                                                                      | Porijeklo                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `@ductura/test-fakes/oidc`           | Lažni AAI OIDC pružatelj, načini `success`, `refuse`, `expired`, `unavailable` ([README](oidc/README.md))                                                                                                                | premješten iz `test-support/` (S-0.16)                                         |
| `@ductura/test-fakes/fake-server`    | Lažni server iz ugovora: vraća vektore, ostalo 501                                                                                                                                                                       | ponovni izvoz `server/contracts/generated/fake-server/` (U8); generator ostaje |
| `@ductura/test-fakes/clock`          | `createFakeClock`: sat koji se pomiče samo s `advance`                                                                                                                                                                   | novo                                                                           |
| `@ductura/test-fakes/services`       | `createFakeService`: vanjska usluga kao `fetch` bez porta, `ok`, `slow` (čeka lažni sat), `down`                                                                                                                         | novo                                                                           |
| `@ductura/test-fakes/fido2`          | `createSoftwareAuthenticator`: softverski FIDO2 (ES256), `clone()` i `withForeignKey()` za negativne testove                                                                                                             | novo                                                                           |
| `@ductura/test-fakes/hostile-inputs` | `hostileStrings`, `HOSTILE_STRINGS`, `HOSTILE_KEYS`, `HOSTILE_JSON`, `hostileObjects`: zajednička tablica neprijateljskih ulaza za validatore ([README](hostile-inputs/README.md))                                       | novo (DAN-947)                                                                 |
| `@ductura/test-fakes/invented-works` | `generateInventedWork`, `serializeInventedWork`: izmišljen seminarski rad na hrvatskom i simulirano pisanje (isto sjeme, isti bajtovi), kao lanac nepotpisanih odsječaka evidencije ([README](invented-works/README.md)) | novo (DAN-1566)                                                                |
| `@ductura/test-fakes/pglite`         | `createPgliteDatabase`: migrirana baza po imenu iz `scripts/db/databases.ts` (`main`, `logs`, `legal`) u PGlite-u, nova po pozivu; `createFakeLogDatabase`: lažna baza zapisa, samo dopisivanje                          | novo (U9-b)                                                                    |
| `@ductura/test-fakes/dev-server`     | Lažni razvojni server za web: sve rute `/api/v1`, stanje u memoriji, prekidač uloge ([README](dev-server/README.md)); ne objavljuje se                                                                                   | novo (Ductus#2028)                                                             |
| `@ductura/test-fakes/tsa`            | Lažni TSA RFC 3161 kao `fetch` bez porta, jedan način po golden slučaju ISTR-2; `createTestPki`: testni korijen, posrednik i TSA certifikati nastaju u testu ([README](tsa/README.md))                                   | novo (ISTR-2)                                                                  |
| `@ductura/test-fakes/assistant`      | `createFakeAi`, `fakeAiFromEnv`: lažni lokalni AI pružatelj iza porta asistenta, deterministički odgovori, odbijanje, istek, prekid; uključuje se samo s `DUCTURA_FAKE_AI_LOCAL=1` ([README](assistant/README.md))       | novo (SRV-FAKE-AI-LOKALNO)                                                     |
| `@ductura/test-fakes`                | sve gore                                                                                                                                                                                                                 |                                                                                |

## Instalacija bez tokena (DAN-966)

Svaka objavljena verzija je i `.tgz` na javnom GitHub Releaseu oznake `test-fakes-v2.0.0`, pa instalacija ne traži token (GitHub Packages ga traži i za javne pakete):

```sh
pnpm add -D https://github.com/ductura/Institution_server/releases/download/test-fakes-v2.0.0/ductura-test-fakes-2.0.0.tgz
```

Tarball je isti onaj koji je `publish.yml` provjerio i objavio; njegov sha256 je u bilješci izdanja.

## PGlite (U9-b)

- **PGlite ne zamjenjuje pgTAP ni pravi PostgreSQL ni u jednom CI koraku.** Služi samo unit i brzim integracijskim testovima. Ovlasti, RLS, SECURITY DEFINER, pgTAP, utrke i pg-boss ostaju na pravom PostgreSQL-u (S-0.3, Ductus#2003, `spikes/pglite/NALAZI.md` §5).
- `createPgliteDatabase({ database })` prima svako ime iz `scripts/db/databases.ts`; nepoznato ime je greška (S-1F-e, DAN-785). Baza dobiva ime kao u produkciji (`ductus`, `ductus_logs`, `ductus_legal`). Migracije čita iz istog direktorija koji dobiva dbmate (`migrationsDir` unosa) i prije primjene ih provjerava prema njegovu ledgeru; nesklad ruši tvornicu. Redoslijed je kao u CI-ju: `CREATE DATABASE` kao superuser, `db/<ime>/local/migrator.sql`, migracije s migratorom unosa kao korisnikom sesije (kao dbmate s `role=`, pa ni `RESET ROLE` ne vraća na superusera; migracija koja sama završi transakciju ruši tvornicu), zatim `local/app-login.sql` ako postoji. Uloge prijave workera i autentikacije glavne baze se ne stvaraju.
- Testovi ne zovu tvornicu izravno nego `createTestDatabase` iz [test-support/database](../../test-support/database/README.md), koja migrira jednom po imenu i daje svjež primjerak po testu.
- `createFakeLogDatabase()`: baza zapisa `ductus_logs` migrirana u PGlite-u (`createPgliteDatabase({ database: "logs" })`, tablica `public.log_entry` iz `db/logs/migrations`, S-1K.2-a). `append` piše kao `ductus_logs_writer` (samo `INSERT` stupaca `kind` i `payload`, bez `SELECT`-a, pa ne može krivotvoriti `id` ni `at` ni čitati povijest), a `entries` čita kao vlasnik (`ductus_logs_migrator`, politika `log_entry_owner_read`), jer čitač nema pravo na tablicu i čita samo kroz `operator_log` (DAN-835-4); okidači `ENABLE ALWAYS` odbijaju `UPDATE`, `DELETE` i `TRUNCATE` i vlasniku (`ductus_logs_migrator`), superuseru i pod `session_replication_role = replica`. Superuser ili vlasnik koji svjesno skine okidač (DDL) može je promijeniti, kao i u pravom PostgreSQL-u; dokaz prava je pgTAP `db/logs/tests/010-log-entry.sql`.
- Privremena shema zapisa (`pglite/log-schema.sql`) obrisana je u S-1K.2-a (DAN-813) kad je migracija baze zapisa donijela tablicu; test pada ako se vrati uz tu migraciju.
- Testovi s PGlite-om su `*.integration.test.ts` (oko 2 s po migriranoj bazi).

## Granica prema produkciji

- Paket je `private` i u korijenskom `package.json` je samo u `devDependencies`.
- Uvoz bilo kojeg ulaza uz `NODE_ENV` izvan nepostavljenog, `development` i `test` baca grešku.
- Lint `local/no-fake-server-import` odbija `@ductura/test-fakes` i `packages/test-fakes/` u produkcijskom kodu.
- `boundary.test.ts` provjerava produkcijsko zatvorenje ovisnosti (`pnpm list --prod`) i da nijedna ne-testna datoteka u `server/` ne učitava paket.
- Uvoz podputa koji nije u `exports` pada.
- `@electric-sql/pglite` je ovisnost samo ovog paketa; `boundary.test.ts` provjerava da nije u produkcijskom zatvorenju i da ga nijedna ne-testna datoteka u `server/` ne imenuje.
