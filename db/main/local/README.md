# db/main/local

Provizija i lokalni podaci glavne baze, samo za lokalni stog i CI, nikad za produkciju (S-0.14, DAN-727). SQL datoteke su doslovna kopija Ductus `db/local/*.sql` na `d52a92c3a108f3f0ec9c3639188a2ea669bba582`; komentari u njima zato još navode Ductus putanje (`db/local`, `scripts/db/*.mjs`, `db/migrations`).

- `migrator.sql` (dolazi s S-0.13, ductura/server#17): uloga `ductus_migrator` i grupne uloge prije prve migracije.
- `app-login.sql`, `worker-login.sql`, `auth-login.sql`: po jedna prijava, član točno jedne grupne uloge. Samo `app-login.sql` ima lozinku u repou (`ductus-app-local-only`); ostale je dobivaju iz okoline. Sve odbijaju TCP vezu.
- `seed.sql`, `demo-k3.sql`, `provision-demo-teacher.sql`, `evidence-signing-key.sql`: izmišljene ustanove i demo podaci.
- `psql-target.ts`, `demo-k3.ts`: gdje skripte pokreću psql (compose ili nativni socket) i učitavanje K-3 demo podataka. Ductus: `psql-target.mjs`, `demo-k3.mjs`. Runneri `evidence-signing-key.mjs` i `evidence-storage-domain.mjs` dolaze sa S-0.19 jer uvoze adaptere potpisa i pohrane.
- `roles.ts`: popis uloga iz Ductusa koji provjeravaju `roles.test.ts` (SQL datoteke) i `tests/db/local-roles.integration.test.ts` (prava baza).
- `index.ts`: javno sučelje mape.

Datoteke su LF na svakom sustavu (`.gitattributes`, provjera u `scripts/db/local-files.test.ts`).
