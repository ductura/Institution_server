# Praćenje mentorskog rada v1: poruka sebi, „student je vidio” i „Moji studenti”

**Status: ugovor zadatka SRV-MENTOR-3** (`mentorstvo-poruka-sebi-pregled`, `Risk: critical`). Izvor je nalog orkestratora na Ductus#2055 (c.7116185492) s odlukama vlasnika od 23. 11. 2026. za NF-6 (MK-8, MK-9, MK-11) i NF-5 PG-9. Ugovor je aditivan: ne mijenja nijednu postojeću rutu ni polje. API 1.105.0.

Kod:

- migracija `db/main/migrations/20261217100000_mentorship_self_note_overview.sql`;
- pgTAP `db/main/tests/237-mentorship-self-note-overview.sql` (matrica pristupa tih tablica i RPC-ova, po uzoru na `164-work-message-access.sql`);
- rute `server/contracts/routes/mentorship-follow.ts`, vektori `server/contracts/vectors/work.self-note.*`, `work.reading-place.*`, `work.seen*`, `mentorship.overview.get.json`;
- priključak baze `server/database/mentorship-follow/`, HTTP rub `server/http/mentorship-follow/`;
- lažni dev server `packages/test-fakes/dev-server/mentorship-follow-routes.ts` (samo izmišljeni podaci).

Ništa od ovoga ne piše dokument, reviziju, segment, potvrdu ni sažetak, pa ništa ne ulazi u lanac evidencije rada (kao komentar ili poruka). Identitet, uloga i ustanova nikad nisu u zahtjevu: RPC-ovi ih uzimaju iz sesije. Pristup nastaje samo iz odnosa (Ustav C-23), a odluka pada pri svakom pozivu.

## 1. Poruka sebi i „Dokle sam stao” (MK-9)

Student uz svoj rad drži jednu bilješku sebi (do 280 znakova, po želji s položajem u radu) i položaj čitanja. Oboje je na poslužitelju, po studentu i radu, pa radi i na drugom računalu.

> **Od API 1.110.0 (SRV-NF6-SIFRA, odluka vlasnika B2 od 24. 11. 2026.)** bilješka se šifrira na uređaju i ide kroz `work.sealed-self-note.*` i `profile.self-note-key.*` (`docs/contracts/self-note-sealed-v1.md`). Rute u ovom odjeljku ne čuvaju tekst: `note` je uvijek `null`, `PUT .../self-note` tekst ne sprema, a `DELETE .../self-note` briše šifriranu bilješku. Položaj čitanja radi kako je opisano niže.

| Ruta                                              | Operacija                   | Tijelo                      | Odgovor 200     |
| ------------------------------------------------- | --------------------------- | --------------------------- | --------------- |
| `GET /api/v1/works/{documentId}/self-note`        | `work.self-note.get`        | —                           | `SelfNoteState` |
| `PUT /api/v1/works/{documentId}/self-note`        | `work.self-note.put`        | `{text, place?}` (do 4 KiB) | `SelfNoteState` |
| `DELETE /api/v1/works/{documentId}/self-note`     | `work.self-note.delete`     | prazno                      | `SelfNoteState` |
| `PUT /api/v1/works/{documentId}/reading-place`    | `work.reading-place.put`    | `{place}` (do 1 KiB)        | `SelfNoteState` |
| `DELETE /api/v1/works/{documentId}/reading-place` | `work.reading-place.delete` | prazno                      | `SelfNoteState` |

- `SelfNoteState = {note: {text, place | null, updatedAt} | null, readingPlace: {place, updatedAt} | null}`.
- `place = {nodeId, offset}`: `nodeId` je UUID čvora dokumenta (kao `nodeId` sidra komentara), `offset` cijeli broj 0 do 1 000 000. Položaj nikad ne nosi citat ni drugi tekst rada; ključ viška je 422.
- `text`: 1 do 280 znakova s barem jednim znakom koji nije razmak, NFC, bez kontrolnih znakova osim novog retka i tabulatora, bez znakova smjera (bidi). Inače 422 i ništa se ne piše.
- **Tko smije:** samo student vlasnik rada. Mentoru, nastavnicima zadatka, administratoru i svakome drugome rad je 404 (isti odgovor kao za nepostojeći ili neispravan rad). Nema rute kojom bi nastavnik ili fakultet čitao bilješku.
- Brisanje bilješke ostavlja položaj čitanja i obrnuto; brisanje onoga čega nema ne mijenja ništa. Redak bez ičega se briše, ne čuva.

### Zadržavanje

