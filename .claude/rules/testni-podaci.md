---
paths:
  - "server/**/*.test.ts"
  - "test-support/**"
  - "db/tests/**"
---

# Područje: testovi i fixturei

Podsjetnik, ne pravilo. Pravila su u Ductus [CLAUDE.md](https://github.com/danielrisavi77-create/Ductus/blob/main/CLAUDE.md) („Tvrda pravila”) i [docs/TESTING.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/TESTING.md); izvorni podsjetnik je Ductus [.claude/rules/testni-podaci.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/rules/testni-podaci.md). Projekti testova u ovom repou: [README.md](../../README.md), „Testovi”.

- Samo sintetički podaci: nikad stvarni studentski radovi ni osobni podaci (u primjerima domena `.invalid`).
- Test se ne briše, ne preskače i ne stavlja u karantenu bez jednakovrijedne zamjene.
- Popravak prihvaćenog nalaza ide s testom koji bez popravka pada (Ductus [AGENTS.md](https://github.com/danielrisavi77-create/Ductus/blob/main/AGENTS.md), „Neovisni pregled”, točka 4).
