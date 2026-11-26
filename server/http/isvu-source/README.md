# isvu-source

HTTP rub ruta `institution.isvu-courses.get` i `institution.isvu-roster-imports.post` (SRV-V22-ISVU-POPIS, val 22): administrator ustanove čita popis kolegija probnog ISVU izvora i pregled upisanih studenata jednog kolegija. Potvrda je postojeća `institution.roster-import-confirm.post`. Ugovor izvora: [docs/contracts/isvu-v1.md](../../../docs/contracts/isvu-v1.md); port i sintetički adapter: `server/external/isvu`.

Redoslijed odbijanja: sjednica (401), oblik zahtjeva (422), tko je pozivatelj (403 ako nije potvrđeni administrator), postavka ustanove `off` (404), nepoznat kolegij izvora (404), na kraju riječ baze (404 za tuđi kolegij, kroz `institution.preview_roster_import`). Retci izvora šalju se u isti pregled kao retci datoteke (pišu se kao citirani CSV pa vrijede ista pravila). Nema nove tablice ni migracije; ocjene se ne čitaju ni ne pišu.

Produkcija: postavka je konstanta `PRODUCTION_ISVU_SETTING` (`off`), pa obje rute odgovaraju 404; `config/faculties/<fakultet>/isvu.json` čita se samo kad je `NODE_ENV` development ili test.
