# Testne baze (S-1F-e, DAN-785)

Svaka baza iz `scripts/db/databases.ts` (`main`, `logs`, `legal` i svaka buduća) ima testnu inačicu iz istih migracija. Nova baza je novi redak u tom popisu, uz `db/<ime>/migrations`, `migrations.sum` i `local/migrator.sql`; ovdje se ne mijenja ništa.

```ts
import { createTestDatabase } from "../../test-support/database/create-test-database.ts";

const db = await createTestDatabase("logs"); // ili { authority: true } za test ovlasti
await db.query("SELECT 1");
await db.reset(); // stanje odmah nakon migracija
await db.close();
```

| Inačica    | Projekt i naredba                            | Što je                                                                                                                              |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pglite`   | `integration`, `pnpm test:integration`       | U procesu. Migrira jednom po imenu i procesu; svako otvaranje i svaki `reset()` daje novu kopiju, pa test ne vidi tuđe stanje.      |
| `postgres` | `integration-pg`, `pnpm test:integration:pg` | Već migrirana lokalna ili CI baza (`pnpm db:migrate`). Svaki test radi u jednoj transakciji koju `reset()` i `close()` poništavaju. |

Inačicu bira samo varijabla `DUCTURA_TEST_DATABASE`, koju postavlja projekt u `vitest.config.ts`; čita se jednom.

## Test ovlasti

PGlite ne dokazuje ovlasti, RLS ni SECURITY DEFINER (S-0.3). Test ovlasti ima dvije neovisne brane:

1. Datoteka je `*.pg.integration.test.ts`. Projekti `integration` i `database` je isključuju, a `integration-pg` uključuje samo takve. CI ga pokreće kroz `pnpm test:database`.
2. Poziv ima `{ authority: true }`; na PGliteu `createTestDatabase` to odbija prije nego što išta otvori.

Unit test (`create-test-database.test.ts`) drži globove projekata, skripte i to da nijedna `*.pg.integration.test.ts` ne imenuje PGlite, osim testa pariteta.

## Inačica `postgres`

- URL dolazi iz `compose.yaml`: objavljeni port i javni lokalni `POSTGRES_USER` i `POSTGRES_PASSWORD` servisa iz unosa (iste vrijednosti koristi CI). Prolazi samo `127.0.0.1` na lokalnom portu.
- Prije prvog testa provjerava da `schema_migrations` sadrži točno verzije iz mape migracija i da veza nema postavki s klijenta (`PGOPTIONS`).
- `reset()` i `close()`: `ROLLBACK`, `DISCARD ALL` (pripremljene naredbe, savjetodavna zaključavanja, privremeni objekti, postavke) i vraćanje svih sekvenci na vrijednost s otvaranja.
- Ako SQL testa sam završi transakciju (`COMMIT`, `ROLLBACK`, `COMMIT AND CHAIN`, i kad nakon njih slijedi greška), test pada, a baza dobiva tablicu `public.ductura_test_committed`. Od tada je svako otvaranje odbija, u svakom procesu, dok se baza ne migrira ispočetka.
- Granice:
  - Test koji treba commit ili drugu prijavu ostaje u `tests/db` (projekt `database`).
  - Veza je lokalni superuser, pa RLS ne vrijedi dok test sam ne napravi `SET ROLE`. Test ovlasti mora prijeći u ulogu koju provjerava. Superuser može izaći iz transakcije i mimo nje (`dblink`, `COPY … TO PROGRAM`); testna prijava bez superusera traži promjenu lokalnog stoga (`db/**`) i nije u ovom zadatku.
  - Provjera migracija uspoređuje verzije, ne sadržaj: datoteka promijenjena nakon primjene ne otkriva se (dbmate ne čuva sažetak).

## Paritet migracija

`migration-parity.pg.integration.test.ts` za svaku bazu uspoređuje otisak kataloga (`parity.ts`) u PGliteu i u PostgreSQL-u: sheme, relacije s vlasnikom, RLS-om i ACL-om, stupce, ograničenja, indekse, politike, funkcije (potpis, SECURITY DEFINER, postavke, vlasnik, ACL, sažetak tijela), okidače, tipove i primijenjene verzije. Razlika mora biti u `exceptions.ts` s razlogom; neupisana razlika i iznimka koja više ne postoji ruše test. Razlika u objektu migracije ne upisuje se bez dogovora na Ductus#1836. Otisak ne pokriva komentare, publikacije, velike objekte ni statistike. Jedina upisana iznimka je kolacija: PGlite ima samo `C`, a klaster lokalno i u CI-ju UTF-8 lokal iz `initdb`.
