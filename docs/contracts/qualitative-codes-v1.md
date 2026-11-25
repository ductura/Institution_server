# Šifrarnik kvalitativnog kodiranja v1

Zadatak: SRV-V18-KODIRANJE-SIFRARNIK `srv-v18-kodiranje-sifrarnik` (Ductus#2058, nalog c.7173077456; val 18, `docs/nalazi/val18-razlika.md` u WEB repou, §5 zadatak 7, nalazi V18-3, V18-7 do V18-9). Status: **aditivno, unatrag kompatibilno** (API 1.142.0). Baza, domena i adapter su `SRV-V18-KODIRANJE-BAZA` (migracija `20261219390000_qualitative_coding.sql`, `server/database/qualitative-coding.ts`); rute su montirane iz `server/http/qualitative-codes.ts` (`createQualitativeCodesRoutesFor(databases.main)`). Lažni dev server ih odgovara izmišljenim podacima.

## Načela

- **Šifrarnik je vlasnikov.** Student ga piše i čita sam; nastavnik i mentor ne čitaju ništa od toga (V18-9). Dijeljenje s nastavnikom ili mentorom je otvoreno pitanje OP-V18-5; pretpostavka je da ga nema, pa ruta za to ne postoji.
- **Redoslijed je vlasnikov** (V18-8): odgovor je u redoslijedu šifrarnika (`order` 1 prvi), nikad po tome koliko se kod koristi. Nijedan odgovor ne nosi broj korištenja.
- **Tuđe, nepoznato i neispravno je isti 404** (C-23): kod drugog studenta, kod koji ne postoji i ID koji nije UUID. Uloga sama ne daje pristup; pristup nastaje iz odnosa vlasništva (RPC `app.qual_*`, bez ijedne iznimke za nastavnika). Nastavnik koji pozove `GET` dobiva vlastiti (obično prazan) šifrarnik, nikad tuđi.
- **AI ne kodira** (V18-3): nema prijedloga koda, automatskog označavanja ni poziva pomoćnika; šifrarnik piše samo osoba.
- Samo izmišljeni podaci u vektorima, fixtureima i primjerima.

## Rute

Sve ispod `/api/v1/student/qual/codes`, pristup `student`. Svaka ima 401 `unauthorized` i 503 `unavailable`; rute s ID-em u putu još 404 `not_found`; mutacije još `MUTATION_GUARD`; one s tijelom još 415, 400 `invalid_json` i 422 `invalid_input`. Odgovori nose `cache-control: no-store`. Nova klasa pristupa se ne uvodi, nema novih kodova grešaka.

| ID rute                    | Metoda i put    | Opis                                     |
| -------------------------- | --------------- | ---------------------------------------- |
| `student.qual-codes.get`   | `GET …`         | šifrarnik u redoslijedu šifrarnika       |
| `student.qual-codes.post`  | `POST …`        | dodaje kod na kraj šifrarnika            |
| `student.qual-code.patch`  | `PATCH …/{id}`  | preimenuje, opisuje ili premješta kod    |
| `student.qual-code.delete` | `DELETE …/{id}` | briše kod (i njegove oznake, uz potvrdu) |

Oblik koda je `code{id, name, description, order}`: `id` UUID (mala slova), `name` jedan redak od 1 do 80 točaka koda bez razmaka na rubovima, `description` prazan niz ili jedan redak od 1 do 500 točaka koda, `order` cijeli broj od 1 do 200 bez rupa.

### `student.qual-codes.get`

`200 {codes:[code…]}`, najviše 200, moguće prazno. Nema upita (svaki upit je 422).

### `student.qual-codes.post`

Tijelo `{name, description?}` (do 4 KiB). Kod se dodaje na kraj; odgovor `201` je kod s mjestom. Ime koje šifrarnik već ima (velika i mala slova su isto ime) i 201. kod su **409 `conflict`**. Prazno ili obrubljeno ime, dvoredni opis i nepoznato polje su 422.

### `student.qual-code.patch`

Tijelo bilo koje od `{name, description, order}`, barem jedno (prazno tijelo je 422). `order` je novo mjesto (1 = prvi); ostali kodovi zadržavaju svoj redoslijed i brojevi se ponovno poredaju bez rupa. Mjesto izvan 1 do broja kodova je 422 i ništa se ne mijenja. Ime koje ima drugi kod je 409 `conflict`. Odgovor `200` je kod kakav je sada.

Napomena o izvedbi: preimenovanje i premještanje su dva poziva baze (`app.update_qual_code`, `app.move_qual_code`), svaki u vlastitoj transakciji. Mjesto se provjerava prije prvog upisa, pa odbijeno mjesto ne ostavlja polovičnu promjenu; kvar baze između dva poziva ostavlja novo ime na starom mjestu, što klijent vidi iz odgovora i ponovnog čitanja.

### `student.qual-code.delete`

Upit `confirm=true` je jedini dopušteni (drugi upit ili `confirm` s drugom vrijednošću je 422). Kod bez označenih odlomaka briše se bez potvrde. Kod s označenim odlomcima briše se **zajedno s njima** samo uz `confirm=true`; bez toga je **409 `conflict`** i ništa se ne briše, pa klijent pita studenta i ponovi poziv s potvrdom (šifrarnik ne nosi broj oznaka po kodu). Ostali kodovi se zbijaju. Odgovor je `204` bez tijela.

## Što ugovor ne odlučuje

- dijeljenje šifrarnika (OP-V18-5) i kodiranje dvoje kodera (OP-V18-6);
- gradivo i označene odlomke (`SRV-V18-KODIRANJE-GRADIVO`, `SRV-V18-KODIRANJE-OZNAKE`) i izvoz;
- CSV izvoz (gradi web, V18-6).
