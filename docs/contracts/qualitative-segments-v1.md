# Označeni odlomci kvalitativnog kodiranja v1

Zadatak: SRV-V18-KODIRANJE-OZNAKE `srv-v18-kodiranje-oznake` (Ductus#2058, nalog c.7173853108; val 18, `docs/nalazi/val18-razlika.md` u WEB repou, §5 zadatak 8, nalazi V18-3, V18-7 do V18-9). Status: **aditivno, unatrag kompatibilno** (API 1.149.0). Baza, domena i adapter su `SRV-V18-KODIRANJE-BAZA` (migracija `20261219390000_qualitative_coding.sql`, RPC-i `app.create_qual_segment`, `app.qual_segments`, `app.delete_qual_segment`, `app.qual_export_segments`, `server/database/qualitative-coding.ts`); rute su montirane iz `server/http/qualitative-segments.ts` (`createQualitativeSegmentsRoutesFor(databases.main)`). Lažni dev server ih odgovara izmišljenim podacima. Nova migracija i nova tablica ne postoje, pa nema novih redaka u pgTAP matrici.

Ovisi o gradivu (`qualitative-materials-v1.md`) i šifrarniku (`qualitative-codes-v1.md`): odlomak se označava u vlastitom gradivu vlastitim kodom.

## Načela

- **Sve je vlasnikovo** (V18-9). Student označava i čita samo u svojem gradivu i svojim kodovima; nastavnik i mentor ne čitaju ništa od toga (dijeljenje je otvoreno pitanje OP-V18-5, pretpostavka je da ga nema, pa ruta za to ne postoji). Uloga sama ne daje pristup: pristup nastaje iz odnosa vlasništva (RPC-i `app.*qual_*`).
- **Tuđe, nepoznato i neispravno je isti 404** (C-23): gradivo, kod ili odlomak drugog studenta, nastavnikov pokušaj, ID koji ne postoji i ID koji nije UUID. Isto vrijedi za `materialId` u upitu izvoza.
- **AI ne kodira** (V18-3): nijedna ruta ne predlaže kod, ne označava sama i ne zove pomoćnika; odlomak označava samo osoba.
- **Redoslijed nikad po učestalosti** (V18-8): popis je po redoslijedu teksta, izvoz po šifrarniku, gradivu i tekstu. Broj odlomaka postoji samo kao opis (`counts`), bez poretka po njemu, bez „najčešće” i bez usporedbe gradiva.
- Samo izmišljeni podaci u vektorima, fixtureima i primjerima.

## Sidro odlomka (V18-7)

`anchor{paragraph, start, end, quote}`: odlomak je redak teksta gradiva (`paragraph`, od 0; retci su odvojeni znakom `\n`), a `start` i `end` su pomaci u **znakovima** (točkama koda, ne UTF-16 jedinicama; od 0, `end` isključen) unutar tog retka. `quote` mora biti **točno** ti znakovi: 1 do 500 znakova i ne samo praznine. Sidro koje ne odgovara tekstu je 422. Tekst gradiva se ne mijenja (izmjena je novo gradivo), pa sidro ostaje valjano; prvi odlomak zaključava gradivo.

## Rute

Sve ispod `/api/v1/student/qual`, pristup `student`. Svaka ima 401 `unauthorized` i 503 `unavailable`; rute s ID-em još 404 `not_found`; mutacije još `MUTATION_GUARD`; ona s tijelom još 415, 400 `invalid_json`, 409 `conflict` i 422 `invalid_input`. Odgovori nose `cache-control: no-store`. Nova klasa pristupa se ne uvodi, nema novih kodova grešaka.

| ID rute                       | Metoda i put                     | Opis                                      |
| ----------------------------- | -------------------------------- | ----------------------------------------- |
| `student.qual-segments.get`   | `GET …/materials/{id}/segments`  | označeni odlomci gradiva po tekstu        |
| `student.qual-segments.post`  | `POST …/materials/{id}/segments` | označava odlomak kodom                    |
| `student.qual-segment.delete` | `DELETE …/segments/{id}`         | uklanja jedan označeni odlomak            |
| `student.qual-export.get`     | `GET …/export` (`?materialId=`)  | izvoz kodiranja (`qualitative-export-v1`) |

Oblik odlomka je `segment{id, codeId, paragraph, start, end, quote, memo, createdOn}`: `id` i `codeId` UUID (mala slova), `memo` je tekst od 1 do 1000 znakova ili `null` kad ga nema (nikad prazan niz), `createdOn` je dan `YYYY-MM-DD`.

### `student.qual-segments.get`

`200 {segments:[segment…]}` po redoslijedu teksta (`paragraph`, `start`, `end`), zatim po šifrarniku; najviše 5000, moguće prazno. Nema upita ni tijela.

### `student.qual-segments.post`

Tijelo točno `{codeId, anchor{paragraph, start, end, quote}, memo?}` (do 8 KiB). `201` je označeni odlomak. Šifra koja nije studentova, nepoznata ili neispravna je 404, kao i gradivo koje nije njegovo. Sidro koje ne odgovara tekstu, prazan raspon (`end` ≤ `start`), citat dulji od 500 znakova ili samo od praznina, prazan ili predug memo, nepoznato ili nedostajuće polje su **422** i ništa se ne upisuje. Ista oznaka opet (isti kod i isto mjesto) i 5001. odlomak gradiva su **409 `conflict`**. Isto mjesto s drugim kodom je druga oznaka (jedan odlomak teksta smije imati više kodova).

### `student.qual-segment.delete`

Uklanja jedan odlomak; `204` bez tijela. Ostali odlomci i kodovi ostaju. Odlomak koji nije studentov, nepoznat i neispravan ID su isti 404; drugi poziv za isti ID je 404.

### `student.qual-export.get`

Opisan u [qualitative-export-v1.md](qualitative-export-v1.md). Jedini dopušteni upit je `materialId`, jednom; drugi upit je 422, a neispravan ili tuđ `materialId` je 404.

## Što ugovor ne odlučuje

- dijeljenje označenog s nastavnikom ili mentorom (OP-V18-5) i kodiranje dvoje kodera s mjerom slaganja (OP-V18-6);
- izmjena označenog odlomka (označava se ponovno: ukloni i dodaj);
- CSV izvoz (gradi web, V18-6);
- ekran označavanja (`WEB-V18-KODIRANJE-OZNAKE`).
