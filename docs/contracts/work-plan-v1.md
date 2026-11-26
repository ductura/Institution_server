# Plan rada v1

Zadatak: F4-PM2-R15-SRV `f4-pm2-r15-srv` (Ductus#2059, nalog c.7199153557; redak PM2-R15 pregleda funkcija prije F4, korak M5.14b plana). Status: **aditivno, unatrag kompatibilno** (API 1.162.0). Baza je `20261220380000_work_plan.sql` (tablica `collaboration.work_plan`, RPC `get_work_plan`, `put_work_plan`, `delete_work_plans`); rute su montirane iz `server/http/work-plan/` (`createWorkPlanRoutesFor(databases.main)`). Lažni dev server ih odgovara izmišljenim podacima.

## Načela

- **Plan nije promjena dokumenta** (D-234 točka 1): nije u evidenciji, prikazu uživo (D-142) ni reprodukciji (D-143) i ne piše dokument, reviziju, segment, potvrdu ni sažetak.
- **Vidi ga samo student vlasnik rada** (D-234 točka 2; C-23, iz odnosa, ne iz uloge). Mentor, nastavnici rada i administrator dobivaju isti 404 kao za tuđi, nepoznati i neispravan rad.
- **Piše se cijeli.** Uređaj šalje pitanje, sve svrhe i sve pojmove; izmjena, uklanjanje i pražnjenje su jedan poziv. Plan bez pitanja, svrha i pojmova se ne čuva. Uređiv je i tijekom dorade (D-234 točka 6); ništa se ne čuva po rundi.
- **Poglavlje je id bloka naslova** (kao `nodeId` sidra), nikad tekst rada. Poslužitelj plan ne uspoređuje s dokumentom: svrhu poglavlja kojeg više nema briše klijent pri sljedećem upisu.
- **Briše se s radom** (D-130): sweep `collaboration.purge_orphan_work_data` uklanja plan rada kojeg više nema (uz pravne zadrške kao ostalo).
- Samo izmišljeni podaci u vektorima, fixtureima i primjerima.

## Rute

Obje na `/api/v1/works/{documentId}/plan`, pristup `student_owner`. Svaka ima 401 `unauthorized`, 404 `not_found` i 503 `unavailable`; `PUT` još `MUTATION_GUARD`, 415, 400 `invalid_json` i 422 `invalid_input`. Nova klasa pristupa se ne uvodi, nema novih kodova grešaka.

| ID rute         | Metoda i put | Opis                                          |
| --------------- | ------------ | --------------------------------------------- |
| `work.plan.get` | `GET …`      | plan koji vlasnik čuva (prazan ako ga nema)   |
| `work.plan.put` | `PUT …`      | zamjenjuje cijeli plan, odgovara kakav je sad |

Oblik plana: `{question, purposes, terms, updatedAt}`.

- `question`: `null` ili jedan redak od 1 do 300 znakova.
- `purposes`: do 200 `{nodeId, purpose}`; `nodeId` UUID bloka (jednom), `purpose` jedan redak od 1 do 300.
- `terms`: do 200 `{term, definition, kind}`; `term` redak od 1 do 80 (jednom, velika i mala slova su isto), `definition` redak od 1 do 500, `kind` `term` ili `abbreviation` (D-250 točka 8: kratice su u Pojmovniku).
- Redak je NFC, bez kontrolnih znakova i bidi kontrole, bez razmaka na rubovima (inače 422). Duplikat bloka ili pojma, više od 200 stavki i nepoznato polje su 422.
- `updatedAt` je `null` dok plan ne postoji. `GET` bez plana: `{question: null, purposes: [], terms: [], updatedAt: null}`.
- Tijelo `PUT` do 1 MiB (gornja granica koju shema dopušta u UTF-8).

## Što ugovor ne odlučuje

- podcrtavanje pojmova u tekstu (D-250 točka 5) i prikaze Nit i Pojmovnik: web (M5.14c);
- vidljivost mentoru (D-234 točka 2: u valu 1 ne vidi); proširenje je promjena prava i odluka vlasnika;
- usklađivanje svrha s blokovima dokumenta, snimke plana po rundi dorade i istodobno uređivanje s dva uređaja (zadnji upis vrijedi).
