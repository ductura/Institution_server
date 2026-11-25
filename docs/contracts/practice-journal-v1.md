# Dnevnik stručne prakse v1

Zadatak: SRV-V19-DNEVNIK-UGOVOR `v19-dnevnik-ugovor` (Ductus#2055, nalog c.7146962118; val 19, `docs/nalazi/val19-razlika.md` u WEB repou, §5 zadatak 1, nalazi V19-1 do V19-4). Status: **aditivno, unatrag kompatibilno** (API 1.117.0). Baza je `SRV-V19-DNEVNIK-BAZA`, a rute su montirane sa `SRV-V19-DNEVNIK-RUTE` (`server/http/practice-journal/`). Lažni dev server ih odgovara izmišljenim podacima.

## Zašto

Mentorstvo, etape i suglasnost mentora (`work_mentor_consent_event`) vežu se uz završni i diplomski rad. Stručna praksa nema ništa vlastito: ni razdoblje, ni zapise po danima, ni potvrdu mentora. Praksa se **ne** modelira kao vrsta rada (`workType` je zatvoren skup u tri ugovora, V19-1) nego kao zaseban zapis uz postojeće aktivno mentorstvo.

## Načela

- **Praksa** (`placement`) je razdoblje u jednoj organizaciji uz jedno mentorstvo, dakle s točno jednim mentorom. Jedan student može imati više praksi.
- **Mentor je nastavnik ustanove** (AAI `djelatnik`, D-09). Voditelj prakse u organizaciji nema račun i ne potpisuje u Ducturi (V19-2, OP-V19-1).
- **Potpis je zapis u Ducturi, ne kvalificirani potpis** (V19-3): tko je potpisao koji skup zapisa (JCS SHA-256), kada, uz neobavezan komentar. Pravna snaga čeka pravnu osobu ustanove (OP-V19-1) i ovaj ugovor je ne određuje.
- **Zapis samo za dodavanje** (V19-4): ništa se ne mijenja ni ne briše. Ispravak je novi zapis koji navodi onaj koji ispravlja (`correctsEntryId`). Potpisani zapis ostaje kakav je potpisan; ispravak nakon potpisa traži novi potpis. Potpis se ne povlači: novi ga u prikazu nadomješta, stari ostaje u povijesti.
- **Bez ocjene i bez ranga:** ništa iz dnevnika ne ulazi u ocjenu ni u izvoz ocjene (ocjena ostaje u Merlinu); nema zbroja sati, usporedbe, praga, oznake „premalo” ni automatske sankcije. Ne gradi se na zabilježenim događajima: unos u dnevnik ne ide kroz lanac evidencije i nema izračun podrijetla.
- **Mentorove privatne bilješke** (`mentorship.notes`) student nikad ne vidi i nisu dio nijednog odgovora; komentar uz potpis student vidi.
- **Tuđe, nepoznato i neispravno je isti 404** (C-23), i za pogrešnu ulogu u praksi koju osoba inače smije čitati (npr. mentor koji pokuša dodati zapis).
- Samo izmišljeni podaci u vektorima, fixtureima i primjerima.

## Rute

Sve ispod `/api/v1/practice/placements`. Svaka ima 401 `unauthorized`, 404 `not_found` (gdje ima ID u putu ili tijelu), 503 `unavailable`; mutacije još `MUTATION_GUARD`, 415, 400 `invalid_json` i 422 `invalid_input`; odgovori nose `cache-control: no-store`.

| ID rute                    | Metoda i put                    | Pristup          | Tko                                          |
| -------------------------- | ------------------------------- | ---------------- | -------------------------------------------- |
| `practice.placements.post` | `POST …/placements`             | `mentor_teacher` | mentor aktivnog mentorstva                   |
| `practice.placements.get`  | `GET …/placements`              | `signed_in`      | student: svoje; nastavnik: samo mentorirane  |
| `practice.entries.get`     | `GET …/{placementId}/entries`   | `signed_in`      | student prakse i njezin mentor               |
| `practice.entries.post`    | `POST …/{placementId}/entries`  | `student`        | samo student prakse                          |
| `practice.signoffs.post`   | `POST …/{placementId}/signoffs` | `mentor_teacher` | samo mentor prakse                           |
| `practice.signoffs.get`    | `GET …/{placementId}/signoffs`  | `signed_in`      | student prakse i njezin mentor, isti odgovor |

Pristup u ugovoru je deklaracija; odlučuje baza (RLS i RPC, kasniji zadatak).

### `practice.placements.post`

Tijelo: `{mentorshipId, organisationName, startsOn, endsOn}`; `organisationName` jedan redak od 1 do 120 točaka koda; datumi ISO (`YYYY-MM-DD`), `startsOn` ≤ `endsOn` (inače 422). Odgovor `201 {placementId}`. `mentorshipId` koji nije UUID je 422 `invalid_input` (greška oblika tijela); mentorstvo koje je tuđe, nepoznato ili završeno je 404. Ustanova može dodati ograničenje duljine razdoblja kasnije; ugovor ga ne određuje.

### `practice.placements.get`

`200 {placements:[{placementId, mentorshipId, organisationName, startsOn, endsOn, entryCount, signedThrough|null}]}`; najkasniji početak prvi, zatim `placementId`; najviše 200. `entryCount` broji sve zapise, ispravke također; `signedThrough` je najkasniji `throughDate` nekog potpisa (ne jamči da su svi zapisi dodani poslije do tog datuma potpisani), `null` dok potpisa nema.

### `practice.entries.get`

`200 {entries:[{entryId, date, hours, text, correctsEntryId|null, createdAt}], signoffs:[…]}`; zapisi po datumu, zatim `createdAt`, zatim `entryId` (najviše 400); potpisi najnoviji prvi (kao `practice.signoffs.get`, najviše 500). Ispravljeni zapis ostaje na popisu.

### `practice.entries.post`

Tijelo: `{date, hours, text, correctsEntryId?}`.

- `date`: ISO datum, ne u budućnosti i unutar razdoblja prakse. Datum izvan razdoblja je **409 `placement_closed`**; datum u budućnosti je 422 `invalid_input`.
- `hours`: 0,5 do 12 u koracima od 0,5 (zatvoren popis od 24 vrijednosti, broj na žici).
- `text`: 1 do 4000 točaka koda, NFC (provjerava baza), nije prazan, bez kontrolnih znakova osim novog retka i tabulatora, bez znakova za promjenu smjera pisanja.
- `correctsEntryId`: zapis iste prakse; nepostojeći je 422 `invalid_input`.
- Najviše 400 zapisa po praksi: sljedeći je **409 `conflict`**.

Odgovor `201 {entryId}`. Mentor i svi ostali dobivaju 404.

### `practice.signoffs.post`

Tijelo: `{throughDate, comment?}`; `comment` 1 do 1000 točaka koda. Potpis pokriva sve zapise prakse do uključivo `throughDate` koji postoje u trenutku potpisa. `throughDate` ne smije biti u budućnosti ni izvan razdoblja prakse (422 `invalid_input`). Zapis dodan poslije za datum do `throughDate` nije u potpisanom skupu i traži novi potpis; zato `signedThrough` u `practice.placements.get` kaže samo do kojeg je datuma neki potpis izdan, a koji su zapisi potpisani kažu `entryCount` i `entriesSha256` potpisa. Odgovor `201 {signoffId, entryCount, entriesSha256}`: `entriesSha256` je JCS SHA-256 tog skupa zapisa. Bez ijednog zapisa za potpis je **409 `nothing_to_sign`**. Student i svi ostali dobivaju 404.

### `practice.signoffs.get`

`200 {signoffs:[{signoffId, throughDate, entryCount, entriesSha256, comment|null, signedAt, mentor:{id, givenName, familyName}}]}`; najnoviji prvi, zatim `signoffId`; najviše 500.

## Novi kodovi grešaka

| Kod                | Status | Ključ                    | Kada                                   |
| ------------------ | ------ | ------------------------ | -------------------------------------- |
| `placement_closed` | 409    | `errors.placementClosed` | datum zapisa izvan razdoblja prakse    |
| `nothing_to_sign`  | 409    | `errors.nothingToSign`   | do `throughDate` nema zapisa za potpis |

Tekstovi su u `locales/hr.ts` i `locales/en.ts` pod `errors`.

## Što ugovor ne odlučuje

- pravnu snagu potpisa i potrebu za potpisom voditelja prakse u organizaciji (OP-V19-1);
- ocjenu, bodove i bilo kakvu sankciju (ne postoje);
- obavijest o potpisu (vrste obavijesti su zatvorene; nova vrsta lomi ugovor, V19-12);
- tablice, RLS i migracije (`SRV-V19-DNEVNIK-BAZA`, `20261219100000_practice_journal.sql`); rute su `SRV-V19-DNEVNIK-RUTE`.