- Student briše bilješku i položaj čitanja u svakom trenutku (`DELETE` gore); brisanje je stvarno, redak nestaje.
- **Rok (prijedlog, čeka potvrdu vlasnika u pravilima zadržavanja):** bilješka i položaj čitanja brišu se **zajedno s radom**: kad se rad briše po pravilu zadržavanja ili na zahtjev studenta (D-12), u istoj transakciji uloga `ductus_retention` poziva `collaboration.delete_work_self_notes(document_id, institution_id)`. Dulje od rada se ne čuvaju; kraće ih čuva samo student svojim brisanjem.
- Oznake „viđeno” (odjeljak 2) brišu se na isti način, `collaboration.delete_work_items_seen`.
- Poziv tih funkcija iz posla zadržavanja nije dio ovog zadatka (kao ni `delete_work_messages`); otvorena stavka u PR-u.

## 2. „Student je vidio” (MK-11)

| Ruta                                             | Operacija                  | Tijelo / odgovor                                                          |
| ------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------- |
| `POST /api/v1/works/{documentId}/seen`           | `work.seen.post`           | `{items: [{kind, id}]}` (1 do 200) → `{items: [{kind, id, firstSeenAt}]}` |
| `GET /api/v1/works/{documentId}/seen-by-student` | `work.seen-by-student.get` | → `{items: [{kind, id, firstSeenAt}]}` (najviše 5000)                     |

- `kind` je zatvoren skup: `comment` (samo objavljen komentar), `revision_request` (zahtjev za doradu uz sidro), `milestone_revision` (dorada etape), `message` (kratka poruka uz rad).
- Čitatelj rada (student rada i nastavnici zadatka) javlja što je otvorio. Pamti se **prvi** trenutak; kasnija prijava ne mijenja ništa. Stavka koja nije na radu, koju pozivatelj ne smije vidjeti (npr. nacrt komentara) ili koju je sam napisao preskače se bez greške.
- Autor stavke čita kad je **student rada** prvi put otvorio njegove stavke. Student čita praznu listu; tuđe oznake nitko ne čita.
- Oznaka je samo vrijeme otvaranja. Ne mjeri trajanje, ne broji ponovna otvaranja i nije zaključak o autorstvu ni o radu.

## 3. „Moji studenti” za mentora (MK-8, NF-5 PG-9)

`GET /api/v1/teacher/mentorship-overview` (`mentorship.overview.get`) → `{students: [...]}`, jednim čitanjem sva otvorena mentorstva pozivatelja, najnovije prvo (isti red kao `teacher.mentorships.get`). **Bez rangiranja, bodova i usporedbe studenata.**

Po mentorstvu: `mentorshipId`, `assignmentId`, `documentId` (null dok student ne otvori rad), `givenName`, `familyName`, `workType`, `title`, i:

- `stage`: prva etapa po redu tijeka koja nije odobrena (`{milestoneId, title, position, state}`, `state` ∈ `not_submitted`, `submitted`, `revision_requested`), null kad nijedna nije preostala; `stageCount` je broj etapa;
- `waitingOn`: `mentor` kad je etapa predana ili postoji studentova poruka koju mentor nije otvorio; `student` kad rad nije otvoren ili etapa nije predana ili je na doradi; inače `none`;
- `nextDeadlineAt`: najraniji rok neodobrenih etapa (rok dorade ima prednost pred rokom etape), i prošli; `daysToNextDeadline` u kalendarskim danima po Europe/Zagreb, negativan kad je rok prošao;
- `newMessages`: broj studentovih poruka koje mentor nije otvorio (iz oznaka odjeljka 2).

Pozivatelj koji nikoga ne mentorira dobiva praznu listu. Mentorstvo s potvrđenom ulogom nastavnika i bez `ended_at`; ostalo se ne vidi.

## 4. Greške

401 bez sesije; 404 za rad bez odnosa, tuđi, nepostojeći ili neispravan; 422 za neispravan unos (ništa se ne piše); 415, 400 i greške čuvara mutacije (`MUTATION_GUARD`) za pisanja; 503 kad baza nije dostupna ili je redak neočekivanog oblika. Tijelo greške je zatvoreno i nikad ne nosi unos ni poruku baze.

## 5. Što ugovor ne odlučuje

- Tekst sučelja (nazivi „Poruka sebi”, „Dokle sam stao”, „Moji studenti”, značka „novo”) ide kroz katalog poruka u WEB repou.
- Zapisnik konzultacija, obrasci i suglasnost, otvaranje mentorstva (SRV-MENTOR-1 i SRV-MENTOR-2).
- Pokretanje brisanja iz posla zadržavanja (odjeljak 1, „Zadržavanje”).
