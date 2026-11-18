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
- Sigurnost u ovaj repo piše samo ID nalaza i status; pojedinosti nalaza nikad ne idu u javni repo.
- Claude sesijama posao dodjeljuje orkestrator. Na review i QA komentare botova Claude sesija odgovara u istoj niti: popravi ili obrazloži. Nakon kanonskog PASS-a na nalaz bota se ne pusha, osim ako je označen kao blokirajući (D-110). Pitanje botu ide s labelom `pitanje-za-grok`; smjer je jedan: Claude pita, botovi ne nalažu Claude sesijama.

## Labele

Popis, boje i opisi su u [.github/labels.yml](../.github/labels.yml), zapisu labela ovog repoa. Ništa ga ne sinkronizira s GitHubom (opseg DAN-724). Ovaj odjeljak navodi svaku labelu iz `labels.yml` točno jednim retkom oblika „crtica, naziv u kodu, dvotočka, značenje”. Test `scripts/engineering/bot-labels.test.ts` pada ako labela nema opis, ako za neku labelu nema takvog retka ili ih ima više, ako redak navodi labelu koje nema u `labels.yml` ili ako redak popisa nije tog oblika. Odjeljak završava na prvom sljedećem retku koji počinje znakom „#”. Ograde koda i HTML komentari nisu dopušteni nigdje u ovom dokumentu, da ništa ne može sakriti popis. Uz svaku labelu stoji kratko značenje (puni opis je u `labels.yml`), a uloga u Ductusu samo gdje je izvor ima. Issuei zadataka su u Ductusu ([CLAUDE.md](../CLAUDE.md), „Putanje: Ductus → ovdje”).

- `ready-for-claude`: issue je spreman da ga preuzme Claude sesija. U Ductusu je stavlja Trijaža; zadatke s demo lanca koje dodjeljuje orkestrator ne labelira (D-111).
- `claude:in-progress`: Claude sesija radi na ovom issueu. U Ductusu je sesija stavlja kad makne `ready-for-claude`.
- `security`: sigurnosni nalaz ili rizik. U Ductusu je stavlja Trijaža; Claude sesija novi posao uzima redom sigurnost, kvar, plan napada.
- `bug`: kvar (opis je GitHubov zadani, „Something isn't working”). U Ductusu je stavlja Trijaža.
- `plan-napada`: plan napada prije koda. U Ductusu je stavlja Trijaža.
- `pitanje-za-grok`: pitanje za jednog od Grok botova.
- `izvjestaj-ceka`: izvještaj sesije čeka orkestratora.
- `area:auth`: područje prijave i ovlasti. U Ductusu je stavlja Trijaža.
- `area:ci`: CI, GitHub Actions workflowi i gate provjere.
- `area:db`: područje baze. U Ductusu je stavlja Trijaža.
- `area:docs`: područje dokumentacije.
- `area:platforma`: razvojna platforma, alati, demo stog i botovi.
- `area:sync`: područje sinkronizacije. U Ductusu je stavlja Trijaža.
- `area:ui`: područje sučelja. U Ductusu je stavlja Trijaža.
- `role:backend`: pisac Backend. U Ductusu je stavlja Trijaža.
- `role:frontend`: pisac Frontend. U Ductusu je stavlja Trijaža.
- `role:platforma`: pisac Platforma. U Ductusu je stavlja Trijaža.
- `risk:low`: rizik low; razine su u Ductus `docs/ENGINEERING_SYSTEM.md` §5.
- `risk:standard`: rizik standard; razine su u Ductus `docs/ENGINEERING_SYSTEM.md` §5.
- `risk:critical`: rizik critical; razine su u Ductus `docs/ENGINEERING_SYSTEM.md` §5.
