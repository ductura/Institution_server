---
paths:
  - "CLAUDE.md"
  - "AGENTS.md"
  - ".claude/**"
  - ".github/**"
---

# Područje: pravila rada, gate i alati

Podsjetnik, ne pravilo. Pravila su u Ductus [docs/ENGINEERING_SYSTEM.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/ENGINEERING_SYSTEM.md) §5 („Automatski risk floor”) i §10; izvorni podsjetnik je Ductus [.claude/rules/pravila-i-alati.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/rules/pravila-i-alati.md).

- `CLAUDE.md`, `AGENTS.md` i svaki GitHub workflow su najmanje `Risk: critical`; datoteke s uputama za agente nikad nisu izuzete od reviewa kao `low` (Ductus `docs/ENGINEERING_SYSTEM.md` §5).
- [CLAUDE.md](../../CLAUDE.md), [AGENTS.md](../../AGENTS.md) i ova pravila ostaju tanki adapteri bez novih pravila; izvor svakog pravila je dokument u Ductusu.
- Svako pravilo ovdje upućuje na postojeći izvor; to provjerava `server/agent-rules.test.ts`. Nova poveznica na Ductus traži redak u popisu izvora u `server/agent-rules.ts`.
- Ne mijenjaj postavke repoa na GitHubu ni zaštitu grane (Ductus [.claude/uloge/pisac-platforma.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/uloge/pisac-platforma.md)).
