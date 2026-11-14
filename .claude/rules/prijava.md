---
paths:
  - "server/session/**"
  - "server/external/srce-auth/**"
  - "server/http/**"
  - "server/roles/**"
  - "server/settings/**"
  - "server/access.ts"
  - "test-support/fake-oidc/**"
---

# Područje: prijava i ovlasti

Podsjetnik, ne pravilo. Pravila su u Ductus [CLAUDE.md](https://github.com/danielrisavi77-create/Ductus/blob/main/CLAUDE.md) („Tvrda pravila”, D-09) i [docs/backend/prijava-i-ovlasti.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/backend/prijava-i-ovlasti.md) §4.3; izvorni podsjetnik je Ductus [.claude/rules/evidencija-i-prijava.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/rules/evidencija-i-prijava.md).

- Studenti se prijavljuju isključivo preko AAI@EduHr (D-09). Nikakav drugi način prijave, ni privremeno.
- Lažni OIDC pružatelj (`test-support/fake-oidc/`, u Ductusu `infra/fake-oidc/`) smije raditi samo lokalno i u CI-ju.
- Uloga sama ne daje pristup sadržaju; pristup nastaje isključivo iz odnosa (Ustav C-23; Ductus [docs/PRODUCT.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/PRODUCT.md) §3).
- Identity, authz i session management su `Risk: critical`; ugovor i „Poznate granice” idu u opis PR-a prije reviewa (Ductus [docs/ENGINEERING_SYSTEM.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/ENGINEERING_SYSTEM.md) §5 i §14).
- Najčešći nalazi reviewa: Ductus [AGENTS.md](https://github.com/danielrisavi77-create/Ductus/blob/main/AGENTS.md), „Neovisni pregled”, točka 2.
