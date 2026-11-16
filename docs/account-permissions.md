# Vrste računa i tablica prava

Tablica prava v2 kao podatak (S-1J.1-a, DAN-788). Kod je u [`server/roles/permissions.ts`](../server/roles/permissions.ts) i [`server/roles/account-kinds.ts`](../server/roles/account-kinds.ts). Test `server/roles/account-permissions-doc.test.ts` parsira tablicu niže i uspoređuje je s kodom u oba smjera: višak ili manjak retka ili stupca, prazna ćelija, nepoznata vrijednost, svaka razlika u ćeliji te prazan ili uvučen redak između oznaka ruše test. Tko mijenja jedno, mijenja i drugo u istom PR-u.

## Izvori

Jedini izvor su vlasnikove odluke od 14. 11. 2026. u Ductusu (`main` 078c780, #2005):

- [D-297](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/DECISIONS.md): pet vrsta računa i tablica v2 iz priloga §3 ([#1836 c.6870060175](https://github.com/danielrisavi77-create/Ductus/issues/1836#issuecomment-6870060175)), uz izmjenu (1): admin aplikacije ne dodjeljuje uloge student i nastavnik;
- D-298: razine postavki; D-299: brisanje radova; D-301: pravni tekstovi;
- [PRODUCT.md §3](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/PRODUCT.md): uloge i pravilo C-23.

Retke v2 „Ustanove i postavke” i „Brisanje radova” ova tablica rastavlja na radnje po razinama iz D-298 i slučajevima iz D-299 (potvrda ugovora, [#1836 c.6898747289](https://github.com/danielrisavi77-create/Ductus/issues/1836#issuecomment-6898747289), P3).

## Vrste računa

| Kod                 | Vrsta računa                                      | Prijava                                                                         |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `student`           | Student                                           | AAI@EduHr (D-09)                                                                |
| `teacher`           | Nastavnik ili profesor; nastavnik zadatka, mentor | AAI@EduHr (D-16)                                                                |
| `institution_admin` | Administrator ustanove                            | AAI@EduHr (D-16)                                                                |
| `app_admin`         | Administrator aplikacije (razina države)          | zasad se ne gradi (`not_built`); način odlučuje vlasnik, FIDO2 modul je spreman |
| `network_engineer`  | Mrežni inženjer                                   | AAI@EduHr i FIDO2                                                               |

## Opsezi

| Kod                       | Značenje                                                                      |
| ------------------------- | ----------------------------------------------------------------------------- |
| `none`                    | nije dopušteno (— ili ✘ u tablici v2)                                         |
| `own`                     | samo vlastito (svoj rad, svoje postavke, svoj zahtjev)                        |
| `relation`                | samo iz odnosa: svoj kolegij, svoj zadatak, rad kojem je mentor (C-23, D-154) |
| `own_institution`         | samo u svojoj ustanovi                                                        |
| `own_institution_summary` | samo sažeto, u svojoj ustanovi                                                |
| `all`                     | sve ustanove                                                                  |

Opseg je gornja granica. Server uz njega uvijek provjerava odnos ili ustanovu cilja (S-1J.1-b, S-1J-c).

## Vrste računa u bazi

Gdje je koja vrsta u glavnoj bazi (S-1J.1-b, DAN-798; matrica pristupa je `db/main/tests/130-account-kinds.sql`): student u `institution.course_member` (`role = 'student'`), nastavnik i admin ustanove u `institution.institution_role` (`teacher`, `admin`), mrežni inženjer u `identity.network_engineer_appointment`, admin aplikacije u `identity.app_admin`. U `identity.app_admin` nijedna uloga aplikacije ne piše; upisuje ga samo vlasnik izvan aplikacije (V-7). Mrežnog inženjera imenuje i opoziva samo potvrđeni admin svoje ustanove, kroz `identity.appoint_network_engineer` i `identity.revoke_network_engineer`, s retkom u `audit.network_engineer_event` u istoj naredbi (S-1J-c, DAN-809; `db/main/tests/133-network-engineer-appointment.sql`). Drugog admina svoje ustanove imenuje potvrđeni admin te ustanove kroz `institution.admin_appoint_admin`, s retkom u `audit.institution_admin_event` u istoj naredbi (S-1J-c2, DAN-810; `db/main/tests/134-admin-appoints-admin.sql`). Prvog admina nove ustanove i opoziv admina (i zadnjeg) i dalje radi samo operater, na pisani zahtjev (D-262 Q04, D-297; `db/main/tests/106-institution-admin-appointment.sql`).

## Tablica prava

<!-- permissions-table:start -->

| Radnja                                | student | teacher    | institution_admin         | app_admin | network_engineer | Izvor                                          |
| ------------------------------------- | ------- | ---------- | ------------------------- | --------- | ---------------- | ---------------------------------------------- |
| `read_own_work`                       | `own`   | `none`     | `none`                    | `none`    | `none`           | v2 „Vlastiti radovi i predaje”, „Sadržaj”      |
| `read_students_work`                  | `none`  | `relation` | `none`                    | `none`    | `none`           | v2 „Radovi svojih studenata”, „Sadržaj”        |
| `manage_courses_and_members`          | `none`  | `relation` | `own_institution`         | `all`     | `none`           | v2 „Kolegiji i članovi ustanove” (P1)          |
| `assign_student_teacher_roles`        | `none`  | `none`     | `own_institution`         | `none`    | `none`           | v2, D-297 (1)                                  |
| `assign_admin_network_engineer_roles` | `none`  | `none`     | `own_institution`         | `none`    | `none`           | v2, D-297 (2)                                  |
| `change_personal_settings`            | `own`   | `own`      | `own`                     | `own`     | `own`            | D-298 osobne, PRODUCT §3 (P2)                  |
| `change_course_settings`              | `none`  | `relation` | `own_institution`         | `none`    | `none`           | D-298 kolegij                                  |
| `change_institution_settings`         | `none`  | `none`     | `own_institution`         | `none`    | `none`           | D-298 ustanova                                 |
| `change_system_settings`              | `none`  | `none`     | `none`                    | `all`     | `none`           | D-298 sustav                                   |
| `change_network_security_settings`    | `none`  | `none`     | `none`                    | `all`     | `all`            | D-298 mreža i sigurnost                        |
| `view_access_logs`                    | `none`  | `none`     | `own_institution_summary` | `all`     | `all`            | v2 „Zapisi prijava, sesija, prometa i grešaka” |
| `view_system_metrics`                 | `none`  | `none`     | `none`                    | `all`     | `all`            | v2 „Metrika sustava”                           |
| `manage_ip_rules`                     | `none`  | `none`     | `none`                    | `all`     | `all`            | v2 „IP pravila”                                |
| `export_logs`                         | `none`  | `none`     | `none`                    | `all`     | `all`            | v2 „Preuzimanje zapisa (CSV, JSON)”            |
| `backup_and_restore`                  | `none`  | `none`     | `none`                    | `all`     | `all`            | v2 „Backup i vraćanje”                         |
| `edit_general_legal_texts`            | `none`  | `none`     | `none`                    | `all`     | `none`           | D-301, PRODUCT §3                              |
| `edit_institution_legal_addendum`     | `none`  | `none`     | `own_institution`         | `none`    | `none`           | D-301, PRODUCT §3                              |
| `delete_draft`                        | `own`   | `none`     | `none`                    | `none`    | `none`           | D-299 nacrt                                    |
| `request_submitted_work_deletion`     | `own`   | `none`     | `none`                    | `none`    | `none`           | D-299 predani rad                              |
| `approve_submitted_work_deletion`     | `none`  | `none`     | `own_institution`         | `none`    | `none`           | D-299 predani rad                              |
| `request_personal_data_erasure`       | `own`   | `none`     | `none`                    | `none`    | `none`           | D-299 osobni podaci                            |
| `execute_personal_data_erasure`       | `none`  | `none`     | `own_institution`         | `none`    | `none`           | D-299 osobni podaci                            |
| `archive_course`                      | `none`  | `none`     | `own_institution`         | `none`    | `none`           | D-299 brisanje kolegija                        |

<!-- permissions-table:end -->

## Pravila koja testovi drže

- **C-23:** nijedna vrsta računa sama ne dobiva sadržaj rada. Radnje sa sadržajem (`read_own_work`, `read_students_work`) primaju samo `none`, `own` ili `relation`; tip `CellFor` ne dopušta drugo, a test to ponavlja.
- **Brisanje:** `app_admin` i `network_engineer` imaju `none` na svakoj radnji brisanja (D-299).
- **Razred radnje:** svaka radnja je u točno jednom popisu (`CONTENT_ACTIONS`, `DELETION_ACTIONS`, `OTHER_ACTIONS`), a popis svih radnji s razredom je zakucan u testu. Nova radnja zato mijenja i test, pa review vidi njezin razred. Imena su samo mala slova ASCII i podvlaka.
- **Bez praznine:** svaka ćelija ima točno jednu vrijednost iz popisa opsega.

## Izvan tablice

- Hitni pristup admina aplikacije uz pristanak (D-199 t. 3) vrijedi samo pod uvjetima D-288, a ADR (Q-5) nije napisan. Nije dio ovog zadatka i ne gradi se.
- Brisanje lokalne kopije radi klijent i ne dira server.
- Trajno brisanje nakon isteka roka čuvanja radi sustav, ne vrsta računa; čeka D-30 i Q-16.
- Operater Ductusa nije jedna od pet vrsta; je li zaseban račun, ostaje otvoreno (D-305).
- Odnos uloga iz D-204 t. 5 (koordinator, povjerenstvo, komentor) prema vrstama računa nije odlučen.

## Otvorena pitanja

- **P1:** `manage_courses_and_members` × `app_admin` je `all` jer ga tablica v2 tako ima, a D-297 (1) adminu aplikacije oduzima samo dodjelu uloga. PRODUCT §3 mu kolegije i članove ne navodi. Orkestrator je potvrdio `all` (c.6898747289); pitanje ostaje otvoreno dok vlasnik ne odluči.
- **P2:** `change_personal_settings` je `own` za svih pet vrsta prema D-298 („i student”) i PRODUCT §3 („postavke osim osobnih”), koji su kasniji od retka v2 „Ustanove i postavke”.
