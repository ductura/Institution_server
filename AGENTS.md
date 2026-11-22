# ductura/Institution_server: upute za AI coding agente

Ulazna točka za Codex i druge agente koji automatski čitaju `AGENTS.md`. Tanki adapter: ne uvodi nova pravila.

Prije rada pročitaj [CLAUDE.md](CLAUDE.md) u ovom repou: izvori pravila, tvrda pravila i razlike putanja u odnosu na Ductus.

- Načini rada (**worker**, **review**, **qa**, **bug-hunter**, **product-ux**, **orchestrator**), zajednička pravila i oblik nalaza u reviewu: Ductus [AGENTS.md](https://github.com/danielrisavi77-create/Ductus/blob/main/AGENTS.md). Ako način nije jasan, ne pretpostavljaj ovlast za pisanje.
- Gate (risk razine, review, QA, verdikti): Ductus [docs/ENGINEERING_SYSTEM.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/ENGINEERING_SYSTEM.md).
- Kartica uloge: Ductus [.claude/uloge/README.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/uloge/README.md). Kartice vrijede za svaki runtime; pravila u [.claude/rules/](.claude/rules/) učitava samo Claude Code.
- Pisanje koda: [docs/CODE_STYLE.md](docs/CODE_STYLE.md).
