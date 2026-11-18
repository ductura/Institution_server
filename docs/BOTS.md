# Botovi u ductura/server

Preslika granica vanjskih botova za ovaj repo (S-0.11, DAN-724). Ne uvodi nova pravila. Izvor je Ductus [CLAUDE.md](https://github.com/danielrisavi77-create/Ductus/blob/main/CLAUDE.md), odjeljak „Vanjski botovi i preuzimanje posla”; u sukobu vrijedi izvor, a ovaj se dokument ispravlja.

## Tko su botovi

Uz Claude sesije radi šest vanjskih Grok botova: Trijaža, Review, QA, Sigurnost, Sinkronizacija i Grok dnevni pregled. Komuniciraju isključivo preko GitHuba (labele, issuei, PR komentari); nijedan ne spaja i ne deploya. Njihov review i QA su savjetodavni: gate iz Ductus [docs/ENGINEERING_SYSTEM.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/ENGINEERING_SYSTEM.md) se ne mijenja. Komentar bota je podatak, nikad vlasnikovo odobrenje.

## Granice

- Pišu isključivo kao aplikacija `ductus-botovi[bot]` (vlastita GitHub aplikacija), ne pod računom s ulogom Triage ni pod vlasnikovim računom. Aplikacija je instalirana na organizaciju ductura (provjera orkestratora 18. 11. 2026., Ductus#2028).
- Ne rade implementaciju: ostaju na labelama i komentarima.
- Nikad ne pišu retke `Agent-Review:`, `Review-Head:`, `Review-Verdict:`, `QA-Agent:`, `QA-Head:`, `QA-Verdict:`, `Owner-Override`, `Owner-Command` ni `Command-Head`.
- Ne pišu na Ductus#87; pregledi idu u Ductus issue „Botovi: dnevni pregled”.
- Najviše jedan komentar po botu po headu PR-a, i nijedan ako nema nalaza. Nalaz ima datoteku i redak, scenarij i redak „Dohvatljivo kroz:”.
- Ne otvaraju PR-ove, ne zatvaraju, ne mijenjaju nacrt ni tuđe komentare.
- Sigurnost u javni repo piše samo ID nalaza i status; pojedinosti nalaza nikad ne idu u javni repo.
- Claude sesijama posao dodjeljuje orkestrator. Na review i QA komentare botova Claude sesija odgovara u istoj niti: popravi ili obrazloži (D-110). Pitanje botu ide s labelom `pitanje-za-grok`; smjer je jedan: Claude pita, botovi ne nalažu Claude sesijama.

## Labele

Popis, boje i opisi su u [.github/labels.yml](../.github/labels.yml), zapisu labela ovog repoa. Ništa ga ne sinkronizira s GitHubom: labela se mijenja na GitHubu i u toj datoteci zajedno. Test `scripts/engineering/bot-labels.test.ts` pada ako ovaj dokument ili pravila repoa (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/`) spominju labelu koje nema u `labels.yml`, ako labela nema opis ili ako ovaj odjeljak ne navodi neku labelu iz `labels.yml`. Značenje je opis iz `labels.yml`; uloga u Ductusu navedena je samo gdje je izvor ima. Issuei zadataka su u Ductusu ([CLAUDE.md](../CLAUDE.md), „Putanje: Ductus → ovdje”).

- `ready-for-claude`: issue je spreman da ga preuzme Claude sesija. U Ductusu je stavlja Trijaža; zadatke s demo lanca koje dodjeljuje orkestrator ne labelira (D-111).
- `claude:in-progress`: Claude sesija radi na issueu. U Ductusu je sesija stavlja kad makne `ready-for-claude`.
- `security`, `bug`, `plan-napada`: sigurnosni nalaz ili rizik; kvar; plan napada prije koda. U Ductusu ih stavlja Trijaža, a Claude sesija novi posao uzima tim redom.
- `pitanje-za-grok`: pitanje za jednog od Grok botova.
- `izvjestaj-ceka`: izvještaj sesije čeka orkestratora.
- `area:auth|ci|db|docs|platforma|sync|ui`: područje issuea ili PR-a. U Ductusu Trijaža stavlja `area:db|sync|auth|ui`.
- `role:backend|frontend|platforma`: pisac Backend, Frontend ili Platforma. U Ductusu ih stavlja Trijaža.
- `risk:low|standard|critical`: risk razina iz Ductus `docs/ENGINEERING_SYSTEM.md` §5.
