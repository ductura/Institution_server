# Operater i administracija u pilotu v1: prijave problema, dnevnik radnji i uloga mrežnog inženjera

SRV-ADMIN-1 `admin-dnevnik-prijave`, `Risk: critical`. Serverski dio prijedloga OA-7, OA-3 i OA-1 iz nalaza NF-7 (WEB repo, `docs/nalazi/nove-funkcije-7-operater-administracija.md`), po vlasnikovim odlukama od 23. 11. 2026. (nalog orkestratora, Ductus#2055 c.7116133441):

- **(1)** operater u pilotu dobiva zaslon u aplikaciji; uloga `network_engineer` više ne završava na „Račun bez uloge” (OA-1);
- **(4)** dnevnik radnji administratora i operatera u pilotu, samo za čitanje, bez osobnih podataka studenata (OA-3);
- **(8)** popis prijava problema u pilotu; prijavu rješava onaj kome pripada po vrsti: tehnički problem operater, pitanje o kolegiju ili zadatku nastavnik, račun i uloge administrator fakulteta; stanje „zaprimljeno” ili „riješeno” (OA-7).

Ugovor je aditivan i unatrag kompatibilan: postojeće rute i odgovori se ne mijenjaju, a jedina promjena postojeće rute je novo neobavezno polje `courseId` u zatvorenom tijelu `support.problem-reports.post` (dopuštena promjena po `server/contracts/breaking.ts`). Verzija API-ja je 1.98.0.

## 1. Prijave problema po primatelju (OA-7)

### 1.1 Kome prijava stiže

Kategoriju bira pošiljatelj pri slanju (postojeće rute `support.problem-report.post` i `support.problem-reports.post`). Baza (`identity.routed_problem_reports`, migracija `20261215100000_problem_report_routing.sql`) određuje kome prijava stiže:

| Kategorija                     | Stiže                                                                | `routedTo`          |
| ------------------------------ | -------------------------------------------------------------------- | ------------------- |
| `technical`                    | mrežnom inženjeru (operateru) iste ustanove s aktivnim imenovanjem   | `network_engineer`  |
| `account`                      | potvrđenom administratoru iste ustanove                              | `institution_admin` |
| `course` s navedenim kolegijem | nastavničkom timu tog kolegija (`institution.is_course_team_member`) | `course_teacher`    |
| `course` bez kolegija          | potvrđenom administratoru iste ustanove                              | `institution_admin` |

Pristup nastaje iz odnosa (C-23): nastavnik vidi samo prijave o kolegiju čijem timu pripada, a ne sve prijave kategorije `course`. Uloga koju nitko nije potvrdio, opozvana uloga i opozvano imenovanje ne daju ništa. Račun koji nije ni administrator, ni mrežni inženjer, ni potvrđeni nastavnik ustanove dobiva 403; ostali dobivaju svoj popis, i kad je prazan.

### 1.2 Što čitatelj vidi

Samo ono što je pošiljatelj upisao (`description`) i zatvoreni tehnički kontekst prijave (`route`, `appVersion`, `browser`, `syncState`), kategoriju, vrijeme, `courseId` za prijavu o kolegiju i stanje. Nijedno polje ne imenuje pošiljatelja; tablica i dalje nikome osim pošiljatelju ne daje redak izravno (`problem_report_own_read`).

### 1.3 Stanje

Prijava je `received` („zaprimljeno”) dok je netko kome stiže ne označi `resolved` („riješeno”); može se vratiti na `received`. Svaka promjena je redak u `identity.problem_report_status_event` koji se samo dopisuje (okidači `audit.reject_change` odbijaju izmjenu, brisanje i pražnjenje i vlasniku). Čitatelj vidi vrijeme zadnje promjene, ulogu onoga tko ju je napravio (`statusChangedByRole`) i je li to bio on sam (`statusChangedByMe`), nikad ime.

### 1.4 Rute

| Operacija                            | Metoda i putanja                                  | Pristup     | Odgovor                                                 |
| ------------------------------------ | ------------------------------------------------- | ----------- | ------------------------------------------------------- |
| `support.problem-reports.get`        | `GET /api/v1/problem-reports`                     | `signed_in` | `{ reports: RoutedProblemReport[], truncated }`, do 500 |
| `support.problem-report-status.post` | `POST /api/v1/problem-reports/{reference}/status` | `signed_in` | `{ reference, status, statusChangedAt }`                |
| `support.problem-reports.post`       | `POST /api/v1/problem-reports` (postoji)          | `signed_in` | novo neobavezno polje `courseId`                        |

`support.problem-report-status.post` prima točno `{status}`, najviše 256 bajtova. Isto stanje ponovno ne zapisuje ništa i vraća vrijeme postojećeg stanja (`null` ako se nikad nije mijenjalo). Prijava koja pozivatelju ne stiže (druga vrsta, drugi kolegij, druga ustanova, nepostojeća) je 404; neispravna oznaka ili stanje 422; račun bez položaja čitatelja 403.

`courseId` u `support.problem-reports.post` smije stajati samo uz `category: "course"` i samo za kolegij pošiljatelja (upisani student ili član tima); inače 422, a odgovor ne otkriva postoji li kolegij.

## 2. Dnevnik radnji administratora i operatera (OA-3)

`GET /api/v1/institution/admin-actions` (`institution.admin-actions.get`, pristup `institution_admin`) daje potvrđenom administratoru ustanove do 500 unosa, najnovije prve (`truncated` kaže da ih ima još). Drugi dobivaju 403.

Unos: `at`, `actorRole` (`institution_admin`, `registry_clerk`, `operator`), `action`, `subjectRole` (samo za radnju nad ulogom: `teacher`, `institution_admin`, `network_engineer`, `registry_clerk`) i `outcome`. Nema osobe, studenta, rada, slučaja, zahtjeva ni slobodnog teksta (tablica prava: `view_access_logs` za administratora je `own_institution_summary`).

| `action`                              | Izvor (svi se samo dopisuju ili idu samo naprijed)                                                                                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role_confirmed`, `role_revoked`      | `audit.teacher_role_event`, `audit.network_engineer_event`, administratorski retci `institution.institution_role` (imenovanje administratorom kad ga `audit.institution_admin_event` bilježi, inače operater; opoziv samo operater), `app.registry_clerk` (operater na pisani zahtjev) |
| `rule_published`                      | `audit.faculty_rule_event`                                                                                                                                                                                                                                                             |
| `threshold_changed`                   | `audit.origin_threshold_event` (postavljen ili uklonjen)                                                                                                                                                                                                                               |
| `hold_placed`, `hold_released`        | `evidence.legal_hold` kroz privatnu `app.legal_hold_trail()` (skida drugi administrator ili operater na zahtjev)                                                                                                                                                                       |
| `export_requested`, `export_approved` | `app.student_data_export` (traži referent, odobrava administrator)                                                                                                                                                                                                                     |

Dnevnik nije nova pohrana: čita tragove koje radnje već ostavljaju, pa se unos ne može izmijeniti ni obrisati kroz njega, a vidljive su i radnje od prije ove migracije. Bilježi se samo radnja koja je stupila na snagu, pa je `outcome` uvijek `completed`; odbijeni pokušaj se poništava i ne ostavlja redak (operaterska putanja ima vlastiti zapis odbijanja).

## 3. Uloga `network_engineer` (OA-1)

Što mrežni inženjer smije na poslužitelju, prema tablici prava v2 (`docs/account-permissions.md`) i ovom zadatku:

| Što                                      | Kako                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| uloga u sesiji                           | `profile.me.get` vraća `network_engineer` za aktivno imenovanje (postojeće); WEB prema tome otvara zaslon operatera                |
| mjerila pilota                           | `ops.pilot-metrics.get`: operaterska putanja, korak 8 pušta samo račun s popisa operatera s potvrđenim drugim faktorom (postojeće) |
| stanje sustava                           | `platform.status.get`: javno (postojeće)                                                                                           |
| tehničke prijave problema svoje ustanove | `support.problem-reports.get` i `support.problem-report-status.post` (novo, odjeljak 1)                                            |
| radovi, sadržaj, identiteti studenata    | ništa: nema ćeliju ni RPC (C-23; tablica prava `read_students_work` = `none`); prijava ne nosi pošiljatelja                        |
| dnevnik radnji administratora            | ne (403); čita ga samo potvrđeni administrator                                                                                     |

Ulogu ne može sam sebi dodijeliti: imenuje je i opoziva samo potvrđeni administrator iste ustanove (`identity.appoint_network_engineer`, `db/main/tests/133-network-engineer-appointment.sql`). pgTAP `232-problem-report-routing.sql` provjerava i da opozvani mrežni inženjer više ne čita prijave.

## 4. Testovi

- pgTAP: `db/main/tests/232-problem-report-routing.sql` (usmjeravanje, stanje, trag koji se samo dopisuje, 403/404/422/401), `233-admin-action-log.sql` (izvori, uloge, bez identifikatora i teksta, druga ustanova), retci u `030-institution-access-matrix.sql`; katalog u `122` i `130` prati nove funkcije.
- Vektori: `support.problem-reports.get`, `support.problem-report-status.post`, `institution.admin-actions.get`, dva nova u `support.problem-reports.post`.
- Integracija nad bazom: `server/http/problem-report-inbox/problem-report-inbox.pg.integration.test.ts`; stari kolačić nakon odjave: `tests/db/logout-old-cookie.integration.test.ts`.
- Lažni poslužitelj: `packages/test-fakes/dev-server/support-inbox-routes.ts` (izmišljene prijave i dnevnik; administrator zamjenjuje operatera jer lažni poslužitelj nema račun mrežnog inženjera).

## 5. Otvoreno

- Student ne vidi stanje svoje prijave (O-8); ovaj zadatak to ne traži.
- Ruta za tehničke prijave ne prolazi korak 8 (drugi faktor) jer nije pod `/api/v1/ops`; mrežni inženjer je čita sesijom AAI@EduHr. Treba li i ovdje drugi faktor, odlučuje vlasnik.
- `app.pilot_metrics()` u bazi pušta svaku živu sesiju i oslanja se na korak 8; uže vezanje na imenovanje mrežnog inženjera bi isključilo operatera koji nije mrežni inženjer ustanove, pa je ostavljeno vlasniku.
- Rokovi čuvanja traga stanja prijava i dnevnika: **čeka odluku** (odluka 5 od 23. 11.; tko određuje rokove još nije odlučeno).
