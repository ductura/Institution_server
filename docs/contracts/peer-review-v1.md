# Anonimna recenzija među studentima v1

Zadatak: SRV-V19-RECENZIJA-UGOVOR `v19-recenzija-ugovor` (Ductus#2055, nalog c.7149250861; val 19, `docs/nalazi/val19-razlika.md` u WEB repou, §5 zadatak 10, nalazi V19-9 do V19-11). Status: **aditivno, unatrag kompatibilno** (API 1.128.0). Ovo je samo ugovor: baza (`SRV-V19-RECENZIJA-BAZA`, `20261219200000_peer_review.sql`) i rute (`SRV-V19-RECENZIJA-RUTE`) dolaze kasnije, pa rute još nisu montirane. Lažni dev server ih već odgovara izmišljenim podacima.

## Zašto

Komentari i dorada postoje samo između nastavnika i studenta; student čita samo vlastiti rad. Ovdje nastavnik otvara **krug recenzije** uz zadatak: studenti koji su predali rad recenziraju tuđi rad, a ne znaju čiji je, i primaju recenzije svojeg rada, a ne znaju tko ih je napisao. Nastavnik vidi oba kraja.

## Načela

- **Krug** je jedan po zadatku: rok otvaranja i zatvaranja, `reviewsPerStudent` 1 do 3 i 1 do 6 **rubrika** (ključ i jednoredni naziv do 120 točaka koda). Rubrika nije ocjena i nema bodove.
- **Dodjela** je jedna, deterministička (sjeme je `roundId`: isti krug i isti predani radovi daju istu dodjelu), samo među studentima čiji je rad **predan**. Nitko ne recenzira vlastiti rad, nikoja dva studenta ne recenziraju jedno drugo, a svatko recenzira i biva recenziran točno `reviewsPerStudent` puta.
- **Anonimnost je u obliku odgovora, ne u ponašanju poslužitelja.** `student.peer-review-work.get` i `student.peer-reviews-received.get` imaju zatvorene sheme u kojima nema polja osobe, rada, zadatka ni kolegija (`peer-review.test.ts` hoda po shemi i po vektorima). Student u njima vidi samo `taskId` ili `reviewId` onoga na čemu radi.
- **Što recenzent čita nije samo „bez imena”** (pregled #642). Dokument je skup blokova `{kind, text}` i ništa drugo: `kind` je `paragraph`, `heading`, `quote` ili `list_item`; **nema** naslovne stranice, potpisa, atributa, oznaka, identifikatora, autora ni vremena bloka, pa nijedno od toga ne može otkriti autora. Uklanjanje naslovne stranice i potpisa iz predane revizije radi poslužitelj (zahtjev ispod). Tekst koji je autor sam napisao o sebi u tijelu rada pripada autoru i ne traži se.
- **Najmanji broj predanih radova** (pregled #642): bez njega bi uzajamne recenzije otkrile autora (u krugu od dva rada svatko zna čiji je rad čitao). Krug se dodjeljuje tek kad je predanih radova barem `max(5, 2 · reviewsPerStudent + 1)`; inače je **409 `too_few_submissions`** i ništa se ne dodjeljuje. `peer-review.round.get` nastavniku kaže `submittedWorks` i `minSubmissions`, da vidi zašto dodjela ne ide, ne da uspoređuje studente. Funkcija je `peerReviewMinSubmissions` u `server/contracts/routes/peer-review.ts`.
- **Bez ocjene i bez ranga** (V19-11): ništa ne ulazi u ocjenu ni u izvoz ocjene (ocjena ostaje u Merlinu), nema zbroja, prosjeka, poretka po kvaliteti ni sankcije za neodrađenu recenziju. Nema modela ni detektora.
- Recenzija se piše **jednom** i samo se dodaje: student je ne mijenja ni ne briše. Nastavnik je smije **povući** s razlogom; povučena ostaje nastavniku i nestaje iz studentova prikaza.
- **Tuđe, nepoznato i neispravno je isti 404** (C-23): zadatak, krug, recenzija i zadatak recenzije. Autor rada ne dobiva ni zadatak za vlastiti rad.
- Obavijesti nema (OP-V19-7): vrste obavijesti su zatvorene. Samo izmišljeni podaci.

## Rute

Svaka ima 401 `unauthorized`, 404 `not_found`, 503 `unavailable`; mutacije još `MUTATION_GUARD`, a one s tijelom i 415, 400 `invalid_json` i 422 `invalid_input`; odgovori nose `cache-control: no-store`.

| ID rute                              | Metoda i put                                                          | Pristup            | Tko                                |
| ------------------------------------ | --------------------------------------------------------------------- | ------------------ | ---------------------------------- |
| `peer-review.round.put`              | `PUT /api/v1/teacher/assignments/{assignmentId}/peer-review`          | `course_teacher`   | nastavnik zadatka                  |
| `peer-review.round.get`              | `GET` isti put                                                        | `course_teacher`   | nastavnik zadatka                  |
| `peer-review.allocate.post`          | `POST …/peer-review/allocations`                                      | `course_teacher`   | nastavnik zadatka                  |
| `peer-review.teacher-overview.get`   | `GET …/peer-review/overview`                                          | `course_teacher`   | nastavnik zadatka (vidi oba kraja) |
| `peer-review.review-withdrawal.post` | `POST …/peer-review/reviews/{reviewId}/withdrawal`                    | `course_teacher`   | nastavnik zadatka                  |
| `student.peer-review-tasks.get`      | `GET /api/v1/student/assignments/{assignmentId}/peer-review/tasks`    | `student_enrolled` | student kolegija                   |
| `student.peer-review-work.get`       | `GET /api/v1/student/peer-review/tasks/{taskId}/work`                 | `student`          | samo dodijeljeni recenzent         |
| `student.peer-review.post`           | `POST /api/v1/student/peer-review/tasks/{taskId}/review`              | `student`          | samo dodijeljeni recenzent         |
| `student.peer-reviews-received.get`  | `GET /api/v1/student/assignments/{assignmentId}/peer-review/received` | `student_enrolled` | student, samo za vlastiti rad      |

Pristup u ugovoru je deklaracija; odlučuje baza (RLS i RPC, kasniji zadatak).

### Krug (nastavnik)

- `peer-review.round.put`: `{opensAt, dueAt, reviewsPerStudent, rubrics:[{key, label}]}` → `200 {round}`. Trenuci su UTC s milisekundama; `opensAt` mora biti prije `dueAt` i ključevi različiti (inače 422). Ponovno postavljanje zamjenjuje krug samo dok nije dodijeljen; poslije je **409 `already_allocated`**. `key` je kratka riječ malim slovima, brojkama i crticom (do 40 znakova).
- `peer-review.round.get`: `{round|null, state, submittedWorks, minSubmissions}`; `state` je `none`, `not_allocated`, `allocated` (prije `opensAt`), `open` ili `closed` (poslije `dueAt`); `round` nosi i `roundId` i `allocatedAt|null`.
- `peer-review.allocate.post`: bez tijela, `201 {allocated: n}`. **409 `too_few_submissions`** (premalo predanih radova), **409 `already_allocated`**; krug koji ne postoji je 404.
- `peer-review.teacher-overview.get`: `{allocations:[{reviewId|null, reviewer:{id, givenName, familyName}, author:{…}, state}]}`; `state` je `pending`, `submitted` ili `withdrawn`; po prezimenu i imenu recenzenta, pa autora. Nema zbroja po studentu ni poretka po kvaliteti. `reviewId` je potreban za povlačenje i `null` je dok recenzija nije napisana.
- `peer-review.review-withdrawal.post`: `{reason}` (1 do 600 točaka koda) → `201 {reviewId}`. Već povučena recenzija je **409 `conflict`**; recenzija koja još nije napisana je 404. Povlačenje se ne poništava.

### Recenzent i autor (student)

- `student.peer-review-tasks.get`: `{state, tasks:[{taskId, state, dueAt}]}`; `state` je `disabled` (fakultet je isključio), `none` (nema kruga ili student nema dodjelu: rad koji nije predan se ne dodjeljuje), `open` ili `closed`. Zadaci kruga koji se još nije otvorio ne navode se. `state` zadatka je `pending` ili `submitted`.
- `student.peer-review-work.get`: `{rubrics, document:{blocks:[{kind, text}]}}`; samo dok krug traje i samo dodijeljenom recenzentu; prije otvaranja, poslije roka i svima ostalima (autoru također) 404.
- `student.peer-review.post`: `{byRubric:[{key, text}], general?}`; po jedan tekst (1 do 4000 točaka koda) za svaku rubriku kruga, točno tim ključevima, svaki jednom (inače 422); `general` do 4000 točaka koda. `201 {reviewId}`. Poslije roka **409 `closed`**; druga recenzija istog zadatka **409 `already_reviewed`**.
- `student.peer-reviews-received.get`: `{reviews:[{reviewId, byRubric:[{key, label, text}], general|null, submittedAt}]}`; najstarija prva; bez povučenih; bez kruga ili bez recenzija je prazan popis. Naziv rubrike (`label`) nosi odgovor da student ne treba drugi poziv.

## Novi kodovi grešaka

| Kod                   | Status | Ključ                      | Kada                                                         |
| --------------------- | ------ | -------------------------- | ------------------------------------------------------------ |
| `already_allocated`   | 409    | `errors.alreadyAllocated`  | krug je dodijeljen pa se ne mijenja ni ne dodjeljuje ponovno |
| `too_few_submissions` | 409    | `errors.tooFewSubmissions` | predanih radova je manje od najmanjeg broja                  |
| `already_reviewed`    | 409    | `errors.alreadyReviewed`   | recenzija tog zadatka je već napisana                        |
| `closed`              | 409    | `errors.closed`            | rok kruga je istekao                                         |

Tekstovi su u `locales/hr.ts` i `locales/en.ts` pod `errors`.

## Zahtjevi za BAZU i RUTE (testovi koji brane anonimnost)

Ugovor ne može sam spriječiti da poslužitelj u dopuštenom polju napiše identitet; zato sljedeći zadaci moraju dodati ove provjere (nazivi su preporuka):

1. **RECENZIJA-BAZA, pgTAP:** `app.peer_review_work` ne vraća `student_id`, `document_id`, ime ni naslovnu stranicu; red potpisa i naslovne stranice predane revizije ne ulazi u rezultat; atributi i vrijeme bloka ne ulaze; recenzent drugog kruga, autor i student drugog kolegija dobivaju prazan rezultat (404). Uz minimum iz opisa zadatka (samorecenzija nemoguća, dodjela ponovljiva, povučena nestaje iz autorova prikaza).
2. **RECENZIJA-BAZA, pgTAP:** `app.allocate_peer_review` odbija krug s manje od `peerReviewMinSubmissions(reviewsPerStudent)` predanih radova i ne zapisuje ništa; ne dodjeljuje dvama studentima da recenziraju jedno drugo.
3. **RECENZIJA-RUTE, domenski test (`anonymise.ts`):** iz predane revizije koja ima naslovnu stranicu, potpis i metapodatke blokova izlaze samo blokovi `{kind, text}`, a niz kojim se pretražuje cijeli JSON odgovora ne nalazi nijedan identifikator osobe, rada ni zadatka; isti test za `student.peer-reviews-received.get`.
4. **RECENZIJA-RUTE:** `allocate` ne vraća ni jednu parnu uzajamnost i daje isti izlaz za isti ulaz; log ne sadrži tekst recenzije.

## Pretpostavke

- Najmanji broj predanih radova je `max(5, 2k + 1)` (k = `reviewsPerStudent`): 2k + 1 je uvjet da dodjela bez samorecenzije i bez uzajamnosti uopće postoji, a 5 da recenzent ne može autora suziti na troje ili manje. Niži prag je odluka vlasnika (OP-V19-5/6 je ne mijenjaju).
- Zatvoreni skup vrsta bloka (`paragraph`, `heading`, `quote`, `list_item`) je najmanji koji pokriva tekst rada; slike i formule se ne šalju recenzentu u ovom valu.
- `reviewId` u pregledu nastavnika i `label` uz rubriku u primljenim recenzijama su polja koja dokument iz zadatka ne navodi, a bez njih povlačenje i prikaz ne rade.
- Bez postotka po članu i bez ikakvog zbroja (OP-V19-1/2 se ne odlučuju ovdje).

- **Ime polja je `rubrics`, ne `criteria`** (i `byRubric`, ne `byCriterion`) kako ga navodi dokument zadatka. Postojeći test `teacher-working-criteria.integration.test.ts` zabranjuje riječ „criteri” u svakom ugovoru koji nije nastavnički (radni kriteriji nastavnika ostaju privatni), a ovi odgovori idu i studentu. WEB koristi ova imena; u sučelju ostaje „rubrika”.

## Otvoreno

- **Nastavnik ne može pročitati tekst recenzije**: prema opisu zadatka 14 nastavnik čita recenziju prije povlačenja, a nijedna od ovih ruta ne vraća tekst (pregled bi bio prevelik: do 3000 recenzija). Potrebna je deseta ruta `GET …/peer-review/reviews/{reviewId}`; izvan je ovog zadatka i ide kao zaseban zadatak orkestratora.
- Pravno mišljenje i DPIA prije čitanja tuđeg rada sa stvarnim studentima (OP-V19-5); do tada samo demo s izmišljenim podacima. Tko vidi recenzenta (OP-V19-6): pretpostavka je nastavnik, ne studenti.
- Obavijest o recenziji nije u valu (OP-V19-7).
