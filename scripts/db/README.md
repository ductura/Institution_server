# scripts/db

Alati za migracije i lokalni stog glavne baze (D-91). Prijenos iz Ductusa na `d52a92c3a108f3f0ec9c3639188a2ea669bba582` (S-0.13, DAN-726; S-0.14, DAN-727): ista logika i isti testovi, promijenjene su samo putanje (`db/main/local`, `db/main/migrations`, `db/main/tests`), ime compose servisa (`postgres-main`) i tipovi.

- `migrations-ledger.ts`: knjiga `db/main/migrations.sum` sa SHA-256 svake migracije u `db/main/migrations/`. Bez argumenata provjerava knjigu, s `--base <sha>` i da nijedna migracija tog commita nije promijenjena ni uklonjena (migracije se samo dodaju), a s `--write` ponovno piše knjigu (`pnpm db:sum`). CI je pokreće u koraku „Knjiga migracija (D-91)”. Ductus: `scripts/engineering/migrations-ledger.mjs`.
  Svaka baza ima svoju knjigu i jedinstvene 14-znamenkaste verzije SQL migracija. Ako dvije datoteke u istoj bazi imaju istu verziju, provjera ispisuje oba imena, a `--write` prekida prije upisa bilo koje knjige.
- `migrate-locked.ts`: pokreće `dbmate up --strict` nad `db/main/migrations` dok na vlastitoj vezi drži `pg_advisory_lock`; gubitak veze, otkucaj koji ne uspije ili zapne i signal prije pokretanja zaustavljaju ga s izlazom 1. Veza je u [server/database](../../server/database/README.md). Ductus: `scripts/db/migrate-locked.mjs`.
- `native-db.ts`: `pnpm db:up:native` i `pnpm test:db:native`, glavna baza bez Dockera na lokalnom PostgreSQL-u (samo loopback). Redom pokreće isto što i `pnpm db:migrate`: `db/main/local/migrator.sql`, `dbmate up --strict` kao `ductus_migrator`, zatim prijave `app-login.sql`, `worker-login.sql` i `auth-login.sql` na lokalnom socketu. Lozinka prijave `ductus` nije javna: dolazi iz `DUCTUS_NATIVE_PGPASSWORD` ili se jednom stvara u datoteci 0600. Ductus: `scripts/db/native-db.mjs`.
- `pgtap.ts`: `pnpm test:db:logs` i `pnpm test:db:legal` (S-1F-d, DAN-797), `pg_prove --recurse --ext .sql` nad `testsDir` baze iz `databases.ts`, spoj iz `PG*` varijabli. Ruši pokretanje bez ijedne test datoteke, kad `pg_prove` nije pokrenuo svaku datoteku, bez ijednog testa ili s datotekom preskočenom cijelom (`1..0`); sam `pg_prove` tada izlazi s 0.
- `provision-worker.ts`, `provision-auth.ts`: prijave `ductus_worker_local` i `ductus_auth_local` u compose kontejneru `postgres-main`, s lozinkom iz `DUCTUS_WORKER_LOCAL_PASSWORD` i `DUCTUS_AUTH_LOCAL_PASSWORD` (najmanje 16 znakova; lozinka ide kao jedan argument, nikad kroz ljusku). Ductus: `scripts/db/provision-*.mjs`.
- `index.ts`: javno sučelje mape.

Docker put: `pnpm db:up` diže samo servis `postgres-main` iz `compose.yaml` i pokreće `pnpm db:migrate` (provizija, migracije kroz zaključani runner, prijave). Prije toga postavi `DUCTUS_WORKER_LOCAL_PASSWORD` i `DUCTUS_AUTH_LOCAL_PASSWORD`. Sve lozinke u repou su samo lokalne i tako označene (`*-local-only`).

Testovi: `migrations-ledger.test.ts` (uključuje provjeru da svježe izračunata knjiga bajt-za-bajt odgovara `db/main/migrations.sum`), `migrate-locked.test.ts` (lažni klijent i lažni dbmate, pravi dbmate samo za provjeru signala), `tests/db/migration-versions.test.ts` (nijedna verzija dvaput), `native-db.test.ts` i `provision-*.test.ts` (bez baze), `local-stack.test.ts` (skripte u `package.json` i `compose.yaml`) i `local-files.test.ts` (LF). Na pravom PostgreSQL-u (vitest projekt `database`, posao `database` u CI-ju): `tests/db/migrate-lock.integration.test.ts` (zaključavanje), 11 `tests/db/*-migration.integration.test.ts`, preneseni iz Ductusa `tests/integration` na `d52a92c3` s istim tvrdnjama, i `tests/db/local-roles.integration.test.ts` (uloge nakon `pnpm db:up:native` na vlastitom klasteru).

Dolazi kasnije: pgTAP (S-0.15).

## SRV-1409 / DAN-379 (M2.8)

Migracija [20261126100400_co_mentor_committee.sql](../../db/main/migrations/20261126100400_co_mentor_committee.sql) koristi postojeće vremenski ograničene dodjele po radu i radnji iz `institution.work_grant`. Mentor čita kroz mentorski odnos, a sumentor čita prije i poslije predaje kad mu je dodijeljena radnja `read_text`. Predaju rada upisuje student. Dodjela povjerenstvu na mentorstvu otvara pristup predanom dokumentu nakon upisa predaje.

Korisničko sučelje za sumentora i povjerenstvo dolazi u M6.12 nakon odluke U-1 o prikazu sadržaja. Lokalni `dbmate down` vraća prethodnu odluku o pristupu.
