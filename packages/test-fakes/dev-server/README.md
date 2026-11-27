# Lažni razvojni server (`@ductura/test-fakes/dev-server`)

Lažni server iz ugovora `/api/v1` za razvoj weba (Ductus#2028): web gradi stranice bez čekanja serverskih rukovatelja. **Samo lokalno i u testovima (D-09).** Paket se ne učitava uz `NODE_ENV` izvan nepostavljenog, `development` i `test`, a lint `local/no-fake-server-import` ga drži izvan produkcijskog koda. Svi računi, kolegiji, kodovi i tekstovi su izmišljeni.

## Pokretanje

```sh
pnpm dev:lazni-server
```

Sluša na `127.0.0.1`, port iz `DUCTURA_LAZNI_PORT` (zadano `4010`). Portovi 3000 do 3004 su rezervirani za web i ostale lokalne servere i odbijaju se. Stanje je u memoriji: ponovno pokretanje ili `POST /__lazni/ponovno` vraća početne podatke.

## Radovi sheme 3

Zadano su početni i novi radovi sheme 1. Uz `DUCTURA_LAZNI_SHEMA=3` dobivaju reviziju 0 koju pravi server piše za shemu 3 (`REVISION_ZERO_V3_JCS` iz `server/domain`), pa web otvara v3 uređivač. Druge vrijednosti osim `1` i `3` server odbija pri pokretanju. `evidence.open.post` za svaki rad šalje `schemaVersion` i `revisionZeroHash` (SHA-256 bajtova revizije 0), kao pravi server. Shema ostaje ista i nakon `POST /__lazni/ponovno`.

## Kako ga web koristi

Bazni URL API-ja je `http://127.0.0.1:4010/api/v1`. Kolačić sesije (`ductura_lazna_sesija`) je vezan uz host, pa je najjednostavnije da web dev server prosljeđuje `/api/v1/*` i `/__lazni/*` na lažni server (npr. `rewrites` u `next.config`), tako da preglednik sve vidi na istom hostu.

## Prekidač uloge (jedina prijava)

| Zahtjev                                                | Što radi                                                |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `GET /__lazni/uloga`                                   | popis računa s poveznicama                              |
| `GET /__lazni/uloga?kao=student`                       | nova sesija za račun, kolačić `ductura_lazna_sesija`    |
| `GET /__lazni/uloga?kao=student&povratak=/moji-zadaci` | isto, pa 303 na lokalni put (drugi host se ne prihvaća) |
| `GET /__lazni/uloga?kao=odjava`                        | zatvara sesiju                                          |

`GET /api/v1/auth/login` šalje preglednik na `/__lazni/uloga`; nijedan pružatelj prijave se ne zove. Drugog načina prijave nema.

Računi (vrijednosti iz SRV-01 `seed-lokalni`, w1119r):

| `kao`           | Osoba          | Uloge               | Odnosi                                                       |
| --------------- | -------------- | ------------------- | ------------------------------------------------------------ |
| `student`       | Lucija Đaković | `student`           | upisana u seminar, grupa A, obavijest potvrđena, rad otvoren |
| `student-2`     | Marko Ljubić   | `student`           | nije upisan                                                  |
| `nastavnik`     | Petar Kranjčec | `teacher`           | nositelj oba kolegija                                        |
| `nastavnik-2`   | Maja Džombić   | `teacher`           | nastavnik grupe B seminara                                   |
| `administrator` | Vesna Upravić  | `institution_admin` | potvrđuje i opoziva nastavnike                               |
| `operater`      | Oto Operić     | `institution_admin` | lokalni operater, `demo-operater` iz seeda                   |
| `bez-uloge`     | Iva Neimenić   | (nijedna)           | račun bez potvrđene uloge                                    |

Mentorstvo: Petar Kranjčec je mentor završnog rada Lucije Đaković („Završni rad: zelene površine u izmišljenom gradu”, još nije započet). Brzi put nastavnika dodaje zapis u dnevnik pristupa koji student vidi.

Kolegiji: „Izmišljeni seminar iz ekologije grada” (grupe A i B, zadatak „Seminarski rad: kućno kompostiranje”) i „Izmišljeni praktikum iz urbane sociologije” (bez zadatka). Kodovi za upis: `UPIS2026DEMO` (valjan), `STARI2025KOD` (istekao), `PRAZNI2026DEMO` (praktikum). Fiksni ID-ovi su `IDS` u [state.ts](state.ts).

Pristup proizlazi iz odnosa u stanju (nastavnik kolegija, student u kolegiju), ne iz same uloge (C-23).

## Greške i kašnjenje

- `?__lazni_greska=<kod>` ili zaglavlje `x-lazni-greska: <kod>`: ruta vraća tu grešku iz ugovora, istim statusom, zaglavljima i tijelom kao vektor greške te rute (npr. `unavailable`, `forbidden`, `internal`). Kod koji ruta nema vraća 400 s popisom dopuštenih (`dopustene`).
- `?__lazni_kasnjenje=<ms>` ili `x-lazni-kasnjenje: <ms>`: odgovor kasni toliko milisekundi (najviše 30 000).
- Neispravan ulaz (tip sadržaja, JSON, parametri, upit, tijelo prema `VALIDATORS`) vraća grešku rute iz kataloga, kao pravi server. Ruta koja može vratiti 401 bez sesije vraća 401.

## Potvrde dokaza u lokalnom razvoju

- Pri pokretanju server generira Ed25519 ključ za izmišljene podatke. Privatni ključ ostaje u memoriji do kraja procesa, a `evidence.open.post` objavljuje javni ključ u `receiptKeys`.
- `evidence.commit.post` potpisuje potvrdu prihvaćenog odsječka. Protokol 1 vraća potvrdu odmah. Protokol 2 prvo vraća 202 `pending_signature`, a ponovljeni zahtjev vraća potpisanu potvrdu iste revizije.
- U editoru otvori izmišljeni rad i upiši tekst. Nakon provjere potvrde stanje prelazi u „Spremljeno na poslužitelju”.
- Potvrda predaje (`submission.submit.post`) i dalje sadrži ogledni nulti potpis.

## Uživo, komentari i zahtjevi za doradu

- `live.document.put` traži točno jedan preduvjet (`If-None-Match: *` ili `If-Match: "<token>"`), inače 428; zastarjeli token je 409 s trenutačnim. `live.document.get` daje ETag i 304.
- Komentari i zahtjevi za doradu žive u memoriji; vrijeme vide samo kao petominutni prozor. Zahtjev za doradu prolazi stanja `open`, `responded`, `accepted`, `reopened`, `withdrawn`; zastarjeli `expectedSeq` je 409 `conflict`, nedopušten prijelaz 409 `not_allowed`.
- Nastavnikovo čitanje uživo, sažetka procesa, ponovne reprodukcije i brzog puta upisuje se u dnevnik pristupa koji student vidi.

## Kod

- [contract.ts](contract.ts): rute (`ROUTE_TABLE`), provjere ulaza (`VALIDATORS`) i odgovori grešaka iz vektora `server/contracts/vectors`.
- [server.ts](server.ts): `answerDev` (jedan zahtjev, bez mreže) i `createDevServer` (HTTP).
- [state.ts](state.ts): stanje u memoriji i početni podaci (`createState`).
- `*-routes.ts`: odgovori po području (račun i platforma, ustanova, student, nastavnik, postavke, dokazi, suradnja); tip `Handlers` veže svaki odgovor uz generirane tipove ugovora, pa `tsc` odbija odgovor krivog oblika.
- [work.ts](work.ts): izmišljeni zapis rada (blokovi teksta i sažetak procesa) za brzi put i sažetak.
- [testing.ts](testing.ts): pomoćnici testova (`send`, `signIn`, `contractProblems`); uspješni odgovori se provjeravaju prema shemama ugovora (`checkVectors`).

- [coverage.test.ts](coverage.test.ts): za svaku rutu iz `ROUTE_TABLE` jedan scenarij koji mora vratiti odgovor (ne 501) valjan prema ugovoru, i za svaku grešku rute provjera tražene greške. **Nova ruta u ugovoru bez lažnog odgovora ili bez scenarija ruši test.**

Ruta bez lažnog odgovora vraća 501 `not_implemented`. Paket se ne objavljuje (kao `/pglite`); koristi se iz ovog repoa.
