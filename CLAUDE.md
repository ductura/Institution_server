# ductura/server: pravila za AI agente

Ovaj dokument je tanki adapter. Ne uvodi nova pravila: pravila rada su ista kao u repozitoriju Ductus, a razlikuju se samo putanje (tablica niže). U sukobu vrijedi izvorni dokument u Ductusu, a ovaj se ispravlja.

## Izvori pravila

| Što                                                                    | Izvor                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tvrda pravila, izvori istine, vanjski botovi, preuzimanje posla, jezik | Ductus [CLAUDE.md](https://github.com/danielrisavi77-create/Ductus/blob/main/CLAUDE.md)                                                                                                                                                                                                    |
| Gate: uloge, risk razine, review, QA, invalidacija, critical PR        | Ductus [docs/ENGINEERING_SYSTEM.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/ENGINEERING_SYSTEM.md); prvo [sažetak](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/ENGINEERING_SYSTEM-SAZETAK.md), puni dokument samo u sekcijama koje zadatak traži |
| Načini rada (worker, review, qa ...) i oblik nalaza                    | Ductus [AGENTS.md](https://github.com/danielrisavi77-create/Ductus/blob/main/AGENTS.md)                                                                                                                                                                                                    |
| Kartice uloga (pisac, reviewer, QA)                                    | Ductus [.claude/uloge/README.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/uloge/README.md); pisac u oblaku i [pisac-oblak.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/uloge/pisac-oblak.md)                                             |
| Rječnik zabranjenih izraza i pravila koja proizvod nikad ne krši       | Ductus [docs/PRODUCT.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/PRODUCT.md) §5; vrijedi i ovdje                                                                                                                                                                    |
| Predaja posla i rotacija sesije                                        | Ductus [docs/MULTI-ACCOUNT.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/MULTI-ACCOUNT.md)                                                                                                                                                                            |
| Pisanje koda u ovom repou                                              | [docs/CODE_STYLE.md](docs/CODE_STYLE.md)                                                                                                                                                                                                                                                   |

Zadatak (identitet, prioritet, nositelj, status) je u Linearu (`DAN-xxx`); posao dodjeljuje orkestrator (`claude:b:orchestrator`).

## Tvrda pravila (preslika)

Izvor: Ductus [CLAUDE.md](https://github.com/danielrisavi77-create/Ductus/blob/main/CLAUDE.md), „Tvrda pravila”, i [docs/PRODUCT.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/PRODUCT.md) §3.

- Prijava studenata isključivo AAI@EduHr (D-09). Nikad ne dodaji drugi način prijave, ni privremeno, osim lažnog OIDC pružatelja koji radi samo lokalno i u CI-ju.
- Uloga sama ne daje pristup sadržaju; pristup nastaje isključivo iz odnosa (student u kolegiju, nastavnik zadatka, mentor rada). Ustav C-23.
- Pravila iz Ductus `docs/PRODUCT.md` §5 nikad se ne krše. Riječi iz rječnika zabranjenih izraza ne smiju se pojaviti u sučelju.
- Ništa se ne gradi na odluci sa statusom PRIJEDLOG ako bi promjena te odluke bila skupa. U tom slučaju stani i dodaj pitanje u Owner queue.
- Jedan korak (zadatak) po PR-u. Najviše oko 400 promijenjenih redaka koda; veći PR treba obrazloženje u opisu.
- Testovi moraju biti zeleni prije svakog commita. Nikad ne briši, ne preskači i ne stavljaj u karantenu test bez jednakovrijedne zamjene.
- Klijent nikad ne piše izravno u tablice evidencije, predaje ni revizijskog traga; samo kroz RPC.
- Svaka nova tablica ima RLS i retke u pgTAP matrici pristupa.
- Nikad ne koristi stvarne studentske radove ni osobne podatke u testovima i fixtureima.
- Tajne nikad u repou. Migracije se ne primjenjuju na produkciju iz agenta.
- `git add <putanje>`, nikad `git add -A`. Konvencionalni prefiksi: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.

## Putanje: Ductus → ovdje

| U Ductusu                                                                       | U ductura/server                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/migrations/`                                                                | `db/migrations/` (još ne postoji)                                                                                                                                                                         |
| `db/tests/`                                                                     | `db/tests/` (pgTAP; još ne postoji)                                                                                                                                                                       |
| `src/server/db/`                                                                | `server/database/` ([docs/CODE_STYLE.md](docs/CODE_STYLE.md) §9; još ne postoji)                                                                                                                          |
| `infra/fake-oidc/`                                                              | `test-support/fake-oidc/`                                                                                                                                                                                 |
| `src/server/`, `app/api/`                                                       | `server/`                                                                                                                                                                                                 |
| `src/lib/i18n/` i tekstovi sučelja                                              | `locales/`                                                                                                                                                                                                |
| `tests/`                                                                        | ne postoji; testovi su uz kod ([docs/CODE_STYLE.md](docs/CODE_STYLE.md) §7)                                                                                                                               |
| `**/*.test.ts`                                                                  | `server/**/*.test.ts` i `test-support/` ([README.md](README.md), „Testovi”)                                                                                                                               |
| issue #1091 za izvještaje sesija u oblaku                                       | Ductus issue #1836                                                                                                                                                                                        |
| issue ovog repoa, labele `ready-for-claude` i `claude:in-progress`, `Closes #N` | issuei i labele su u Ductusu; pisac u oblaku veže `DAN-xxx` i ispravan `Risk:` (Ductus [pisac-oblak.md](https://github.com/danielrisavi77-create/Ductus/blob/main/.claude/uloge/pisac-oblak.md), korak 3) |
| `pnpm orch:overlap`, `pnpm orch:preflight`                                      | još ne postoje (S-0.21); u izvještaju napiši da su preskočeni                                                                                                                                             |
| `scripts/forbidden-terms/scan.ts`                                               | još ne postoji; do tada rječnik provjerava review                                                                                                                                                         |

Pravila po putanjama su u [.claude/rules/](.claude/rules/) i podsjetnik su, ne nova pravila. Test `server/agent-rules.test.ts` provjerava da svaka datoteka pravila upućuje na izvor u Ductusu, da relativna poveznica vodi na postojeću datoteku u repou, a poveznica na Ductus na dokument s ručno provjerenog popisa u `server/agent-rules.ts`. Da je svaka stavka preslika izvora, provjerava review.

## Jezik

Tekst sučelja na hrvatskom. Kod, identifikatori i commit poruke na engleskom. Dokumenti u `docs/` na hrvatskom.
