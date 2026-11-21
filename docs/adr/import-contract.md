# ADR: ugovor uvoza (`import_event`, manifest, granice, naziv datoteke, potvrda pregleda)

SRV-1801 `ugovor-uvoza`, plan M8.0-S1 (D-290, D-291, D-292), Ductus DAN-436, `Risk: critical`.

**Status: PRIJEDLOG.** Sve što je ovdje novo vrijedi tek kad ga potvrdi review ovog ugovora. **SRV-1803 (M8.2, uvoz DOCX-a) ne počinje prije tog reviewa**, a ni M8.2b ni M8.3. Uvoz se u ovom PR-u ne gradi: nema tablice, RPC-a, rute, čitača datoteke ni teksta sučelja.

Kod uz ovaj dokument je u [`server/contracts/import/`](../../server/contracts/import/): TypeBox sheme, tipovi i čiste funkcije koje pribijaju pravila, s testovima. Formati odsječka v2, v3 i v4 i `evidence-receipt-v2` se ne mijenjaju.

## Kontekst

- **D-290** (izvor „uvoz”): uvezeni tekst ulazi u evidenciju kao izvor `import` u formatu odsječka v4 (`ductus-evidence-segment-v4`), zajedničkom s `ai-transfer` (D-269 O8). Format v4 s izvorom `import` i ključevima `importId` i `importManifestSha256` već postoji u `server/domain/forensics/evidence-segment-v2.ts`. Manifest uvoza je zaseban zapis koji stvara poslužitelj; klijent ga ne piše izravno. PRIJEDLOG do ovog reviewa: polja `import_event`, tri hasha manifesta i idempotentna potvrda pregleda.
- **D-291** (granice): lokator traga je strukturni, bez sadržaja teksta (D-198 t. 5). `rawByteLength` nema novu granicu, vrijedi granica B-8. Ostale granice čitanja predlaže ovaj ugovor na temelju izvještaja spikea M8.1 (Ductus `docs/spikes/M8.1-P03.md`).
- **D-292** (naziv datoteke): mentor vidi naziv uvezene datoteke, a student je na to upozoren u dijalogu uvoza. Otvoreno do ovog ugovora: gdje se naziv čuva, ulazi li u hash, normalizacija i najveća duljina.
- Izvor ugovora je Ductus `docs/contracts/import-v1.md` i `docs/contracts/evidence-segment-v4.md` te domenski kod Ductusa `src/domain/provenance/import/` (DAN-436, #1914). Ovaj ADR ga prenosi u Institution_server, dodaje sheme za žicu i zapis, pravila paketa (makroi, ugrađeni objekti, vanjske poveznice) i proširuje plan napada (Ductus #1911).

## Odluka

### 1. Zapis `import_event` (gradi SRV-1803)

Jedan redak po pripremljenom uvozu. Stvara ga poslužitelj kroz RPC; klijent ga ne piše izravno. Oblik: `ImportEventRecordV1` u [`import-event.ts`](../../server/contracts/import/import-event.ts).

| Polje (stupac)                              | Značenje                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `importId` (`import_id`)                    | UUID v4, jedinstven; isti kao u manifestu i u događaju `import` odsječka v4                               |
| `ownerId`, `documentId`                     | vlasnik (student) i dokument; potvrda drugog vlasnika ili dokumenta daje isto što i nepostojeći uvoz (P4) |
| `baseRevision`                              | revizija dokumenta nad kojom je uvoz pripremljen (P9)                                                     |
| `manifest`                                  | kanonski JCS tekst manifesta (§2)                                                                         |
| `manifestSha256`                            | SHA-256 UTF-8 bajtova tog teksta; čuva se uz manifest, nikad u njemu                                      |
| `importKind`, `fileFormat`, `rawByteLength` | preslika iz manifesta za upite i prikaz; izvor istine je manifest                                         |
| `fileName` (`file_name`)                    | normalizirani naziv (§3) ili `NULL`; izvan svakog hasha                                                   |
| `state`                                     | `pending`, `confirmed` ili `cancelled`                                                                    |
| `preparedAt`                                | vrijeme pripreme iz DB sata; ne ulazi u manifest ni odsječak                                              |
| `confirmedEventId`                          | id događaja `import` nakon potvrde, inače `NULL`; jedinstven (E2)                                         |

Dosljedan redak: `confirmed` uvijek ima `confirmedEventId`, ostala stanja nikad (`isConsistentImportEvent`).

**Vidljivost (C-23).** Student vidi svoje retke. Mentor vidi samo potvrđene uvoze, kroz postojeći put pristupa dokumentu (odnos mentor–rad, nikad sama uloga), i to projekciju `ImportEventMentorViewV1`: `importId`, vrsta, format, veličina i naziv. Bez hasha, manifesta, vlasnika, revizije i vremena pripreme. SRV-1803 dodaje tablicu s RLS-om, `GRANT` samo potrebnoj ulozi i retke u `db/main/tests/030-institution-access-matrix.sql`.

### 2. Manifest `ductus-import-manifest-v1` i tri hasha

Oblik je zadan ugovorom odsječka v4; ovaj ugovor ga ne mijenja, nego pribija pravila čitanja ([`manifest.ts`](../../server/contracts/import/manifest.ts)). Shema `ImportManifestV1` je unija tri zatvorena oblika: DOCX učitan iz datoteke, DOCX verzija iz oblaka (jedini sa `savedAt`) i PDF iz datoteke (nikad `traces`).

Tri hasha:

1. `rawSha256`: SHA-256 primljenih bajtova datoteke;
2. `contentSha256`: SHA-256(JCS(sadržaj kao dokument Ducture)) koji ulazi u dokument;
3. `manifestSha256`: SHA-256 UTF-8 bajtova JCS-a manifesta, mala heksadekadska slova. Događaj `import` odsječka v4 nosi ga kao `importManifestSha256`.

Pravila:

- Zatvoren skup ključeva. Nepoznat ključ, uključujući `author`, `lastModifiedBy`, `fileName`, `email` i sam `manifestSha256`, odbija se (M1, M16).
- `traces` je obvezan uz `docx` (može biti prazan), a uz `pdf` ga nema ni kao `[]` (M8, M9). Najviše tri traga, svaka vrsta jednom, `count` ≥ 1, redom `comment`, `deletion`, `insertion`.
- `savedAt` samo uz `cloud-version`, cijela UTC minuta (D-24, M10). `cloud-version` je samo `docx`.
- Tekst manifesta mora biti točno JCS pročitane vrijednosti. Drugi razmaci, redoslijed ključeva, dupli ključ ili drugi zapis broja odbijaju se kodom `MANIFEST_NOT_CANONICAL`; nikad se ne prepisuju (B-8, M12). Pozivatelj bajtove prvo dekodira strogim UTF-8 koji čuva BOM (`decodeStrictUtf8` iz `server/domain/forensics`), pa je jednak tekst isto što i jednaki bajtovi. Ugovori ne dekodiraju bajtove i ne hashiraju; to radi servis SRV-1803.
- B3: poslužitelj iz primljenih bajtova sam izračuna `rawSha256`, `rawByteLength`, `contentSha256` i tragove. Bilo koja razlika odbija cijeli uvoz. Prva razlika, stalnim redom, daje kod: `RAW_SHA256_MISMATCH`, `RAW_BYTE_LENGTH_MISMATCH`, `CONTENT_SHA256_MISMATCH`, `TRACES_MISMATCH` (M14).
- Odbijanje nosi samo kod, nikad vrijednost iz ulaza (D-198 t. 5).

Golden vektori: [`golden-vectors/import-manifest-v1.json`](../../server/contracts/import/golden-vectors/import-manifest-v1.json), bajt po bajt isti kao u Ductusu, izvedeni izvan koda (Python `json.dumps` s poredanim ključevima i `hashlib`), M13.

### 3. Naziv datoteke (D-292)

- **Gdje:** samo u stupcu `import_event.file_name`. Naziv nije u manifestu, ni u jednom hashu, ni u odsječku ni u potvrdi predaje (N8). Format v4 se zato ne mijenja, a naziv se može izbrisati ili skratiti bez diranja dokaza.
- **Normalizacija** (`normalizeImportFileName`, [`file-name.ts`](../../server/contracts/import/file-name.ts)), redom:
  1. zadnji dio putanje (dijeli se na `/` i `\`), N1;
  2. uklanjaju se usamljeni surogati (N6), zatim nevidljivi znakovi `\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}` i `\p{Default_Ignorable_Code_Point}` (kontrole, bidi kontrole, znakovi nulte širine, selektori varijanti, hangulske ispune), N2;
  3. NFC (N3);
  4. razmaci se sažimaju u jedan i obrezuju;
  5. najviše **200 kodnih točaka**, rez na granici kodne točke, rezultat se ponovno čisti (N4);
  6. prazan rezultat, `.` ili `..` daje `NULL`: uvoz ide bez naziva (N5).
- Funkcija je idempotentna (N9, svojstveni test).
- Prikaz je uvijek tekstualni; naziv nikad ne ide u HTML bez escapea (N7). To provjerava sučelje uvoza.
- **Čuvanje** prati D-30 (PRIJEDLOG, Q-16); ovaj ugovor na njemu ne gradi.

### 4. Granice čitanja (D-291)

Brojevi su u [`limits.ts`](../../server/contracts/import/limits.ts) (`IMPORT_READ_LIMITS`). Konfigurirano nije izmjereno (spike M8.1 nije mjerio realne izvoze); review zapisuje brojeve.

| Granica                          | Vrijednost                                 | Izvor                                                                          |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `rawByteLength`, `maxInputBytes` | 1 do 2 097 152 bajta (2 MiB)               | D-291: postojeća granica B-8 (`MAX_EVIDENCE_SEGMENT_BYTES`)                    |
| Broj ZIP unosa                   | 2000                                       | M8.1, neizmjereno                                                              |
| Raspakirani dio                  | 16 MiB                                     | M8.1, neizmjereno                                                              |
| Ukupno raspakirano               | 256 MiB                                    | M8.1, neizmjereno                                                              |
| Omjer raspakiravanja po dijelu   | 200                                        | M8.1, neizmjereno                                                              |
| Dubina XML-a                     | 128                                        | M8.1, neizmjereno                                                              |
| Atributi na jednom elementu      | 2000                                       | **novo**, prema slučaju iz Ductus #1851 (2000 atributa ispod 1 s); neizmjereno |
| Stranice PDF-a                   | 500                                        | **novo**, za M8.3; neizmjereno                                                 |
| Životni vijek pripreme           | 60 minuta od `preparedAt`, zatim `EXPIRED` | ovaj ugovor                                                                    |

- Pozivatelj granice smije samo pooštriti (`resolveImportReadLimits`, L3). Nepoznat ključ ili vrijednost koja nije pozitivan siguran cijeli broj vraća `null`: zahtjev nikad ne proširuje ni ne ispušta granicu.
- Sadržaj veći od granice odsječka odbija se kodom `CONTENT_TOO_LARGE`, ne skraćuje se (L2, B-8).
- Greška granice nosi samo kod (L4).
- Vrijeme i memoriju omeđuje worker (M8.1 ograničenje 2); broj postavlja SRV-1803 nakon mjerenja na najvećoj prihvaćenoj datoteci.

### 5. Idempotentna potvrda pregleda

Student pregleda uvoz i potvrdi ga. RPC u SRV-1803 uzme zaključavanje retka `import_event` (`FOR UPDATE`), pozove čistu odluku `decideImportConfirmation` ([`confirmation.ts`](../../server/contracts/import/confirmation.ts)) i tek onda zapiše događaj ili vrati postojeći.

Redoslijed odluke je stalan:

1. nema retka, drugi vlasnik, drugi dokument ili drugi `importId`: `NOT_FOUND` (P4; stranac ne doznaje postoji li uvoz);
2. `confirmed` s istim `manifestSha256`: `already-confirmed` s istim id-jem događaja, i nakon isteka, promjene revizije ili isključenog uvoza (P1, P8); s drugim hashom `MANIFEST_MISMATCH` (P2);
3. `cancelled`: `CANCELLED` (P3);
4. `pending`: drugi hash `MANIFEST_MISMATCH`, istek `EXPIRED` (P3), isključen uvoz `IMPORT_NOT_ALLOWED` (P7, D-282), druga revizija `REVISION_CHANGED` (P9), inače `confirm`.

Nekonzistentan redak (npr. `confirmed` bez id-ja događaja ili `pending` s njim) nikad se ne potvrđuje.

**Žica (PRIJEDLOG za rutu SRV-1803).** Tijelo `ImportConfirmBodyV1` nosi samo `importId` i pregledani `manifestSha256`; dokument dolazi iz putanje, a akter iz sesije, nikad iz tijela. Prvi uspjeh i svako ponavljanje vraćaju isto tijelo `ImportConfirmResponseV1` (`importId`, `eventId`). Statusi (`IMPORT_CONFIRM_ERRORS`): `NOT_FOUND` 404 `import_not_found`, `MANIFEST_MISMATCH` 409, `CANCELLED` 409, `EXPIRED` 410, `IMPORT_NOT_ALLOWED` 403, `REVISION_CHANGED` 409. Ruta, vektori i ključevi poruka ulaze u `server/contracts/routes/` tek sa SRV-1803.

**Istodobnost.** Odluka je čista funkcija bez stanja. SRV-1803 mora imati negativni test u kojem dvije istodobne potvrde istog uvoza daju točno jedan događaj, a druga dobiva `already-confirmed` (P5). Zaštita su zaključavanje retka i jedinstveni `import_id` i `confirmed_event_id`. Odjava između pripreme i potvrde (P6) odbija se postojećom ogradom sesije u RPC-u.

### 6. Vezanje uz odsječak v4

- Događaj `import` mora upućivati na potvrđeni uvoz istog `importId` i istog `importManifestSha256`; inače se odbija (E1). Provjerava SRV-1803 u RPC-u commita, u istoj transakciji.
- Jedan potvrđeni uvoz veže najviše jedan događaj (E2).
- Uvezeni tekst nikad nije `observed` (E4).
- Golden vektori v2, v3 i v4 ostaju bajt po bajt isti (E3).

### 7. Pravila paketa: makroi, ugrađeni objekti i vanjske poveznice

Poslužitelj nikad ne pokreće, ne otvara i ne dohvaća ništa na što datoteka upućuje. Pravila su u [`package-rules.ts`](../../server/contracts/import/package-rules.ts); čitač DOCX-a u SRV-1803 ih zove za svaku vezu iz `_rels/*.rels` i svaki tip iz `[Content_Types].xml`.

| Što                                                                                              | Ishod                                               | Kod                        |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------- |
| Projekt makroa (`vbaProject`, `wordVbaData`, potpis), tip sadržaja s makroima (`.docm`, `.dotm`) | cijeli uvoz odbijen                                 | `MACRO_PRESENT`            |
| Glavni dio koji nije običan dokument (predložak, HTML)                                           | odbijeno                                            | `CONTENT_TYPE_NOT_ALLOWED` |
| OLE objekt, ugrađeni paket, `altChunk`, ActiveX, poddokument, okvir, pripojeni predložak         | odbijeno                                            | `EMBEDDED_CONTENT`         |
| Vanjski cilj bilo koje vrste osim hiperveze (slika, predložak, okvir, OLE …)                     | odbijeno; cilj se nikad ne dohvaća                  | `EXTERNAL_RESOURCE`        |
| Vanjska hiperveza (Transitional)                                                                 | dopuštena; cilj je samo tekst i nikad se ne dohvaća | —                          |
| Nepoznat `TargetMode`, prazan tip veze ili sadržaja                                              | odbijeno                                            | `PACKAGE_INVALID`          |

Veze se prepoznaju po zadnjem dijelu URI-ja, pa se hvataju i Transitional, Strict i Microsoftovi imenski prostori. Strict OOXML se inače ne obrađuje (M8.1 ograničenje 4). Za PDF (M8.3): šifriran PDF daje `PDF_ENCRYPTED`, a JavaScript, akcije `Launch`, ugrađene datoteke, XFA i RichMedia daju `PDF_ACTIVE_CONTENT`. Iz PDF-a se samo čita tekst.

Svi kodovi čitanja su zatvoren popis `IMPORT_READ_REJECT_CODES`, a odbijanje je zatvoren objekt `{code}` (`ImportReadRejectV1`).

## Plan napada

Oznake M, N, P, E i L preuzete su iz Ductus #1911; Z, X, K i D su nove. Svaki redak ima test u `server/contracts/import/` ili je obveza imenovanog koraka.

### Manifest (M)

| #   | Scenarij                                                                            | Očekivano                                          | Test                                            |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| M1  | Nepoznat ključ: `author`, `lastModifiedBy`, `w:author`, `rsid`, `fileName`, `email` | odbijeno, bez vrijednosti u grešci                 | `manifest.test.ts`                              |
| M2  | Nedostaje bilo koji obvezni ključ                                                   | odbijeno                                           | `manifest.test.ts`                              |
| M3  | `manifestSchema` drugog slučaja ili verzije                                         | odbijeno                                           | `manifest.test.ts`                              |
| M4  | `importId`: velika slova, UUID v1, nil, bez crtica                                  | odbijeno                                           | `manifest.test.ts`                              |
| M5  | Hash: velika slova, 63 ili 65 znakova, ne-hex                                       | odbijeno                                           | `manifest.test.ts`                              |
| M6  | `rawByteLength`: 0, −1, 1.5, NaN, `"10"`, 2^53, granica i granica + 1               | 1 i granica prolaze                                | `manifest.test.ts`, `limits.test.ts`            |
| M7  | `importKind`/`fileFormat` izvan skupa; `cloud-version` + `pdf`                      | odbijeno                                           | `manifest.test.ts`                              |
| M8  | `traces` uz `docx`: izostanak, duplikat, `count` 0, četvrti element, krivi red      | odbijeno; `[]` prolazi                             | `manifest.test.ts`, `manifest.property.test.ts` |
| M9  | `traces` uz `pdf`, i `[]`                                                           | odbijeno                                           | `manifest.test.ts`                              |
| M10 | `savedAt` uz `file-upload`, sa sekundama, bez `Z`                                   | odbijeno; cijela minuta uz `cloud-version` prolazi | `manifest.test.ts`                              |
| M11 | `null`, niz, broj, objekt s prototipom, `__proto__`, `constructor`                  | odbijeno, bez zagađenja prototipa                  | `manifest.test.ts`                              |
| M12 | Drugi redoslijed ključeva, razmaci, dupli ključ, drugi zapis broja                  | `MANIFEST_NOT_CANONICAL`                           | golden vektori                                  |
| M13 | Poznati `manifestSha256` za četiri izmišljena manifesta                             | hash izračunat izvan koda                          | golden vektori                                  |
| M14 | `rawSha256`, `rawByteLength`, `contentSha256` ili tragovi se ne podudaraju          | cijeli uvoz odbijen, kod stalnim redom             | `manifest.test.ts`                              |
| M15 | Kanonski tekst ne sadrži autora, naziv datoteke ni tekst dokumenta                  | nema pogotka                                       | `manifest.test.ts`                              |
| M16 | `manifestSha256` u samom manifestu                                                  | nepoznat ključ                                     | golden vektori                                  |

### Naziv datoteke (N)

| #   | Scenarij                                           | Očekivano                                    | Test                                              |
| --- | -------------------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| N1  | `../../etc/passwd.docx`, `C:\Users\x\Rad.docx`     | samo zadnji dio                              | `file-name.test.ts`                               |
| N2  | Bidi kontrole (U+202E), nulta širina, C0/C1, DEL   | uklonjeno                                    | `file-name.test.ts`                               |
| N3  | NFD i NFC istog naziva                             | isti rezultat                                | `file-name.test.ts`                               |
| N4  | Rez usred surogatnog para ili kombinirajućeg znaka | rez na granici kodne točke                   | `file-name.test.ts`, `file-name.property.test.ts` |
| N5  | Prazno, samo razmaci, `.`, `..`                    | `NULL`                                       | `file-name.test.ts`                               |
| N6  | Usamljeni surogat                                  | uklonjen                                     | `file-name.property.test.ts`                      |
| N7  | `<img onerror>.docx`                               | spremljeno kao tekst; prikaz tekstualan      | `file-name.test.ts`; prikaz provjerava sučelje    |
| N8  | Naziv nije ni u jednom hashu                       | promjena naziva ne mijenja kanonski manifest | `file-name.test.ts`                               |
| N9  | normalize(normalize(x)) = normalize(x)             | uvijek                                       | `file-name.property.test.ts`                      |

### Potvrda pregleda (P)

| #      | Scenarij                                              | Očekivano                         | Test                                  |
| ------ | ----------------------------------------------------- | --------------------------------- | ------------------------------------- |
| P1, P8 | Ponovljena potvrda istog uvoza, i nakon gubitka mreže | isti događaj, nema drugog         | `confirmation.test.ts`                |
| P2     | Drugi `manifestSha256` za isti `importId`             | `MANIFEST_MISMATCH`               | `confirmation.test.ts`                |
| P3     | Potvrda nakon otkazivanja ili isteka                  | odbijeno                          | `confirmation.test.ts`                |
| P4     | Tuđi uvoz (drugi student, dokument)                   | isti odgovor kao nepostojeći, 404 | `confirmation.test.ts`                |
| P5     | Dvije kartice istodobno                               | točno jedan događaj               | obveza SRV-1803 (zaključavanje retka) |
| P6     | Odjava između pripreme i potvrde                      | odbijeno, ništa zapisano          | obveza SRV-1803 (ograda sesije)       |
| P7     | Uvoz isključen između pripreme i potvrde (D-282)      | `IMPORT_NOT_ALLOWED`              | `confirmation.test.ts`                |
| P9     | Revizija promijenjena između pripreme i potvrde       | `REVISION_CHANGED`                | `confirmation.test.ts`                |

### Odsječak (E) i granice (L)

| #   | Scenarij                                                  | Očekivano                                  | Test                                                           |
| --- | --------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| E1  | Događaj `import` bez potvrđenog uvoza ili s drugim hashom | odbijen                                    | obveza SRV-1803 (pgTAP)                                        |
| E2  | Isti uvoz vezan na dva događaja                           | drugi odbijen                              | `import-event.test.ts` (dosljednost); jedinstvenost u SRV-1803 |
| E3  | Golden vektori v2, v3, v4                                 | nepromijenjeni                             | postojeći testovi `server/domain/forensics`                    |
| E4  | Uvezeni tekst kao `observed`                              | nikad                                      | obveza SRV-1803 (projekcija)                                   |
| L1  | `rawByteLength` na i iznad B-8                            | na granici prolazi, iznad odbijeno         | `limits.test.ts`                                               |
| L2  | Sadržaj veći od granice odsječka                          | `CONTENT_TOO_LARGE`, bez skraćivanja       | obveza SRV-1803                                                |
| L3  | Pozivatelj proširuje granicu                              | samo stroža vrijednost; loš zahtjev `null` | `limits.test.ts`                                               |
| L4  | Greška granice nosi samo kod                              | uvijek                                     | `limits.test.ts`, `package-rules.test.ts`                      |

### ZIP bomba (Z)

| #   | Scenarij                                                            | Očekivano                                                                          | Gdje                    |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------- |
| Z1  | Mali DOCX koji se raspakira u gigabajte (visok omjer jednog dijela) | `ZIP_RATIO_EXCEEDED` prije nego što se dio raspakira do kraja                      | čitač SRV-1803          |
| Z2  | Mnogo dijelova ispod omjera, zbroj iznad 256 MiB                    | `ZIP_TOTAL_TOO_LARGE`                                                              | čitač SRV-1803          |
| Z3  | Lokalno zaglavlje laže o veličini u odnosu na središnji direktorij  | odbijeno (`ZIP_INVALID`), broji se stvarno raspakirano                             | čitač SRV-1803          |
| Z4  | Ugniježđeni ZIP (`embeddings/*.docx`)                               | nikad se ne otvara; ugrađeni paket daje `EMBEDDED_CONTENT`                         | `package-rules.test.ts` |
| Z5  | Više od 2000 unosa, duplikat imena, `../` u imenu, šifriran unos    | `ZIP_TOO_MANY_ENTRIES`, `ZIP_DUPLICATE_ENTRY`, `ZIP_PATH_INVALID`, `ZIP_ENCRYPTED` | čitač SRV-1803          |
| Z6  | Gornja granica raspakiranog uz najveći ulaz i najveći omjer         | uvijek je presijeca ukupna granica                                                 | `limits.test.ts`        |

### Preveliki ili zlonamjeran XML (X)

| #   | Scenarij                                                            | Očekivano                                    | Gdje           |
| --- | ------------------------------------------------------------------- | -------------------------------------------- | -------------- |
| X1  | DTD, vanjski entitet (XXE), „billion laughs”                        | `XML_DTD`; entiteti se nikad ne razrješavaju | čitač SRV-1803 |
| X2  | Dubina iznad 128                                                    | `XML_TOO_DEEP`                               | čitač SRV-1803 |
| X3  | Element s više od 2000 atributa ili dugim URI-jem imenskog prostora | `XML_TOO_MANY_ATTRIBUTES`; vrijeme ispod 1 s | čitač SRV-1803 |
| X4  | Jedan dio XML-a iznad 16 MiB                                        | `ZIP_PART_TOO_LARGE` prije parsiranja        | čitač SRV-1803 |
| X5  | Upute za obradu, neispravan UTF-8 u dijelu                          | `XML_INVALID`                                | čitač SRV-1803 |

### Makroi, ugrađeni objekti i vanjske poveznice (K)

| #   | Scenarij                                                                       | Očekivano                                                                                                          | Test                              |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| K1  | `.docm` preimenovan u `.docx`; `vbaProject.bin` u bilo kojem imenskom prostoru | `MACRO_PRESENT`                                                                                                    | `package-rules.test.ts`           |
| K2  | Glavni dio s makroima ili predložak                                            | `MACRO_PRESENT`, `CONTENT_TYPE_NOT_ALLOWED`                                                                        | `package-rules.test.ts`           |
| K3  | OLE, ActiveX, `altChunk` (ugrađeni HTML/RTF), poddokument                      | `EMBEDDED_CONTENT`                                                                                                 | `package-rules.test.ts`           |
| K4  | Vanjska slika ili predložak (`TargetMode="External"`, curenje IP-a, SSRF)      | `EXTERNAL_RESOURCE`; ništa se ne dohvaća                                                                           | `package-rules.test.ts`           |
| K5  | Neispravan `TargetMode` ili prazan tip                                         | `PACKAGE_INVALID`                                                                                                  | `package-rules.test.ts`           |
| K6  | Vanjska hiperveza s `javascript:` ili `file:` ciljem                           | dopuštena kao veza u paketu, ali cilj je samo tekst; dokument v2 nema oznaku poveznice, pa cilj ne ulazi u sadržaj | obveza SRV-1803 (test konverzije) |
| K7  | Polja `INCLUDETEXT`, `INCLUDEPICTURE`, DDE                                     | nikad se ne izvršavaju; uzima se samo spremljeni rezultat polja                                                    | obveza SRV-1803                   |
| K8  | Autor, `w:date`, `rsid*` u tragovima                                           | ne ulaze u manifest ni sadržaj (D-198 t. 5)                                                                        | M1, M15; čitač SRV-1803           |

### PDF (D, M8.3)

| #   | Scenarij                                                             | Očekivano                                     |
| --- | -------------------------------------------------------------------- | --------------------------------------------- |
| D1  | Više od 500 stranica                                                 | `PDF_TOO_MANY_PAGES`                          |
| D2  | Šifriran PDF                                                         | `PDF_ENCRYPTED`                               |
| D3  | JavaScript, `Launch`, `OpenAction` s akcijom, ugrađene datoteke, XFA | `PDF_ACTIVE_CONTENT`                          |
| D4  | Neispravna struktura, beskonačne reference objekata                  | `PDF_INVALID`, unutar granice vremena workera |
| D5  | Nema tekstnog sloja (skenirani PDF)                                  | `PDF_NO_TEXT_LAYER`                           |

Čitač (SRV-1804, [`server/import/pdf/`](../../server/import/pdf/)) dopušta samo akcije `GoTo`, `URI` (cilj ostaje tekst, nikad se ne dohvaća) i `Named`; svaka druga akcija, akcija bez vrste i svaki okidač `/AA` daju `PDF_ACTIVE_CONTENT`. Imena se uspoređuju nakon dekodiranja `#xx`, a pregledavaju se i objekti unutar object streamova. Granica vremena workera iz D4 dolazi s rutom (SRV-1804B).

### Mutacije koje moraju srušiti barem jedan test

- uklonjen `additionalProperties: false` iz sheme manifesta;
- `traces` uz `pdf` dopušten;
- uklonjena provjera kanonskog redoslijeda tragova;
- naziv datoteke dodan u hashirani manifest;
- bidi kontrole izostavljene iz normalizacije;
- potvrda s drugim `manifestSha256` vraća uspjeh;
- `resolveImportReadLimits` uzima veću vrijednost;
- vanjska slika dopuštena kao hiperveza.

## Posljedice

- SRV-1803 gradi tablicu `import_event`, RLS, pgTAP retke, RPC pripreme i potvrde, rutu i čitač DOCX-a po ovom ugovoru i uvozi ga kroz `server/contracts/index.ts` (jedan redak izvoza; ovaj PR ga ne dodaje jer nijedan pozivatelj još ne postoji).
- Domenski kod (dekodiranje bajtova, SHA-256) ostaje u `server/domain`; ugovor ne uvozi ništa osim TypeBoxa (karta servera, §2).
- `MAX_IMPORT_RAW_BYTES` ponavlja `MAX_EVIDENCE_SEGMENT_BYTES` jer ugovori ne smiju uvoziti `domain`; test ga drži na 2 097 152 bajta iz tablice granica v4.

## Otvorena pitanja (review ili vlasnik)

- O1 i O3 plana M8: ugovor na njima ne gradi.
- Zamjenjuje li M8.0-S1 korak M8.9 (oba nose DAN-436); Owner queue.
- Je li 2 MiB dovoljno za stvarne DOCX-e sa slikama: broj zapisuje review (D-291). Ako nije, granica uvoza se odvaja od B-8 samo novom odlukom.
- Granice ZIP-a, XML-a i PDF-a nisu izmjerene na realnim izvozima (M8.1-P03, preporuka 2).
- Čuvanje naziva datoteke: D-30 (PRIJEDLOG, Q-16).
- Treba li vanjska hiperveza ostati dopuštena ili i nju odbiti; ugovor je dopušta jer su URL-ovi u akademskim radovima česti, a cilj se nikad ne dohvaća.
