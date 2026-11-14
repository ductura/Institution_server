# scripts/db

Lokalni stog glavne baze (S-0.14, DAN-727). Prijenos iz Ductusa na `d52a92c3a108f3f0ec9c3639188a2ea669bba582`: ista logika i isti testovi, promijenjene su samo putanje (`db/main/local`, `db/main/migrations`, `db/main/tests`), ime servisa (`postgres-main`) i tipovi.

- `native-db.ts`: `pnpm db:up:native` i `pnpm test:db:native`, glavna baza bez Dockera na lokalnom PostgreSQL-u (samo loopback). Redom pokreće isto što i `pnpm db:migrate`: `db/main/local/migrator.sql`, `dbmate up --strict` kao `ductus_migrator`, zatim prijave `app-login.sql`, `worker-login.sql` i `auth-login.sql` na lokalnom socketu. Lozinka prijave `ductus` nije javna: dolazi iz `DUCTUS_NATIVE_PGPASSWORD` ili se jednom stvara u datoteci 0600. Ductus: `scripts/db/native-db.mjs`.
- `provision-worker.ts`, `provision-auth.ts`: prijave `ductus_worker_local` i `ductus_auth_local` u compose kontejneru `postgres-main`, s lozinkom iz `DUCTUS_WORKER_LOCAL_PASSWORD` i `DUCTUS_AUTH_LOCAL_PASSWORD` (najmanje 16 znakova; lozinka ide kao jedan argument, nikad kroz ljusku). Ductus: `scripts/db/provision-*.mjs`.
- `index.ts`: javno sučelje mape.

Docker put: `pnpm db:up` diže samo servis `postgres-main` iz `compose.yaml` i pokreće `pnpm db:migrate` (provizija, migracije kroz zaključani runner, prijave). Prije toga postavi `DUCTUS_WORKER_LOCAL_PASSWORD` i `DUCTUS_AUTH_LOCAL_PASSWORD`. Sve lozinke u repou su samo lokalne i tako označene (`*-local-only`).

Testovi: `native-db.test.ts` i `provision-*.test.ts` (bez baze), `local-stack.test.ts` (skripte u `package.json` i `compose.yaml`), `local-files.test.ts` (LF) i `tests/db/local-roles.integration.test.ts` (uloge u pravoj bazi nakon `pnpm db:up:native`; u CI-ju ga pokreće posao „PostgreSQL i pgTAP” nakon `pnpm db:up:native` na vlastitom klasteru).

Ne uvozi ništa iz `server/` osim javnog sučelja `db/main/local/index.ts`.
