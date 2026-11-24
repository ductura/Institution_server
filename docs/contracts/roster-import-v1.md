# Ugovor uvoza popisa studenata (roster-import-v1)

Zadatak: SRV-ADMIN-2 `admin-uvoz-popisa` (Ductus#2055, nalog c.7116133893). Odluka vlasnika 23. 11. 2026., NF-7 točka 3 (OA-10): uvoz popisa studenata iz Merlina ili ISVU-a u pilotu, uz pregled prije potvrde; upis kodom ostaje druga mogućnost.

Status: **PRIJEDLOG formata datoteke, čeka primjer stvarnog izvoza.** Rute, ovlasti i ponašanje u dva koraka grade se sada; format CSV-a mijenja se kad vlasnik dostavi primjer izvoza iz Merlina i ISVU-a.

## 1. Što radi

Administrator fakulteta učitava popis studenata kolegija u dva koraka:

1. **Pregled** (`institution.roster-imports.post`): poslužitelj čita datoteku i za svaki redak kaže je li student novi, već upisan ili neodgovarajući (s razlogom). Nitko se ne upisuje.
2. **Potvrda** (`institution.roster-import-confirm.post`): upisuju se točno novi retci pregleda. Ponovljena potvrda vraća prvi rezultat i nikoga ne upisuje dvaput.

Upis kodom (`institution.enrollments.post`, `student.enrollments.post`) ostaje nepromijenjen.

## 2. Rute

| Operacija                                | Metoda i putanja                                                   | Tijelo                   |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| `institution.roster-imports.post`        | `POST /api/v1/institution/admin/courses/{courseId}/roster-imports` | `{source, csv}`, 256 KiB |
| `institution.roster-import-confirm.post` | `POST /api/v1/institution/admin/roster-imports/{importId}/confirm` | `{}`                     |

Obje su `access: institution_admin`. API 1.103.0. Sheme su u `server/contracts/routes/roster-import.ts`, vektori u `server/contracts/vectors/institution.roster-import*.json`.

### Odgovor pregleda

```json
{
  "importId": "…",
  "source": "merlin",
  "expiresAt": "2026-11-23T10:30:00.000Z",
  "counts": { "new": 1, "alreadyEnrolled": 1, "unsuitable": 3 },
  "rows": [
    {
      "line": 2,
      "identifier": "ana.izmisljena@fakultet.invalid",
      "givenName": "Ana",
      "familyName": "Izmišljena",
      "status": "new",
      "reason": null
    }
  ]
}
```

`status` je `new`, `already_enrolled` ili `unsuitable`. Razlog (`reason`) postoji samo uz `unsuitable`:

| Razlog               | Tko odlučuje | Značenje                                                                 |
| -------------------- | ------------ | ------------------------------------------------------------------------ |
| `invalid_identifier` | čitač        | identifikator nije oblika `korisnik@domena`                              |
| `missing_name`       | čitač        | ime ili prezime nedostaje ili nije običan tekst                          |
| `duplicate`          | čitač        | isti identifikator već je u ranijem retku                                |
| `unknown_account`    | baza         | fakultet nema račun s tim identifikatorom (student se još nije prijavio) |
| `ineligible_account` | baza         | račun koji se uvozom ne upisuje; upisuje se samo kodom                   |
| `name_mismatch`      | baza         | poznato ime računa razlikuje se od imena u datoteci                      |
| `removed`            | baza         | nastavnik je studenta uklonio iz kolegija i nije dopustio povratak       |
| `course_teacher`     | baza         | osoba je nastavnik tog kolegija                                          |

Pregled vrijedi 30 minuta (`expiresAt`).

### Odgovor potvrde

`{enrolled, alreadyEnrolled, skipped, alreadyConfirmed}`. Student koji je u međuvremenu upisan broji se u `alreadyEnrolled`, a onaj kojeg je nastavnik u međuvremenu uklonio ili koji se uvozom više ne upisuje u `skipped`.

### Greške

| Status | Kod                      | Kada                                                           |
| ------ | ------------------------ | -------------------------------------------------------------- |
| 401    | `unauthorized`           | bez sesije                                                     |
| 403    | `forbidden`              | pozivatelj nije administrator fakulteta                        |
| 404    | `not_found`              | kolegij ili uvoz nije s fakulteta pozivatelja (ili ne postoji) |
| 410    | `import_expired`         | potvrda nakon isteka pregleda                                  |
| 422    | `invalid_input`          | tijelo nije točno `{source, csv}` ili `{}`, put nije UUID      |
| 422    | `roster_columns_missing` | zaglavlje nema stupce identifikator, ime i prezime             |
| 422    | `roster_too_many_rows`   | više od 1000 redaka nakon zaglavlja                            |
| 422    | `roster_malformed`       | navodnik je ostao otvoren                                      |

Uz to vrijede zajedničke greške zaštite mutacija (porijeklo, okvir tijela, vrsta sadržaja, JSON) i 503 `unavailable`.

## 3. Format datoteke (prijedlog)

Čeka primjer stvarnog izvoza iz Merlina i ISVU-a. Do tada oba izvora (`merlin`, `isvu`) imaju isti format:

- UTF-8; oznaka redoslijeda bajtova (BOM) na početku se odbacuje;
- RFC 4180: ćelija u dvostrukim navodnicima smije sadržavati razdjelnik, prijelom retka i udvostručeni navodnik; CRLF, LF i CR završavaju redak;
- razdjelnik je točka-zarez ili zarez, onaj koji se u prvom retku pojavi prvi izvan navodnika (točka-zarez ako nema nijednog);
- prvi neprazni redak je zaglavlje; stupci `identifikator` (AAI@EduHr identifikator, hrEduPersonUniqueID), `ime` i `prezime`, bilo kojim slovima i redom; ostali stupci se zanemaruju; prazni retci se preskaču;
- najviše 200 000 znakova (UTF-16) i 1000 redaka nakon zaglavlja.

Identifikator se uspoređuje malim slovima: ispisivi ASCII bez razmaka i `@`, zatim `@` i domena od malih slova, znamenki, točke i crtice. Ime i prezime uspoređuju se malim slovima, bez razmaka na rubovima i sa skupljenim razmacima. Primjer (izmišljeni podaci):

```text
identifikator;ime;prezime;grupa
ana.izmisljena@fakultet.invalid;Ana;Izmišljena;A
marko.izmisljeni@fakultet.invalid;Marko;Izmišljeni;B
```

## 4. Baza

Migracija `20261215120000_roster_import.sql`:

- `institution.roster_import`: kolegij, izvor, tko i kada je napravio pregled, istek, broj redaka i novih, te potvrda (tko, kada, brojevi). Mijenja se samo potvrdom; brisanje i TRUNCATE odbija okidač.
- `institution.roster_import_entry`: računi koje bi pregled upisao. Nepromjenjivo.
- Ne čuva se datoteka, identifikator ni ime iz retka.
- RPC-ovi `institution.preview_roster_import(uuid, text, jsonb)` i `institution.confirm_roster_import(uuid)` (SECURITY DEFINER, `ductus_app` ih smije izvršiti). Obje tablice imaju prisilni RLS samo s politikom vlasnika; aplikacija ih ne čita izravno.
- Pristup: samo potvrđeni, neopozvani administrator fakulteta kolegija; redak uloge drži se `FOR SHARE` do kraja transakcije, pa opoziv čeka. Uloga se ne može sama sebi dodijeliti (administratore imenuje operater ili drugi administrator). Administrator ne postaje član kolegija i ne čita njegov sadržaj (C-23).
- Upis radi kao upis kodom: ista zaključavanja po studentu (`institution.enroll_with_code:<id>`), mjesta u seminarskim grupama drže se `FOR SHARE`, a uklonjeni student bez dopuštenja povratka ne upisuje se.
- pgTAP: `db/main/tests/235-roster-import.sql` (ćelije po ulozi, ulaz, pregled, potvrda, idempotentnost, uklonjeni, istek, nepromjenjivost) i retci u `030-institution-access-matrix.sql`.

## 5. Otvoreno

- **Format datoteke** čeka primjer stvarnog izvoza iz Merlina i ISVU-a (vlasnik).
- **Student bez računa** (`unknown_account`): račun nastaje tek prvom prijavom kroz AAI@EduHr. Predupis (čuvanje identifikatora osobe koja još nije korisnik) nije građen jer je to odluka o osobnim podacima (vlasnik, DPIA).
- **Rokovi čuvanja** uvoza: čeka odluku (NF-7 točka 5); ništa ga još ne briše.
- **Dnevnik radnji administratora** (SRV-ADMIN-1, OA-3, `app.admin_action_log`) je na bazi, ali uvoz popisa još nije među vrstama radnji koje čita; do tada je zapis uvoza (tko, kada, kolegij, brojevi) jedini trag. Dodavanje vrste radnje za potvrđeni uvoz je zaseban zadatak.
- **Nositelj kolegija** ne može uvoziti: ugovor ne daje nastavniku izravan upis studenata, samo kod za upis.
