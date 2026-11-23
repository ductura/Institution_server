# Otvaranje mentorstva, termini konzultacija i dogovoreni zadaci v1

**Status: PRIMIJENJEN** u SRV-MENTOR-1 `mentorstvo-otvaranje-termini` (`Risk: critical`), API 1.99.0.

Izvori:

- Odluke vlasnika od 23. 11. 2026. za NF-6 (nalog na Ductus#2055, c.7116183714): (1) zapisnik konzultacija piše i dopunjuje samo mentor, student čita; (4) mentorstvo otvara nastavnik, student ne traži mentora nego vidi odluku i mentora; (6) student smije uz zahtjev za termin priložiti pripremu uz napomenu „zapis o unosu, ne o autorstvu”.
- Nalaz `docs/nalazi/nove-funkcije-6-mentorstvo-konzultacije.md` u `ductura/Institution_front_web_chrome` (MK-7, MK-3, MK-10, MK-5 i otvorena pitanja O1, O2, O4).
- Ustav C-23: pristup nastaje samo iz odnosa (student vlasnik rada, nastavnik rada, mentor), nikad iz uloge same.
- Baza: migracija `db/main/migrations/20261215100000_mentorship_opening_consultations.sql`, pgTAP `db/main/tests/233-mentorship-opening-consultations.sql` i retci u `030-institution-access-matrix.sql`.
- Ugovor ruta: `server/contracts/routes/mentorship-consultations.ts`; vektori u `server/contracts/vectors/`.

## Načelo: samo dodavanje

Postojeće rute ostaju kakve jesu, pa nijedan njihov klijent ne dobiva novo polje ni novo stanje:

- `work.consultation-slots.get|post|patch` i dalje znaju samo `requested`, `countered` i `confirmed`. Zatvoren termin (`withdrawn`, `declined`, `cancelled`) stara ruta izostavlja, a ne broji se ni u 20 otvorenih zahtjeva. `patch` na zatvorenom terminu daje 409.
- `notifications.list.get` izostavlja novu vrstu `mentorship_opened`, kao i `returned_for_revision`. Stranica i kursor računaju se preko svih vrsta, pa stranica može biti kraća. Obavijest se označava pročitanom postojećom rutom `notifications.read.post`.
- `mentorship.requests.post` i ostali koraci studentskog zahtjeva ostaju u kodu (odluka 4 ih ne briše).
- `work.consultation-records.post` i `work.consultation-additions.post` zadržavaju ugovor (`owner_or_course_teacher`), ali od ove migracije baza dopušta pisanje samo nastavniku rada (odluka 1). Student dobiva 404, isto kao za tuđi rad. Vidi „Otvoreno za vlasnika”.

## Rute

| Ruta                                       | Metoda i putanja                                                        | Tko                                | Uspjeh                  |
| ------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------- | ----------------------- |
| `mentorship.open.post`                     | `POST /api/v1/mentorships`                                              | potvrđeni nastavnik                | 201 `{ mentorshipId }`  |
| `mentorship.student-mentorships.get`       | `GET /api/v1/student/mentorships`                                       | student                            | 200 `{ mentorships[] }` |
| `notifications.mentorship-opened.list.get` | `GET /api/v1/notifications/mentorship-opened`                           | prijavljeni (vidi samo svoje)      | 200 stranica od 50      |
| `work.consultation-slot-details.get`       | `GET /api/v1/works/{documentId}/consultation-slot-details`              | student vlasnik ili nastavnik rada | 200 `{ slots[] }`       |
| `work.consultation-slot-requests.post`     | `POST /api/v1/works/{documentId}/consultation-slot-requests`            | student vlasnik                    | 201 termin              |
| `work.consultation-slot-close.post`        | `POST /api/v1/works/{documentId}/consultation-slots/{slotId}/close`     | ovisno o radnji                    | 200 termin              |
| `work.consultation-tasks.get`              | `GET /api/v1/works/{documentId}/consultation-tasks`                     | student vlasnik ili nastavnik rada | 200 `{ tasks[] }`       |
| `work.consultation-tasks.post`             | `POST /api/v1/works/{documentId}/consultation-records/{recordId}/tasks` | nastavnik rada                     | 201 zadatak             |
| `work.consultation-task-mark.post`         | `POST /api/v1/works/{documentId}/consultation-tasks/{taskId}/mark`      | nastavnik rada                     | 200 zadatak             |

Odbijanja slijede rute uz koje stoje. Tuđe mentorstvo, tuđi zapisnik i tuđi zadatak čitaju se kao 404, kao i nepostojeći. Termin rada bez odnosa daje 403, kao u `work.consultation-slots.*`. Neispravan ID rada ili termina u putanji je 404. Pogreške nikad ne nose ulaz.

### (a) MK-7: nastavnik otvara mentorstvo

Tijelo `{ studentId, workType, topic? }`. `workType` je jedna od četiri vrste završnih radova, a `topic` ima 1 do 300 znakova i nije prazan. Mentorstvo, njegov zadatak i prva verzija nastaju u istoj transakciji, kao pri odobrenju zahtjeva. Student dobiva jednu obavijest vrste `mentorship_opened`. Otvaranje se ne mijenja ni ne briše (`institution.mentorship_opening`).

- 404: pozivatelj nije potvrđen nastavnik; student ne postoji, iz druge je ustanove, ima potvrđenu ulogu nastavnika ili je sam pozivatelj.
- 409: student već ima otvoreno mentorstvo te vrste.
- 503: fakultet nema pravilo za tu vrstu rada.

`mentorship.student-mentorships.get` vraća studentova otvorena mentorstva, najnovija prva: `assignmentId` (spaja se sa `student.assignments.get`), vrstu, temu otvaranja, mentora i ime mentora (ili `null`) te `openedBy`: `teacher` za otvaranje, `request` za odobren zahtjev. Pozivatelj s potvrđenom ulogom nastavnika dobiva 403.

### (b) MK-3: termin s temom i radnjama zatvaranja

| Radnja     | Tko             | Iz stanja                                            | U stanje    |
| ---------- | --------------- | ---------------------------------------------------- | ----------- |
| `withdraw` | student vlasnik | `requested`                                          | `withdrawn` |
| `decline`  | nastavnik rada  | `requested`                                          | `declined`  |
| `cancel`   | obje strane     | `countered`, `confirmed`, dok je termin u budućnosti | `cancelled` |

Razlog nije obavezan (1 do 600 znakova). Kriva strana dobiva 403, a stanje koje ne dopušta radnju 409. Termin u odgovoru nosi `closing: { by, reason, at }` ili `null` dok je otvoren. Tema zahtjeva ima 1 do 200 znakova.

### (c) MK-10: priprema uz zahtjev

`preparation: { text, changedParagraphs, resolvedComments }`, sva tri polja ili nijedno. Tekst ima do 4000 znakova, a brojke su od 0 do 100 000. Pripremu šalje student, a čitaju je samo student vlasnik i nastavnik rada (kod mentorstva mentor); suradnik na radu i osoba bez odnosa ne vide je. Priprema je **zapis o unosu, ne o autorstvu**: brojke dolaze od studenta, server ih ne računa i iz njih ništa ne zaključuje.

### (d) MK-5: dogovoreni zadaci zapisnika

Zadatke upisuje i označava samo nastavnik rada (mentor), a student ih čita. Zapis najviše ima 20 zadataka (više daje 422), a tekst ima 1 do 500 znakova. Zadatak se ne mijenja ni ne briše. Oznaka „gotovo” ili „nije gotovo” dodaje se kao novi redak, a stanje je zadnja oznaka. Oznaka jednaka trenutačnom stanju ne dodaje ništa. Vremena su zaokružena na cijelu UTC minutu (D-24).

## Pristup i baza

- Nove tablice `institution.mentorship_opening`, `collaboration.consultation_task` i `collaboration.consultation_task_mark` imaju ENABLE i FORCE RLS. Nijedna runtime uloga ih ne čita ni ne piše izravno, a sve ide kroz RPC (`SECURITY DEFINER`, `search_path = ''`), koje smije izvršavati samo `ductus_app`.
- Odnos se uvijek provjerava iz rada ili mentorstva (`collaboration.actor_role`, `institution.require_actor`). Uloga sama ne daje pristup.
- Kodovi baze: ZD401 nema sesije, ZD403 nije dopušteno ili ne postoji, ZD409 stanje ne dopušta, ZD422 neispravan ulaz, ZD503 nema pravila fakulteta.

## Lažni poslužitelj

`packages/test-fakes/dev-server/mentorship-consultation-routes.ts` odgovara na svih devet ruta s izmišljenim podacima i istim odbijanjima. Stari lažni rukovatelji termina izostavljaju zatvorene termine. Zapisnik i dopune piše samo nastavnik.

## Otvoreno za vlasnika

- **Suženje pisanja zapisnika (odluka 1).** Ugovor `work.consultation-records.post` i `work.consultation-additions.post` i dalje deklarira `owner_or_course_teacher`. Ugovor se ne mijenja jer bi provjera `contracts:breaking` to odbila, a baza od 20261215100000 studentu vraća 404. Treba li deklaraciju pristupa promijeniti u novoj glavnoj verziji API-ja?
- **Izbor studenta pri otvaranju.** Nastavnik upisuje `studentId`. Ruta za pretraživanje studenata ustanove nije dio ovog zadatka; klijent ID uzima iz postojećih popisa kolegija.
- **Podsjetnik na termin** (`deadline_reminder`, MK-3) nije dio ovog zadatka.
