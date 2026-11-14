# scripts/db

Alati za migracije glavne baze (D-91). Prijenos iz Ductusa na `d52a92c3a108f3f0ec9c3639188a2ea669bba582` (S-0.13, DAN-726): ista logika i isti testovi, promijenjene su samo putanje i tipovi.

- `migrations-ledger.ts`: knjiga `db/main/migrations.sum` sa SHA-256 svake migracije u `db/main/migrations/`. Bez argumenata provjerava knjigu, s `--base <sha>` i da nijedna migracija tog commita nije promijenjena ni uklonjena (migracije se samo dodaju), a s `--write` ponovno piše knjigu (`pnpm db:sum`). CI je pokreće u koraku „Knjiga migracija (D-91)”. Ductus: `scripts/engineering/migrations-ledger.mjs`.
- `migrate-locked.ts`: pokreće `dbmate up --strict` nad `db/main/migrations` dok na vlastitoj vezi drži `pg_advisory_lock`; gubitak veze, otkucaj koji ne uspije ili zapne i signal prije pokretanja zaustavljaju ga s izlazom 1. Veza je u [server/database](../../server/database/README.md). Ductus: `scripts/db/migrate-locked.mjs`.
- `index.ts`: javno sučelje mape.

Testovi: `migrations-ledger.test.ts` (uključuje provjeru da svježe izračunata knjiga bajt-za-bajt odgovara `db/main/migrations.sum`), `migrate-locked.test.ts` (lažni klijent i lažni dbmate, pravi dbmate samo za provjeru signala) i `tests/db/migration-versions.test.ts` (nijedna verzija dvaput).

Dolazi kasnije: `pnpm db:migrate` s provizioniranjem i test zaključavanja protiv pravog PostgreSQL-a (S-0.14), pgTAP (S-0.15).
