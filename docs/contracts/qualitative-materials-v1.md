# Gradivo za kvalitativno kodiranje v1

Zadatak: SRV-V18-KODIRANJE-GRADIVO `srv-v18-kodiranje-gradivo` (Ductus#2058, nalog c.7173076650; val 18, WEB `docs/nalazi/val18-razlika.md` §5 t. 6, nalazi V18-3, V18-7 i V18-9). Status: **aditivno, unatrag kompatibilno** (API 1.143.0). Ovisi o SRV-V18-KODIRANJE-BAZA (migracija `20261219390000_qualitative_coding.sql`; RPC-ovi `app.create_qual_material`, `app.qual_materials`, `app.qual_material`, `app.delete_qual_material`). Nova migracija nije potrebna.

## Zašto

Student kodira vlastito gradivo: tekst intervjua ili bilješku koju je upisao ili zalijepio. Postojeće bilješke (`work.source-notes.*`, `mentorship.notes.*`) vezane su uz izvor ili mentorstvo i imaju gornju granicu od nekoliko tisuća znakova, pa nisu gradivo za kodiranje. Ovaj ugovor daje samo gradivo; šifrarnik (SRV-V18-KODIRANJE-SIFRARNIK) i označene odlomke s izvozom (SRV-V18-KODIRANJE-OZNAKE) donose zasebni zadaci.

## Načela

- **Privatno vlasniku (V18-9, C-23).** Pristup nastaje iz odnosa „vlasnik”, ne iz uloge. Tuđe gradivo, nepoznat i neispravan identifikator (i identifikator velikim slovima) isti su 404; nastavnik i mentor ne čitaju ništa. Popis tuđe osobe je prazan, nikad greška.
- **Bez zvuka i bez automatskog prepisa (V18-7).** Gradivo je upisan ili zalijepljen tekst.
- **Pomoćnik se ne poziva (V18-3).** Nijedna ruta ne zove pomoćnika i nijedan odgovor ne nosi prijedlog koda ili sažetak.
- **Nepromjenjivo.** Tekst gradiva se ne mijenja; izmjena je novo gradivo. Nema `PATCH` rute. Gradivo s barem jednim označenim odlomkom je `locked: true`.
- Samo izmišljeni podaci dok vlasnik ne odluči o DPIA-i (OP-V18-1).

## Rute

Pristup `student`; sesija odlučuje tko pita, baza je li gradivo njegovo.

| Operacija                      | Ruta                                         | Uspjeh                              |
| ------------------------------ | -------------------------------------------- | ----------------------------------- |
| `student.qual-materials.get`   | `GET /api/v1/student/qual/materials`         | 200 `{materials: [popisna stavka]}` |
| `student.qual-materials.post`  | `POST /api/v1/student/qual/materials`        | 201 gradivo                         |
| `student.qual-material.get`    | `GET /api/v1/student/qual/materials/{id}`    | 200 gradivo                         |
| `student.qual-material.delete` | `DELETE /api/v1/student/qual/materials/{id}` | 204                                 |

Popisna stavka (bez teksta, najnovije prvo): `{id, title, kind, createdOn, charCount, segmentCount, locked}`. Gradivo: `{id, title, kind, text, createdOn, segmentCount, locked}`. `createdOn` je dan (`YYYY-MM-DD`), `kind` je `interview` ili `note`, `charCount` su znakovi (code pointovi), ne UTF-16 jedinice.

### `POST` tijelo

Točno `{title, kind, text}`:

- `title`: jedan redak od 1 do 200 znakova, bez razmaka na početku i kraju, bez kontrolnih znakova;
- `kind`: `interview` ili `note` (zatvoren popis);
- `text`: 1 do 100 000 znakova s nečim vidljivim; kontrolni znakovi osim prijeloma retka i tabulatora nisu dopušteni. `\r\n` i usamljeni `\r` zalijepljenog teksta pohranjuju se kao `\n`, pa je indeks odlomka (redak teksta) isti u bazi i na webu.

Najviše 200 gradiva po osobi (409 `conflict` iznad toga). Tijelo koje nije točno ovo je 422 `invalid_input`; granica tijela 524 288 bajtova.

### `DELETE`

Briše gradivo zajedno s označenim odlomcima.

## Greške

Bez novih kodova grešaka. 401 `unauthorized`; 404 `not_found` (tuđe, nepoznato i neispravno, isti odgovor); 409 `conflict` (ograničenje od 200, samo `POST`); 422 `invalid_input` (samo `POST`); 400/403/408/413/415 kao zaštita mutacije; 503 `unavailable` (i za odgovor koji ugovor ne dopušta).

## Provjera

`server/http/qualitative-materials.pg.integration.test.ts` (stvarna baza): vlasnik čuva, čita i briše; drugi student i nastavnik dobivaju 404 na čitanje i brisanje i prazan popis; neispravan id je 404; loš ulaz je 422; zaključano gradivo i brisanje s odlomcima. Vektori u `server/contracts/vectors/student.qual-*.json`.
