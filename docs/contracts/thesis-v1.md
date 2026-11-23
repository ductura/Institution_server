# Obrasci fakulteta, suglasnost mentora i stanje nakon predaje v1

**Status: u pilotu, s dijelovima koji čekaju pravni pregled** (odjeljak 6). SRV-MENTOR-2 `mentorstvo-obrasci-suglasnost`, `Risk: critical`.

Izvori:

- Odluke vlasnika od 23. 11. 2026. za NF-6 (nalog na Ductus#2055, c.7116184562): svih 17 MK u pilotu; (2) obrasci fakulteta i suglasnost mentora za predaju su **unutar Ducture** (MK-12), a „izvornost” je samo naziv službenog obrasca; (4) mentorstvo otvara nastavnik.
- Zadatak MK-12 i MK-14: (a) popis obrazaca fakulteta za završni i diplomski rad s verzijom i stanje svakog obrasca po radu; (b) suglasnost mentora za predaju (tko, kada, neobavezan komentar), student vidi stanje, predaja se ne blokira dok fakultet to ne uključi (postavka fakulteta, zadano isključeno); (c) stanja nakon predaje i obrane.
- Nalaz `ductura/Institution_front_web_chrome` `docs/nalazi/nove-funkcije-6-mentorstvo-konzultacije.md` (MK-n, serverske ovisnosti).
- Migracija `db/main/migrations/20261216120000_thesis_forms_consent.sql`, pgTAP `db/main/tests/234-thesis-forms-consent.sql` i retci u `030-institution-access-matrix.sql`.
- Rute: `server/contracts/routes/thesis.ts` (ugovor 1.98.0), vektori `server/contracts/vectors/{institution.thesis-*,work.thesis-*,work.mentor-consent.*}.json`.

## 1. Što ugovor ne odlučuje

- **Ocjena.** Ništa iz ovog ugovora ne ulazi u ocjenu ni u izvoz ocjene; ocjena ostaje u Merlinu.
- **Autorstvo.** Obrazac „Izjava o izvornosti rada” je samo službeni naziv obrasca fakulteta. Stanje obrasca nije zaključak o autorstvu i ništa se iz njega ne zaključuje automatski.
- **Sadržaj obrasca.** Ductura bilježi samo stanje obrasca (nije predan, predan, prihvaćen), ne datoteku ni tekst obrasca. Prilaganje obrasca kao datoteke nije u ovom ugovoru.
- **Blokada predaje.** Postavka `mentorConsentRequired` je zapis izbora fakulteta. Put predaje je ne čita (odjeljak 6, PR-1).
- **Tekst sučelja.** Ugovor daje zatvorene vrijednosti; tekst ide kroz katalog poruka u WEB-u.

## 2. Zapis

Svi zapisi su samo za dodavanje (okidač odbija `UPDATE`, `DELETE` i `TRUNCATE`), RLS je uključen i prisiljen, a `ductus_app` nema prava na tablice: čita i piše samo kroz RPC-e `app.*` (`SECURITY DEFINER`).

| Tablica                                 | Što drži                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `institution.thesis_form`               | katalog obrazaca ustanove: kod, verzija (1 do 10000), naziv, vrste rada, `active`; najnovija verzija koda je obrazac na snazi |
| `institution.thesis_setting`            | prekidač fakulteta `mentor_consent_required`; najnoviji redak vrijedi, bez retka isključeno                                   |
| `institution.work_thesis_form_event`    | svaka promjena stanja obrasca na radu (tko, u kojoj ulozi, kada, verzija obrasca)                                             |
| `institution.work_mentor_consent_event` | svako davanje i povlačenje suglasnosti (tko, kada, neobavezan komentar do 1000 znakova)                                       |
| `institution.work_thesis_stage_event`   | svaka promjena stanja nakon predaje (stanje, datum obrane, tko, u kojoj ulozi)                                                |

Vrste rada: `bachelor_thesis`, `master_thesis`, `specialist_thesis`, `doctoral_thesis` (iste kao `institution.mentorship.work_type`). Tekst koji upisuje osoba je NFC, bez kontrolnih znakova osim novog retka i tabulatora (u komentaru) i bez znakova za promjenu smjera teksta.

## 3. Tko smije (C-23: iz odnosa)

Rad je rad mentorstva: zadatak rada ima `mentorship_id`. Za sve ostale radove (i za tuđe) odgovor je 404.

| Uloga u radu                                 | Kako nastaje                 | Obrasci rada                                                              | Suglasnost           | Stanje nakon predaje |
| -------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- | -------------------- | -------------------- |
| student                                      | vlasnik rada                 | čita; `not_submitted` ↔ `submitted`, prihvaćeni obrazac ne dira (403/409) | čita                 | čita                 |
| mentor                                       | nastavnik zadatka mentorstva | čita i postavlja svako stanje                                             | čita, daje i povlači | čita i postavlja     |
| fakultet                                     | administrator ustanove rada  | čita i postavlja svako stanje                                             | čita                 | čita i postavlja     |
| ostali (i nastavnik kolegija bez mentorstva) |                              | 404                                                                       | 404                  | 404                  |

Katalog obrazaca čita svatko prijavljen u ustanovi (povučene obrasce samo administrator); objavu i prekidač fakulteta mijenja samo administrator ustanove.

## 4. Rute

Sve rute vraćaju `Cache-Control: no-store`. Greške su zatvorene riječi (`unauthorized`, `forbidden`, `not_found`, `conflict`, `invalid_input`, `unavailable` i greške okvira zahtjeva).

| Operacija                         | Metoda i put                                         | Pristup                   | Odgovor                                    |
| --------------------------------- | ---------------------------------------------------- | ------------------------- | ------------------------------------------ |
| `institution.thesis-forms.get`    | `GET /api/v1/institution/thesis-forms`               | prijavljen                | `{ forms: ThesisForm[] }`                  |
| `institution.thesis-forms.post`   | `POST /api/v1/institution/thesis-forms`              | administrator             | 201 `ThesisForm` (nova verzija)            |
| `institution.thesis-settings.get` | `GET /api/v1/institution/thesis-settings`            | administrator             | `{ mentorConsentRequired, changedAt }`     |
| `institution.thesis-settings.put` | `PUT /api/v1/institution/thesis-settings`            | administrator             | isto; ista vrijednost ne piše ništa        |
| `work.thesis-forms.get`           | `GET /api/v1/works/{documentId}/thesis-forms`        | student, mentor, fakultet | `{ forms: WorkThesisForm[] }`              |
| `work.thesis-form.put`            | `PUT /api/v1/works/{documentId}/thesis-forms/{code}` | student, mentor, fakultet | `WorkThesisForm`                           |
| `work.mentor-consent.get`         | `GET /api/v1/works/{documentId}/mentor-consent`      | student, mentor, fakultet | `MentorConsent`                            |
| `work.mentor-consent.put`         | `PUT /api/v1/works/{documentId}/mentor-consent`      | mentor                    | `MentorConsent`; isto stanje dvaput je 409 |
| `work.thesis-stage.get`           | `GET /api/v1/works/{documentId}/thesis-stage`        | student, mentor, fakultet | `ThesisStage`                              |
| `work.thesis-stage.put`           | `PUT /api/v1/works/{documentId}/thesis-stage`        | mentor, fakultet          | `ThesisStage`; isto stanje ne piše ništa   |

Oblici (točne sheme su u `server/contracts/routes/thesis.ts`):

- `ThesisForm`: `code` (`^[a-z][a-z0-9-]{1,47}$`), `version`, `title`, `workTypes`, `active`, `publishedAt`.
- `WorkThesisForm`: `code`, `version` (na snazi), `title`, `state` (`not_submitted` | `submitted` | `accepted`), `stateFormVersion` (verzija obrasca kad je stanje zadnji put postavljeno; `null` dok nije), `changedAt`, `changedBy`, `changedByPart` (`student` | `mentor` | `faculty` | `null`).
- `MentorConsent`: `state` (`none` | `given` | `withdrawn`), `changedBy`, `changedAt`, `comment`, `requiredForSubmission` (prekidač fakulteta), `history` (svaka promjena redom: `given`, `changedBy`, `changedAt`, `comment`).
- `ThesisStage`: `stage` (`none` | `submitted_to_office` | `defense_scheduled` | `defended`), `defenseAt`, `changedBy`, `changedAt`, `changedByPart` (`mentor` | `faculty` | `null`). `defense_scheduled` traži `defenseAt`; `none` i `submitted_to_office` ga ne primaju; `defended` ga smije zadržati.

`changedBy` je ID računa, ne ime; ime prikazuje klijent iz podataka koje već ima o mentoru i studentu.

## 5. Lažni poslužitelj

`packages/test-fakes/dev-server/thesis-routes.ts` poslužuje svih deset ruta nad izmišljenim podacima: tri obrasca demo-fakulteta („Prijava teme završnog ili diplomskog rada”, „Izjava o izvornosti rada”, „Izjava o pohrani rada u repozitorij”), prekidač isključen. Kao SRV-1520, dev poslužitelj nema mentorstvo rada, pa svaki rad smatra radom vrste demo-mentorstva, a „mentor” je nastavnik koji vidi rad. Stvarni poslužitelj odlučuje kroz mentorstvo.

## 6. Čeka pravni pregled i vlasnika

- **PR-1 Blokada predaje.** Kad fakultet uključi `mentorConsentRequired`, zadatak traži da se predaja bez suglasnosti blokira. Put predaje (`submission.*`, kritični put evidencije) ovaj ugovor ne dira: prekidač je zapisan i vidljiv (`requiredForSubmission`), ali predaju još ne blokira. Uključivanje blokade je zaseban kritični zadatak, nakon pravnog pregleda.
- **PR-2 Uloga fakulteta.** „Ovlašteni nastavnik/fakultet” je ovdje administrator ustanove rada (`institution.actor_has_role('admin')`). Treba li referada ili druga uloga (npr. povjerenstvo za obranu) dobiti isto pravo, odlučuje vlasnik uz pravni pregled.
- **PR-3 Pravni status obrazaca.** Stanje „prihvaćen” u Ducturi nije službeni upis fakulteta u studentsku evidenciju. Treba li fakultet prihvaćanje bilježiti i drugdje, odlučuje pravni pregled.
- **PR-4 Čuvanje.** Zapisi su samo za dodavanje i nemaju rok brisanja; rok čuvanja čeka Q-16 (D-30 PRIJEDLOG).
