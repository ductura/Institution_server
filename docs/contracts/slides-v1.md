# Slajdovi v1: kanonski dokument rada vrste „slides”

Zadatak: SRV-V13-UGOVOR-SLAJD `srv-v13-ugovor-slajd` (Ductus#2055; val 13, `docs/nalazi/val13-razlika.md` u WEB repou, §3 i §4 zadatak 1), `Risk: critical`. Status: **PRIJEDLOG granica** (odjeljak 6 čeka vlasnikov pregled); sam oblik je aditivan i nema API-ja: nijedna ruta, tablica ni polje ugovora se ne mijenja. Slijede SRV-V13-KORACI-SLAJD (koraci), SRV-V13-UGOVOR-VRSTA (`documentKind` na žici), SRV-V13-EVIDENCE-SLAJD i SRV-V13-IZVOZ-PPTX.

Kod: `server/domain/slides/{schema,validate,snapshot,revision-zero,index}.ts`, zlatni vektori `server/domain/slides/golden-vectors-v1.json`.

## Zašto

Plan val 13 traži vlastiti editor slajdova na istim temeljima kao tekstni editor (lokalni dnevnik, revizija, potpis, predaja, potvrda, izvoz). Tekstni dokument (sheme 1 do 4) ne smije se proširivati: invarijanta ugovora v4 je da tekstni radovi ostaju bajt-jednaki. Zato slajdovi dobivaju **zaseban kanonski dokument** sa svojom linijom `schemaVersion`.

## Invarijanta

Dokument slajdova je jedan JCS (RFC 8785) objekt čiji SHA-256 pokriva sve slajdove, njihov redoslijed, rasporede, blokove, ID-eve, bilješke govornika i SHA-256 svake priložene slike. Nijedan put (validator, snimka, korak, replay, rekonstrukcija, izvoz) to ne mijenja, ne skraćuje i ne briše tiho. Tekstni radovi ostaju kakvi jesu i nijedan put ih ne pretvara u slajdove ni obratno.

## 1. Gornja razina

| Ključ           | Oblik                  | Pravilo                                                        |
| --------------- | ---------------------- | -------------------------------------------------------------- |
| `documentKind`  | tekst `"slides"`       | Bilo što drugo je `DOCUMENT_KIND_INVALID`.                     |
| `schemaVersion` | JSON broj `1`          | Bilo što drugo je `SCHEMA_VERSION_INVALID`, bez zaokruživanja. |
| `slides`        | niz slajdova, 1 do 100 | Odjeljak 2. Prazan niz ili više od 100 je `SLIDES_INVALID`.    |

- Skup ključeva je zatvoren (`UNKNOWN_FIELD`), na svakoj razini. Objekt mora biti običan JSON objekt (ne polje, ne instanca, ne nositelj `__proto__`).
- Jedini broj u dokumentu je `schemaVersion`; svi ostali podaci su tekst, pa JCS zapis ne ovisi o pretvorbi broja u tekst.
- `documentKind` je dio revizije nula: određuje se pri pokretanju rada iz vrste zadatka i nikad se ne mijenja. Kako se šalje na žici određuje SRV-V13-UGOVOR-VRSTA, ne ovaj ugovor.

## 2. Slajd

| Ključ    | Oblik               | Pravilo                                                                        |
| -------- | ------------------- | ------------------------------------------------------------------------------ |
| `id`     | UUID v4, mala slova | Jedinstven u cijelom dokumentu zajedno s ID-evima blokova (`ID_DUPLICATE`).    |
| `layout` | zatvoren popis      | Odjeljak 3 (`LAYOUT_INVALID`).                                                 |
| `blocks` | niz blokova         | Odjeljak 4; može biti prazan (prazan slajd je `blocks: []`).                   |
| `notes`  | tekst, neobavezan   | Bilješke govornika, 1 do 4000 točaka koda; ili odsutan ili valjan, nikad `""`. |

Redoslijed slajdova u nizu je redoslijed prikaza. ID-evi su identitet: isti tekst u slajdu s drugim ID-em je drugi dokument.

## 3. Rasporedi i mjesta

Raspored je zatvoren popis. Svaki raspored ima mjesta (`slot`) u fiksnom redoslijedu; blok se veže za jedno mjesto.

| `layout`       | Mjesta, redom            |
| -------------- | ------------------------ |
| `title`        | `title`, `subtitle`      |
| `titleContent` | `title`, `body`          |
| `twoColumns`   | `title`, `left`, `right` |
| `imageOnly`    | `image`                  |

| Mjesto                  | Dopušteni blokovi                       | Najviše blokova |
| ----------------------- | --------------------------------------- | --------------- |
| `title`                 | `heading`                               | 1               |
| `subtitle`              | `paragraph`                             | 1               |
| `body`, `left`, `right` | `paragraph`, `list`, `heading`, `image` | 8               |
| `image`                 | `image`                                 | 1               |

Mjesto izvan rasporeda je `SLOT_INVALID`; vrsta bloka koju mjesto ne prima je `BLOCK_TYPE_INVALID`; preko kapaciteta je `SLOT_FULL`.

## 4. Blokovi

Svaki blok ima `type`, `id` (UUID v4, mala slova, jedinstven) i `slot`. Skup ključeva po vrsti je zatvoren.

| `type`      | Dodatni ključevi                          | Pravila                                                                                                                                                               |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heading`   | `text`                                    | 1 do 200 točaka koda, jedan redak                                                                                                                                     |
| `paragraph` | `text`                                    | 1 do 2000 točaka koda, smije imati prijelome redaka (`\n`)                                                                                                            |
| `list`      | `items`                                   | 1 do 20 stavki, svaka 1 do 300 točaka koda, jedan redak                                                                                                               |
| `image`     | `attachmentId`, `attachmentSha256`, `alt` | Slika kroz postojeće privitke: `attachmentId` UUID v4 (mala slova), `attachmentSha256` 64 mala heksadecimalna znaka, `alt` 1 do 300 točaka koda (obavezan opis slike) |

- **Tekst** (svi tekstni ključevi, bilješke i stavke): ista pravila kao tekstni dokument v2: nijedna točka koda sa zatvorenog popisa zabranjenih (kontrolni znakovi, znakovi smjera pisanja, nevidljivi znakovi), nema usamljenih surrogata, NFC oblik, ne počinje i ne završava razmakom. Duljina se broji u točkama koda, ne u UTF-16 jedinicama. Prijelom retka (`\n`) dopušten je samo u `paragraph` i `notes`; `\r` nikad. Validator odbija, nikad ne popravlja ni ne skraćuje (`TEXT_INVALID`, `LIST_INVALID`, `IMAGE_INVALID`, `NOTES_INVALID`).
- **Slika:** bajtovi slike nisu u dokumentu, ali njihov SHA-256 jest, pa se zamjena bajtova bez promjene dokumenta otkriva usporedbom hasha. Izvoz i rekonstrukcija nikad ne koriste privitak čiji se hash ne slaže.
- **Redoslijed:** `blocks` je poredan po redoslijedu mjesta rasporeda (odjeljak 3), a unutar mjesta redom prikaza; drugi redoslijed je `BLOCK_ORDER_INVALID`. Time isti sadržaj ima točno jedan zapis.

## 5. Snimka, hash i jednakost

- **Snimka** je JCS (RFC 8785) tekst dokumenta, kodiran kao UTF-8 bez BOM-a. SHA-256 (mala heksadecimalna slova) računa se nad tim bajtovima.
- **Prihvaćanje snimke** (`verifySlidesSnapshot`): najviše 2 MiB (`too_large`, provjera prije čitanja), strogi UTF-8, valjan dokument i JCS oblik jednak primljenom tekstu (drugi redoslijed ključeva ili razmaci su `invalid`). Hash je hash primljenih bajtova.
- **Jednakost** (`slidesDocumentsEqual`): isti kanonski bajtovi, dakle isti slajdovi istim redom s istim ID-evima, rasporedima, blokovima i bilješkama.
- Granice ukupnog dokumenta: najviše 800 blokova (`TOO_MANY_BLOCKS`) i 60 slika (`TOO_MANY_IMAGES`). Validator vraća najviše 50 grešaka i ne baca iznimku ni na neprijateljskom ulazu.

## 6. Granice i odluke vlasnika

Brojevi u odjeljcima 1 do 5 (100 slajdova, 800 blokova, 60 slika, duljine tekstova, kapaciteti mjesta, 2 MiB) i popis od četiri rasporeda **prijedlog su ovog ugovora** (val 13 §6: „postavlja ugovor `slides-v1.md`; vlasnik potvrđuje u pregledu ugovora”). Mijenjaju se jedino zajedno s vektorima i testovima; promjena granice na koju su već spremljeni radovi oslonjeni zahtijeva Danielovu odluku. Tekst obavijesti u ovom ugovoru ne postoji (nema ruta ni poruka).

## 7. Revizija nula

Svaki rad vrste `slides` počinje istim dokumentom: jedan slajd rasporeda `titleContent`, bez blokova i bez bilješki, s fiksnim ID-em `00000000-0000-4000-8000-000000000000`.

```
{"documentKind":"slides","schemaVersion":1,"slides":[{"blocks":[],"id":"00000000-0000-4000-8000-000000000000","layout":"titleContent"}]}
```

SHA-256: `f593200307d93c988cc050521ab02853510a424d59763d575de83fda1cf8a0d8` (izračunato s `sha256sum`, kod ga ne preračunava). Promjena ID-a, rasporeda ili ključeva mijenja revizije svih novih radova i pitanje je za vlasnika.

## 8. Zlatni vektori

`server/domain/slides/golden-vectors-v1.json`, izvedeni izvan koda (Python `json` i `hashlib`), ASCII s LF-om, uspoređuju se kako su zapisani:

- `slidesV1`: četiri prihvaćena dokumenta (revizija nula, naslovni slajd s bilješkama, dva stupca s popisom, slikom i odlomkom, slajd samo sa slikom) s UTF-8 bajtovima (`utf8Hex`) i `sha256`;
- `rejectedSlidesV1`: 16 odbijenih dokumenata s točnim popisom grešaka (putanja i kod).

Svi sadržaji su izmišljeni.

## 9. Što ovaj ugovor ne radi

- Koraci uređivanja (`ductus-slide-steps-v1`) i njihova primjena: SRV-V13-KORACI-SLAJD.
- `documentKind` u rutama, odgovorima i bazi: SRV-V13-MIG-VRSTA i SRV-V13-UGOVOR-VRSTA.
- Potpis, lanac segmenata, predaja, rekonstrukcija: SRV-V13-EVIDENCE-SLAJD (postojeći put, bez izmjene formata potvrde).
- Izvoz `.pptx` i PDF: SRV-V13-IZVOZ-PPTX i SRV-V13-RUTA-IZVOZ.
- Izvan opsega vala 13: animacije, prijelazi, ugrađeni video i zvuk, zajednički rad uživo, predlošci fakulteta, uvoz `.pptx`.
