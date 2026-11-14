# infra/postgres

Slika PostgreSQL-a 17.11 s pgTAP-om i `pg_prove` za servis `postgres-main` u `compose.yaml`, samo lokalno i u CI-ju (S-0.14, DAN-727). Doslovna kopija Ductus `infra/postgres/` na `d52a92c3a108f3f0ec9c3639188a2ea669bba582`.

- `Dockerfile`: pgTAP i klijent prikovani na verziju PostgreSQL-a iz bazne slike (DAN-711).
- `assert-pg-version.sh`: ruši izgradnju ako je instalacija pomaknula PostgreSQL.
- `pg-version.test.ts`: tablični test skripte i provjera da Dockerfile prikiva sve tri verzije (Ductus `pg-version.test.mjs`).
