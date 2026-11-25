# Timovi na zadatku i doprinos v1

**Status: PRIJEDLOG ugovora (samo ugovor, bez baze i ruta).** SRV-V19-GRUPA-UGOVOR `v19-grupa-ugovor`, `Risk: standard`. Izvor: `docs/nalazi/val19-razlika.md` §5 zadatak 6 (WEB #642), nalog na Ductus#2055 (c.7147669559). Baza dolazi u SRV-V19-GRUPA-BAZA, rukovatelji u SRV-V19-GRUPA-RUTE; do tada rute postoje samo u ugovoru i rade nad lažnim serverom (nisu na popisu `CONTRACT_ONLY`).

Ugovor određuje timove studenata na zadatku (postavka nastavnika, osnivanje, pridruživanje, napuštanje, dodavanje i uklanjanje člana) i prikaz doprinosa iz zabilježenih događaja (Ustav C-6 (a), napomena P-B). Svaki član radi vlastiti dio rada; zajedničkog dokumenta nema (OP-V19-3).

## Što ugovor ne odlučuje

- **Postotak po članu** (OP-V19-2). Do odluke vlasnika `contribution` nosi samo brojeve znakova (točaka koda) po vrsti podrijetla. Ako vlasnik odobri postotak, dodaje se polje `percent` bez promjene poretka.
- **Zajednički dokument**, **ocjena**, **rangiranje**, **automatske sankcije** (nema praga, boje, oznake „visoko” i „nisko”) i **obavijesti** (vrste obavijesti su zatvoren skup).
- **Pravila baze** (RLS): ugovor samo izjavljuje pristup, odlučuje baza.
- **Stvarni studenti.** Sve što dira rad i podrijetlo ide samo u demu s izmišljenim podacima do pravnog mišljenja i DPIA (OP-V19-4).

## Rute

| Id                                        | Metoda i putanja                                                             | Pristup            |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| `institution.assignment-team-setting.put` | `PUT /api/v1/institution/assignments/{assignmentId}/team-setting`            | `course_teacher`   |
| `institution.assignment-team-setting.get` | `GET` isti put                                                               | `course_teacher`   |
| `student.work-team.get`                   | `GET /api/v1/student/assignments/{assignmentId}/team`                        | `student_enrolled` |
| `student.work-team.post`                  | `POST` isti put                                                              | `student_enrolled` |
| `teacher.work-teams.get`                  | `GET /api/v1/teacher/assignments/{assignmentId}/teams`                       | `course_teacher`   |
| `teacher.work-teams.post`                 | `POST` isti put                                                              | `course_teacher`   |
| `teacher.work-team-member.post`           | `POST /api/v1/teacher/assignments/{assignmentId}/teams/{teamId}/members`     | `course_teacher`   |
| `student.work-team-contribution.get`      | `GET /api/v1/student/assignments/{assignmentId}/team/contribution`           | `student_enrolled` |
| `teacher.work-team-contribution.get`      | `GET /api/v1/teacher/assignments/{assignmentId}/teams/{teamId}/contribution` | `course_teacher`   |

### Postavka

`{enabled, minSize (2–6), maxSize (2–6), formation: "student_choice" | "teacher_assigned"}`. Svaki poziv dodaje verziju, vrijedi zadnja. `minSize` ne smije biti veći od `maxSize` (422 `invalid_input`). Postavka koja bi ostavila postojeći tim iznad `maxSize` je 409 `conflict`. Zadatak bez postavke čita se kao `{enabled: false, minSize: 2, maxSize: 6, formation: "student_choice"}`.

### Student

`student.work-team.get` vraća uniju po `state`:

- `disabled`: zadatak nema timove;
- `none`: student nije u timu; nosi `formation` i `openTeams` (`[{teamId, memberCount}]`, samo timovi sa slobodnim mjestom kad studenti sami biraju, inače prazno). **Bez imena**: student vidi imena samo članova vlastitog tima;
- `member`: `team: {teamId, members:[{givenName, familyName}]}`, članovi abecedno po prezimenu pa imenu.

`student.work-team.post` tijelo je `{action: "create"}`, `{action: "join", teamId}` ili `{action: "leave"}`; odgovor je stanje nakon radnje, kao `get`. 409 `conflict`: tim iznad `maxSize`, drugi tim na istom zadatku, `create` ili `join` dok timove oblikuje nastavnik ili su timovi isključeni, `leave` bez tima i `leave` nakon što je student predao svoj dio. `leave` je dopušten uz oba načina oblikovanja (tim koji je složio nastavnik student smije napustiti, a ponovno ga dodaje samo nastavnik). Tuđi, nepoznat i još prazan tim je 404 (student otvoren tim vidi tek kad u njemu netko jest). Tim se nikad ne briše.

### Nastavnik

`teacher.work-teams.get` vraća `{teams:[{teamId, members:[{studentId, givenName, familyName, workState}]}], unassigned:[{studentId, givenName, familyName}]}`. Članovi i nedodijeljeni studenti idu po prezimenu, imenu pa `studentId`; timovi po prvom članu pa `teamId`. `workState` je činjenica: `not_started`, `in_progress` ili `submitted`.

`teacher.work-teams.post` stvara prazan tim (201 `{teamId}`); bez te rute `teacher_assigned` ne bi bio upotrebljiv (vidi Pretpostavke). Uz isključene timove 409 `conflict`. `teacher.work-team-member.post` tijelo `{studentId, action: "add" | "remove"}`, odgovor `{updated: true}`. 409 `conflict`: student je već u timu, tim iznad `maxSize`, timovi isključeni, uklanjanje studenta koji je predao svoj dio. Student koji nije upisan na kolegij, tim drugog zadatka i nepoznat id je 404.

## Doprinos

Isto tijelo za studenta i nastavnika (bajt-jednako, student vidi isto što nastavnik; pravilo 5). Unija po `state`:

- `disabled`, `none` (nema tima), `pending` (dio nekog člana još nije izračunat), `failed` (izračun nije uspio; nikad s razlogom);
- `ready`: `{members:[{givenName, familyName, categories:[{category, codePoints}], totalCodePoints}], notice: "not_authorship_evidence"}`.

`categories` ima točno pet zapisa u stalnom redu iz `provenance-share-v1.md` §1.2: `written`, `ai_transferred`, `pasted`, `imported`, `unattributed`. Članovi su uvijek abecedno, **nikad po iznosu**. Nema polja `share`, ranga, usporedbe, prosjeka, praga ni boje. Napomena je obvezno polje (P-B). Polje ne nosi nijedna druga ruta (popisi, izvoz, paket, obavijesti); to provjerava `server/contracts/work-team.test.ts` nad ugovorom, a nad rukovateljima SRV-V19-GRUPA-RUTE.

## Zajednička pravila ruta

Neispravan id u putanji je 404 (isti kao tuđe i nepoznato, C-23); neispravan id ili vrijednost u tijelu (`studentId`, `teamId`, `action`, veličine) je 422 `invalid_input`. `minSize` veći od `maxSize` shema ne izražava, pa ga provodi rukovatelj kao 422 (vektor `min-above-max`).

401 `unauthorized`, 404 `not_found` (isti za tuđe, nepoznato i neispravno, C-23), 503 `unavailable`; mutacije `MUTATION_GUARD`, 415, 400 `invalid_json`, 422 `invalid_input`. Odgovori nose `cache-control: no-store`. Nema nove vrste obavijesti, nijednog novog koda greške ni izmjene postojećeg ugovora.

## Pretpostavke

1. Dodana je ruta `teacher.work-teams.post` (nije u opisu zadatka): nastavnik mora moći osnovati prazan tim da bi `teacher_assigned` radio; najmanji aditivni ugovor.
2. `student.work-team.get` u stanju `none` nosi `formation` i `openTeams` (id i broj članova, bez imena), jer bez toga student ne bi znao koji `teamId` poslati za `join`. Aditivno; ne otkriva imena tuđih timova.
3. `PUT` postavke vraća postavku na snazi (200), a ne `{updated: true}`, da klijent ne mora ponovno čitati.
4. Ime odgovora `workState` ima zatvoren skup od tri činjenice; ne ulazi u ocjenu.
5. Putanje inventara su `app/api/...` kao u ostalim novim rutama vala 19; izvor `Ductus#2055 c.7147669559`.
6. Pristup: `course_teacher` za nastavnika kolegija (nositelj, suradnik, nastavnik grupe po postojećim pravilima), `student_enrolled` za studenta.
