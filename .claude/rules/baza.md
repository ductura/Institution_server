---
paths:
  - "db/**"
  - "server/database/**"
---

# Područje: baza i migracije

Podsjetnik, ne pravilo. Pravila su u Ductus [CLAUDE.md](https://github.com/danielrisavi77-create/Ductus/blob/main/CLAUDE.md) („Tvrda pravila”), [docs/backend/prijava-i-ovlasti.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/backend/prijava-i-ovlasti.md) §4.4 i [docs/backend/baza-i-pogon.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/backend/baza-i-pogon.md) §4.8; izvorni podsjetnik je Ductus [.claude/rules/baza.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/rules/baza.md).

- Svaka nova tablica ima RLS i retke u pgTAP matrici pristupa.
- Pisanje klijenta u tablice evidencije, predaje i revizijskog traga ide samo kroz RPC; provjeri to u pgTAP matrici, ne samo u kodu.
- Pristup nastaje samo iz odnosa, ne iz uloge (Ustav C-23; Ductus [docs/PRODUCT.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/PRODUCT.md) §3).
- RLS, pgTAP matrica, sve migracije (`db/migrations/`) i `server/database/` (u Ductusu `src/server/db/`) su najmanje `Risk: critical` (Ductus [docs/ENGINEERING_SYSTEM.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/ENGINEERING_SYSTEM.md) §5).
- Migracije se nikad ne primjenjuju na produkciju iz agenta.
- Nova migracija nastaje samo kroz `pnpm db:new <ime> [--db main|logs|legal]`; kad CI javi da verzija nije iznad baze, pokreni `pnpm db:renumber` (vlasnikov nalog SRV-MIGRACIJE-BROJEVI, [scripts/db/README.md](../../scripts/db/README.md)).
