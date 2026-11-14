---
paths:
  - "CLAUDE.md"
  - "AGENTS.md"
  - ".claude/**"
  - ".github/**"
---

# Područje: pravila rada, gate i alati

Podsjetnik, ne pravilo. Pravila su u Ductus [docs/ENGINEERING_SYSTEM.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/ENGINEERING_SYSTEM.md) §5 („Automatski risk floor”) i §10; izvorni podsjetnik je Ductus [.claude/rules/pravila-i-alati.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/rules/pravila-i-alati.md).

- Svaka od ovih putanja znači `Risk: critical` i spajanje samo na vlasnikovu naredbu za točan head (D-97, Ductus [docs/DECISIONS.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/DECISIONS.md); `docs/ENGINEERING_SYSTEM.md` §5 i §10).
- [CLAUDE.md](../../CLAUDE.md), [AGENTS.md](../../AGENTS.md) i ova pravila ostaju tanki adapteri bez novih pravila; izvor svakog pravila je dokument u Ductusu.
- Svaka datoteka ovdje i `AGENTS.md` upućuju na barem jedan izvor u Ductusu; relativna poveznica vodi na postojeću datoteku u repou, a poveznica na Ductus na dokument s ručno provjerenog popisa. To provjerava `server/agent-rules.test.ts`. Da je svaka stavka preslika izvora, provjerava review. Nova poveznica na Ductus traži redak u popisu izvora u `server/agent-rules.ts`.
- Ne mijenjaj postavke repoa na GitHubu ni zaštitu grane (Ductus [.claude/uloge/pisac-platforma.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/uloge/pisac-platforma.md)).
