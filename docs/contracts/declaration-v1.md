# Izjava v1: shema, prilozi razgovora, veza s predajom i rute

**Status: ODOBREN (Daniel, 21. 11. 2026., „Odobravam”).** Otvorena pitanja zatvorena su u odjeljku „Odluke vlasnika (21. 11. 2026.)”; vrijedi ono što tamo piše, i ima prednost pred oznakama [OD-n] u tekstu.

SRV-M75U `ugovor-izjave-m75`, M7.5 (DAN-383), `Risk: critical`. Ugovor bez koda, po obliku Ductusovih ugovora `ai-request-v1.md`, `ai-tools-v1.md`, `submission-receipt-v2.md` i `submission-worker-m7-v1.md` (Ductus `docs/contracts/`). Određuje:

1. shemu izjave v1 i njezine granice;
2. prilog razgovora iz Ducturina pomoćnika;
3. vanjski prilog (ispis razgovora iz vanjskog alata);
4. vezu izjave i predaje;
5. rute s kodovima grešaka;
6. testove koji moraju postojati prije prvog retka koda.

Izvori (Ductus repo, `main` na 0cdb0f1, i ovaj repo):

- D-40: izjava po FPZG pravilniku čl. 9 i 15, složena iz zapisa, student je pregleda, dopuni i potvrdi; oba obrasca (koristio, nije koristio); nastavnik smije uključiti pitanje za refleksiju.
- D-41 (zamjenjuje D-22): uz izjavu automatski idu razgovori iz kojih je tekst prenesen u rad; student vidi točno što se prilaže i može dodati ostale razgovore te vanjske razgovore, označene kao izjavljeno; tijekom pisanja razgovori su samo studentovi.
- D-44: svaka stavka nosi vrstu dokaza: opaženo, uvezeno ili izjavljeno.
- D-77 (drugi dio, nepromijenjen): vanjski alat uz izjavu po čl. 15, ispis razgovora (poveznica za dijeljenje, izvoz ili zalijepljen tekst) kao izjavljeno.
- `docs/FEATURES.md`: R-09 (izjava o ljudskoj pomoći), R-10 (ispis razgovora iz vanjskog AI-ja uz izjavu, D-77).
- D-129 (uvjetno, čeka pisanu potvrdu FPZG-a): predaju smije blokirati samo nepotvrđena izjava koju fakultet propisuje i otvorena mjesta za izvor; blokada je postavka zadatka; naziv obrasca fakulteta samo uz oznaku „izjavljeno”.
- D-199 t. 1: AI dio izjave ulazi u val 1 s M9; izjava navodi i priložene razgovore s pomoćnikom (D-41, M7.5, M9.5).
- D-228, uz D-44 i D-129: izjava ne ulazi u hashirane bajtove dokumenta; dolazi tek u M7.5.
- D-263 Q03 (odjava ne zaustavlja posao predaje; opoziv blokira novu finalizaciju), Q07 (zahtjev zamrzava efektivni rok), Q22 (točne verzije cijelih odabranih razgovora, prikazane prije potvrde; obvezni su razgovori iz kojih je tekst prenesen; popis vanjskih formata i ograničenja zatvara se prije koda, M7.5-P02).
- D-266 t. 7: do 5. 2. 2027. izjava (M7.5) ima AI odjeljak nad zatvorenim formatom priloga; M9.5 poslije daje proizvođača priloga i integracijski dokaz.
- D-268 O3 (prijenos teksta koji je kasnije obrisan i dalje čini razgovor obveznim) i O6 (oznaka podudaranja ostaje isključena do U-4).
- `docs/PROGRAM-RAZRADA.md` retci M7.5, M9.5 i „Izjava” u valovima M7; `docs/PRODUCT.md` §5 (pravila 1, 2, 5, 7, 9, 11, 12, 14, 15 i rječnik).
- Ductus `docs/contracts/ai-request-v1.md`, odjeljak „Pridruživanje izjavi” (polja veze, `attachment_stale`, pravilo obveznosti) i `docs/contracts/evidence-segment-v4.md` (`ductus-ai-transfer-v1`, `pasteOrigin`, „Presuda i brisanje izvora”).
- Ovaj repo: `docs/plan/PLAN-MIGRACIJE.md` (✓ B-5, ✓ C-3, korak P-1, pitanja P-1, P-5 i P-7, SRV-19 i PO-17, WEB-24); `server/contracts/routes/evidence.ts` (`submission.submit.post`, `SignedSubmissionReceipt`), `server/contracts/routes/student.ts` i `teacher.ts` (oblik ruta, `assignmentReadErrors`, `MUTATION_GUARD`).

Gdje ugovor provodi izvor tehničkim izborom, uz pravilo piše „izbor ugovora”. Gdje izvor ne određuje vrijednost, ugovor je ne izmišlja: piše oznaku [OD-n] iz odjeljka „Otvorena pitanja”, a predložena vrijednost u tablici granica je samo prijedlog za odluku.

## Što ugovor ne odlučuje

- **Pružatelj i model računa** (D-194 t. 6 i 7, D-267 O1, Q-10). Ugovor ne bira ni jedno ni drugo. Polja pružatelja i modela su samo oblik iz `ductus-ai-transfer-v1`; testovi koriste `provider-test-a` i `model-test-1`.
- **Tekst obrasca fakulteta.** Pravila FPZG-a su konfiguracija, ne kod (pravilo 12). Ugovor ne sadrži tekst izjave ni naziv obrasca; izjava upućuje na verziju obrasca (odjeljak 1.2, [OD-11]). Do koraka P-1 i iznimke skenera iz ✓ B-5 sučelje koristi samo neutralan naziv „Izjava”; doslovni naziv službenog obrasca ne ulazi u sučelje.
- **Blokada predaje.** D-129 je uvjetan i ne gradi se prije pisane potvrde FPZG-a; polje zadatka „traži potvrdu izjave” ne postoji (PLAN pitanje P-1). Ugovor zato određuje oba slučaja (odjeljak 6.3), a blokada se ne uključuje dok nema odluke ([OD-6]).
- **Pitanje za refleksiju** (D-40). Gdje se čuva odgovor, nije odlučeno (PLAN P-7). Izjava v1 nema to polje; ključ je nepoznat i odbija se ([OD-9]).
- **Oznaka podudaranja i `aitext`.** Nikad u v1 (D-268 O6, U-4, korak P-1). Obveznost razgovora izvodi se samo iz zapisa prijenosa i trajne presude `known`, nikad iz usporedbe teksta.
- **Rokovi čuvanja** izjave, nepriloženih vanjskih datoteka i razgovora (D-30 PRIJEDLOG, Q-16). Kod čuvanja i brisanja se ne gradi.
- **Tekst sučelja** za stanja i greške nije dio ugovora; prolazi katalog poruka, skener zabranjenih izraza i `ductus-ui-copy`.

## Načela

| Pravilo                                   | Ugovor                                                                                                                                                                    | Izvor                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Izjava je izjava, ne opažanje             | Što piše student nosi vrstu `declared`; što dolazi iz zapisa nosi `observed`. Dvije vrste se nikad ne spajaju u jedno polje ni jednu oznaku.                              | D-44, D-77                     |
| Sustav ne tvrdi ništa o autoru            | Izjava ne sadrži i ruta ne vraća nikakvu procjenu, zbroj, udio ni oznaku. Ne računa se nesklad između izjave i zapisa; nema oznake podudaranja.                           | pravila 1, 2, 9 i 13; D-268 O6 |
| Prilaže se točno ono što je student vidio | Svaki prilog razgovora nosi `throughSeq` i `messagesSha256` verzije prikazane prije potvrde. Poslužitelj ih pri potvrdi i pri predaji uspoređuje sa spremljenim porukama. | D-263 Q22; ai-request-v1       |
| Obvezni prilog ne može se ukloniti        | Razgovor iz kojeg je tekst ušao u lanac evidencije prilaže se uvijek, i kad je tekst kasnije obrisan.                                                                     | D-41, D-263 Q22, D-268 O3      |
| Nepriloženo nastavnik nikad ne vidi       | Nastavnik čita samo razgovore i datoteke iz izjave vezane uz predaju, i samo do `throughSeq`.                                                                             | D-41; ai-request-v1, matrica   |
| Izjava nije dio dokumenta                 | Izjava je zaseban zapis. Ne ulazi u `artifactSha256`, `content_hash` ni u bajtove dokumenta; u predaju ulazi samo kao svoj hash.                                          | D-228, D-44, D-129             |
| Student vidi isto što nastavnik           | Prikaz izjave za nastavnika i studentov pregled „što ide uz predaju” daje ista funkcija, iz istih bajtova.                                                                | pravilo 5                      |
| Vrijeme iz sata baze                      | `confirmedAt` je trenutak potvrde iz sata baze, nikad s klijenta. Ne utječe na `requestedAt` ni na `afterDeadline`.                                                       | D-263 Q07; receipt-v2          |
| Potvrđeno se ne proširuje                 | Potvrđena verzija izjave se ne mijenja. Nova verzija obrasca ne poništava već potvrđenu izjavu.                                                                           | pravilo 14                     |
| Akter iz sesije                           | ID studenta, ustanove, razlog priloga, popis zapisa i vrijeme nikad ne dolaze iz tijela zahtjeva.                                                                         | M5 iz #1662 (uzorak)           |

## 1. Shema izjave v1

### 1.1 Payload

Potvrđena izjava je jedan JCS objekt (RFC 8785) `ductura-declaration-v1` sa zatvorenim skupom ključeva na svakoj razini. Sastavlja ga poslužitelj pri potvrdi, iz studentova unosa i iz zapisa. Nepoznat ili nedostajući ključ, duplikat ključa, simbol, getter, neenumerabilno polje i nekanonski bajtovi odbijaju se.

`declarationSha256 = SHA-256(JCS(payload))`, 64 mala heksadekadska znaka. Hash se sprema uz payload, nikad u njemu.

| Ključ                               | Oblik                                                                   | Tko ga daje                                            |
| ----------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `declarationSchema`                 | točno `ductura-declaration-v1` ([OD-14])                                | poslužitelj                                            |
| `declarationId`                     | kanonski UUID v4, mala slova                                            | poslužitelj                                            |
| `declarationVersion`                | cijeli broj ≥ 1; svaka potvrda iste izjave daje sljedeći broj, bez rupa | poslužitelj                                            |
| `principalId`                       | UUID studenta iz sesije                                                 | poslužitelj                                            |
| `assignmentId`, `assignmentVersion` | zadatak i verzija zadatka koja vrijedi u trenutku potvrde               | poslužitelj                                            |
| `documentId`                        | kao u potvrdi predaje                                                   | poslužitelj                                            |
| `revision`                          | cijeli broj ≥ 1: revizija za koju je izjava složena i potvrđena         | klijent šalje, poslužitelj provjerava da je trenutačna |
| `form`                              | objekt, odjeljak 1.2                                                    | klijent šalje, poslužitelj provjerava                  |
| `ownWork`                           | objekt, odjeljak 1.3                                                    | klijent                                                |
| `humanHelp`                         | objekt, odjeljak 1.4                                                    | klijent                                                |
| `ai`                                | objekt, odjeljak 1.5                                                    | dijelom klijent, dijelom poslužitelj                   |
| `confirmedAt`                       | kanonski UTC `YYYY-MM-DDTHH:mm:ss.ffffffZ`, šest decimala, sat baze     | poslužitelj                                            |

Nema polja s imenom studenta, mentora, kolegija ni ustanove; to se čita pri prikazu (D-228, isti uzorak kao naslovnica).

### 1.2 `form`: verzija teksta izjave

| Ključ         | Oblik                                                                              |
| ------------- | ---------------------------------------------------------------------------------- |
| `formId`      | `^[a-z0-9][a-z0-9-]{0,63}$`, ključ obrasca u verzioniranoj konfiguraciji fakulteta |
| `formVersion` | cijeli broj od 1 do 2^31 − 1                                                       |
| `formSha256`  | SHA-256 kanonskog teksta te verzije obrasca                                        |

Poslužitelj pri potvrdi provjerava da trojka postoji i da je `formVersion` važeća verzija za zadatak (inače `form_outdated`). Gdje u konfiguraciji stoji obrazac, kako se objavljuje i tko ga uređuje, nije zapisano ([OD-11]). Do odluke testovi koriste izmišljeni obrazac `test-izjava`, verzija 1.

### 1.3 `ownWork`: vlastiti rad, čl. 9 i 15

| Ključ       | Oblik       |
| ----------- | ----------- |
| `confirmed` | JSON `true` |

Student potvrđuje tekst obrasca iz `form`. Potvrda nije unaprijed označena (S-31); bez nje nema potvrde izjave (`incomplete`). Ductura tim poljem ne tvrdi ništa o radu: polje bilježi samo da je student potvrdio tekst obrasca (pravilo 1, D-44).

### 1.4 `humanHelp`: izjava o ljudskoj pomoći (R-09)

| Ključ            | Oblik                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `received`       | JSON boolean                                                                                                                                                                                                                                  |
| `entries`        | niz od 0 do `MAX_HUMAN_HELP_ENTRIES` objekata `{ kind, text }`; uz `received: false` mora biti prazan, uz `true` mora imati barem jedan unos                                                                                                  |
| `entries[].kind` | zatvoren skup `HUMAN_HELP_KINDS`: `language` (jezik i pravopis), `structure` (struktura i plan rada), `sources` (izvori i literatura), `content` (rasprava o sadržaju), `technical` (tehnička pomoć), `other`; nepoznata vrijednost se odbija |
| `entries[].text` | izjavni tekst, pravila iz 1.6, 1 do `MAX_DECLARED_TEXT_CODE_POINTS`; uz polje stoji uputa da se ne upisuju imena ni osobni podaci drugih osoba (uputa, ne provjera)                                                                           |

Vrsta pomoći je zatvoren skup ([OD-12], zatvoreno 21. 11.). Redoslijed unosa je studentov i ulazi u hash.

### 1.5 `ai`: AI odjeljak

| Ključ           | Oblik                                                                                                                                       | Vrsta dokaza                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `use`           | zatvoren skup `used`, `not_used` (oba obrasca iz D-40)                                                                                      | izjavljeno                                   |
| `recorded`      | niz `{ aiTransferId, aiTransferSha256 }` za svaki zapis `ductus-ai-transfer-v1` u lancu evidencije do `revision`, poredan po `aiTransferId` | opaženo; sastavlja poslužitelj               |
| `declaredTools` | niz od 0 do `MAX_DECLARED_TOOLS` objekata `{ toolLabel, purposeText, phaseText }`                                                           | izjavljeno                                   |
| `attachments`   | niz priloga iz odjeljaka 2 i 3, poredan po `reason`, zatim po `conversationId` odnosno `externalAttachmentId`                               | prilog razgovora opaženo, vanjski izjavljeno |

- `recorded` nosi samo upute na zapise prijenosa, ne pružatelja, model, svrhu, tekst ni vrijeme: to je već u zapisu prijenosa, koji je vezan uz lanac evidencije. Prikaz te podatke čita iz zapisa (D-41).
- `toolLabel`, `purposeText` i `phaseText` su studentov tekst o vanjskom alatu. Nisu izbor iz popisa pružatelja i ne provjeravaju se prema konfiguraciji (Q-10). Svaki ima 1 do `MAX_TOOL_FIELD_CODE_POINTS` točaka.
- `use: not_used` uz neprazan `recorded` je dopušten spoj. Poslužitelj ga ne odbija, ne označava i ne računa nesklad (pravila 1 i 13); obvezni prilozi ostaju obvezni. Kako se ta činjenica prikazuje, čeka korak P-1 i slike (varijanta `nesklad` nije u valu 3).
- Uz `use: not_used`, `declaredTools` mora biti prazan, a `attachments` sadrži samo obvezne priloge i one koje je student sam dodao.

### 1.6 Izjavni tekst

Za svako tekstualno polje iz 1.4 i 1.5:

- NFC; duljina se broji u Unicode točkama nakon NFC-a;
- barem jedan znak koji nije razmak; bez vodećeg i završnog razmaka;
- odbijaju se osamljeni zamjenski par, BOM, kontrolni znakovi C0 i C1 osim novog retka (u `entries[].text`) te znakovi za smjer pisanja (bidi);
- `toolLabel`, `purposeText` i `phaseText` su jedan redak, bez novog retka.

Izjavni tekst je podatak. Ne mijenja pravila zadatka ni upute pomoćniku (pravilo 16) i ne prolazi skener zabranjenih izraza, jer nije tekst sučelja; prikazuje se kao studentov citat s oznakom „izjavljeno”.

## 2. Prilog razgovora iz pomoćnika

### 2.1 Oblik

| Ključ            | Oblik                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `reason`         | `transferred`, `pasted_known`, `transferred_deleted` ili `student_added` (za vanjski prilog `external_upload`, odjeljak 3) |
| `conversationId` | kanonski UUID v4 razgovora (`assistant.conversation.id` iz ai-request-v1)                                                  |
| `throughSeq`     | cijeli broj ≥ 1: zadnja poruka verzije prikazane studentu prije potvrde                                                    |
| `messagesSha256` | SHA-256(JCS(niz `content_sha256` poruka razgovora od `seq` 1 do `throughSeq`, redom))                                      |

`attachment_stale` nije polje payloada, nego stanje priloga u odgovoru čitanja (odjeljak 2.4). Potvrđena izjava nikad ne sadrži zastarjeli prilog.

Prilaže se cijeli razgovor do `throughSeq`, ne izbor poruka (Q22: „cijelih odabranih razgovora”).

### 2.2 Razlog i obveznost

Razlog određuje poslužitelj iz lanca evidencije do revizije izjave; klijent ga nikad ne šalje. Ako vrijedi više razloga, uzima se prvi po redu u tablici.

| Razlog                | Kada                                                                                                                                                                     | Obvezan                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `transferred_deleted` | Razgovor bi bio `transferred` ili `pasted_known`, ali tekst nijednog takvog događaja iz tog razgovora nije neprekinut podniz teksta revizije izjave ([OD-8]).            | da (D-268 O3)           |
| `transferred`         | Na razgovor upućuje barem jedan zapis `ductus-ai-transfer-v1` iz lanca.                                                                                                  | da (D-41, Q22)          |
| `pasted_known`        | Na odgovor iz razgovora upućuje barem jedna trajna presuda `known` za lijepljenje s `pasteOrigin.kind = ai-response` (evidence-segment-v4, „Presuda i brisanje izvora”). | da (Q22, ai-request-v1) |
| `student_added`       | Studentov vlastiti razgovor za isti zadatak koji nije obvezan, a student ga je odabrao.                                                                                  | ne                      |

- Lijepljenje s presudom `not_observed` ne čini razgovor obveznim.
- Zahtjev pomoćniku poslan prije predaje sam po sebi ne čini razgovor obveznim.
- Kasnije brisanje prenesenog ili zalijepljenog teksta, odgovora ili razgovora ne mijenja obveznost (D-268 O3; E5 iz #1659).
- Student može dodati samo svoj razgovor za isti zadatak. Tuđi, nepostojeći i razgovor drugog zadatka daju isti ishod `invalid_attachment`, bez razlike u odgovoru.

### 2.3 Prikaz prije potvrde (Q22)

Prije potvrde student kroz `student.declaration.get` dobiva, za svaki obvezni razgovor i za svaki svoj razgovor za zadatak, cijeli sadržaj do trenutačne zadnje poruke te `throughSeq` i `messagesSha256` te verzije. Potvrda (`student.declaration.put` uz `confirm: true`) vraća točno te dvije vrijednosti za svaki prilog. Poslužitelj ih ponovno izračuna iz spremljenih poruka; ako se ne slažu, ili `throughSeq` nije postojeća poruka, potvrda se odbija s `attachment_stale`.

### 2.4 Stanje `attachment_stale`

Prilog je zastario kad vrijedi barem jedno:

1. iza `throughSeq` postoji poruka čiji je tekst prenesen ili zalijepljen s presudom `known` u lancu do revizije izjave;
2. `messagesSha256` se ne slaže s porukama do `throughSeq`;
3. razgovor je postao obvezan ili je promijenio razlog nakon što je verzija prikazana (npr. novi prijenos iz druge kartice).

Poruka dodana iza `throughSeq` iz koje ništa nije preneseno ne čini prilog zastarjelim: prilaže se verzija koju je student vidio, bez nove poruke. Zastarjeli prilog blokira potvrdu izjave. Za predaju vrijedi odjeljak 6.3.

### 2.5 Proizvođač priloga (D-266 t. 7)

M7.5 gradi format, provjeru i rute nad zatvorenim formatom priloga. Proizvođač, odnosno izračun obveznih razgovora iz sheme `assistant`, dolazi s M9.5 nakon M7.5. Dok shema `assistant` ne postoji u ovom repou, popis razgovora je prazan, a testovi M7.5 pune ga izmišljenim razgovorima kroz testnu podlogu (ne kroz bazu produkcijskog oblika). M9.5 dodaje integracijski dokaz nad stvarnim razgovorima.

## 3. Vanjski prilog (R-10, D-77)

### 3.1 Oblik u payloadu

| Ključ                  | Oblik                                               |
| ---------------------- | --------------------------------------------------- |
| `reason`               | točno `external_upload`                             |
| `externalAttachmentId` | kanonski UUID v4, daje poslužitelj pri prijenosu    |
| `format`               | vrijednost iz `EXTERNAL_FORMATS`                    |
| `byteLength`           | cijeli broj od 1 do `MAX_EXTERNAL_ATTACHMENT_BYTES` |
| `contentSha256`        | SHA-256 točnih primljenih bajtova                   |

Vanjski prilog je uvijek izjavljen (D-77, D-44). Ductura ne tvrdi da je ispis potpun, točan ni da potječe iz navedenog alata.

### 3.2 Zatvoren popis formata (M7.5-P02)

D-77 imenuje tri načina: poveznicu za dijeljenje, izvoz i zalijepljen tekst. Q22 traži točne verzije prikazane prije potvrde. Iz toga ugovor izvodi:

| Način iz D-77           | U v1                                                | Razlog                                                                                                                                                           |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zalijepljen tekst       | da, kao `text/plain` (UTF-8), isti put kao datoteka | izbor ugovora: jedan oblik spremanja i hasha                                                                                                                     |
| izvoz                   | da, samo formati iz `EXTERNAL_FORMATS`              | Q22                                                                                                                                                              |
| poveznica za dijeljenje | ne kao prilog ([OD-5])                              | poveznica nije zamrznuta verzija: sadržaj iza nje može se promijeniti, pa ne zadovoljava Q22; otvaranje poveznice nastavniku šalje zahtjev vanjskom poslužitelju |

Vrijednosti u `EXTERNAL_FORMATS` izvor ne određuje ([OD-3]). Prijedlog za odluku: `text/plain` i `application/pdf`. HTML, JSON izvoz i slike nisu u prijedlogu: HTML i JSON traže zaseban siguran prikaz, a slika nije ispis razgovora. Provjere oblika koje vrijede za svaki format:

- `text/plain`: strogi UTF-8, bez BOM-a, bez NUL-a i kontrolnih znakova osim novog retka i tabulatora; ne normalizira se, hash je nad primljenim bajtovima;
- `application/pdf`: počinje s `%PDF-`; ne izvršava se i ne prikazuje u stranici, nastavniku se daje kao preuzimanje s `content-disposition: attachment` i `x-content-type-options: nosniff`.

Dubinska provjera PDF-a (aktivni sadržaj, ugrađene datoteke) nije u v1 i ide u otvorena pitanja ([OD-3]).

## 4. Granice

Sve su imenovane konstante, iste na klijentu i poslužitelju; mijenjaju se samo novom verzijom ugovora. Test drži svaku na vrijednosti i za jedan preko nje.

| Konstanta                       | Vrijednost                                                                                                                                                | Izvor               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `DECLARATION_SCHEMA`            | `ductura-declaration-v1`                                                                                                                                  | ugovor ([OD-14])    |
| `EXTERNAL_FORMATS`              | [OD-3]; prijedlog `text/plain`, `application/pdf`                                                                                                         | M7.5-P02            |
| `MAX_EXTERNAL_ATTACHMENT_BYTES` | [OD-4]; prijedlog 2 097 152 (kao `maxSegmentBytes`)                                                                                                       | M7.5-P02            |
| `MAX_EXTERNAL_ATTACHMENTS`      | [OD-4]; prijedlog 10 po izjavi                                                                                                                            | M7.5-P02            |
| `MAX_EXTERNAL_TOTAL_BYTES`      | [OD-4]; prijedlog 10 485 760 po izjavi                                                                                                                    | M7.5-P02            |
| `MAX_ATTACHED_CONVERSATIONS`    | [OD-4]; prijedlog 50. Obvezni razgovori nikad ne padaju na ovoj granici: granica vrijedi samo za `student_added`                                          | ugovor              |
| `MAX_HUMAN_HELP_ENTRIES`        | [OD-4]; prijedlog 20                                                                                                                                      | ugovor              |
| `MAX_DECLARED_TOOLS`            | [OD-4]; prijedlog 20                                                                                                                                      | ugovor              |
| `MAX_DECLARED_TEXT_CODE_POINTS` | [OD-4]; prijedlog 2000 (kao poruka uz rad)                                                                                                                | ugovor              |
| `MAX_TOOL_FIELD_CODE_POINTS`    | [OD-4]; prijedlog 200                                                                                                                                     | ugovor              |
| `MAX_DECLARATION_BODY_BYTES`    | izvedena iz gornjih granica: najveće tijelo `student.declaration.put` s nadomjesnim parovima pisanim kao `\uXXXX`, plus omotnica; računa je test, ne ruka | ugovor              |
| `MAX_JCS_DEPTH`, duljina id-a   | kao u evidence-segment-v4 (256, 256)                                                                                                                      | evidence-segment-v4 |

## 5. Stanja izjave

| Stanje      | Značenje                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `none`      | izjave za zadatak još nema                                                                                                                       |
| `draft`     | spremljen nacrt; nije potvrđen i nikad nije vidljiv nastavniku                                                                                   |
| `confirmed` | zadnja verzija je potvrđena i svi su prilozi trenutačni za trenutačnu reviziju                                                                   |
| `stale`     | zadnja verzija je potvrđena, ali je barem jedan prilog `attachment_stale`, nastao je novi obvezni razgovor ili se revizija promijenila ([OD-15]) |
| `bound`     | verzija je vezana uz zahtjev za predaju; više se ne mijenja                                                                                      |

- `none` → `draft`: prvi `put` bez `confirm`.
- `draft` ili `stale` → `confirmed`: `put` uz `confirm: true`, sve provjere prošle; nastaje nova verzija s `confirmedAt`.
- `confirmed` → `stale`: izračunava se pri čitanju i pri predaji, ne sprema se kao događaj.
- `confirmed` → `bound`: u transakciji zahtjeva za predaju (odjeljak 6).

Svaki `put` nakon `bound` daje `already_submitted`. Nova runda predaje (D-28, D-263 Q08) otvara novu izjavu; dok runde ne postoje, postoji jedna izjava po studentu i zadatku ([OD-13]).

## 6. Veza izjave i predaje

### 6.1 Redoslijed

Izjava se potvrđuje prije `submission.submit.post`. Tijelo predaje ostaje točno `{documentId, revision}`: izjava se ne šalje uz predaju, nego je poslužitelj nalazi sam.

U istoj transakciji u kojoj `app.request_submission` piše `requested_at`, pod istim redoslijedom zaključavanja, poslužitelj:

1. čita zadnju potvrđenu verziju izjave studenta za zadatak;
2. provjerava svježinu iz 6.2;
3. ako je svježa, upisuje uz zahtjev `declaration_version_id` i `declaration_sha256` (expand migracija, stari zahtjevi ostaju s NULL);
4. inače postupa po 6.3.

Zahtjev time zamrzava izjavu kao i ostali kontekst (D-263 Q07): worker je čita samo iz retka zahtjeva, nikad iz trenutačnog stanja izjave.

### 6.2 Svježina

Potvrđena verzija je svježa za predaju ako vrijedi sve:

- `revision` izjave jednaka je reviziji iz tijela predaje ([OD-15]);
- skup obveznih razgovora, izračunat iz lanca do te revizije, sadržan je u prilozima;
- nijedan prilog nije `attachment_stale` (2.4).

`confirmedAt` i trenutak potvrde u odnosu na `dueAt` ne utječu na svježinu ni na `afterDeadline`.

### 6.3 Kad izjava nije svježa

- **Zadatak traži potvrđenu izjavu** (D-129, postavka zadatka, uvjetno): zahtjev se odbija prije upisa s 409 `blocked` i razlogom `declaration_unconfirmed` ili `attachment_stale` (novi razlozi u zatvorenom skupu `blocked`, glavno izdanje ugovora rute). Student to može sam ispraviti u aplikaciji, pa je to potpunost iz pravila 11.
- **Zadatak ne traži potvrđenu izjavu** (danas svi zadaci, dok D-129 ne bude potvrđen i dok ne postoji postavka): izjava nikad ne blokira predaju. Predaja se zapisuje bez izjave, a `declarationSha256` u potvrdi je `null`. Zastarjela verzija se ne veže, jer bi nastavnik dobio verziju razgovora koju student nije potvrdio (Q22).

Tehnička greška pri čitanju izjave nikad ne sprječava predaju (pravilo 11): predaja ide bez izjave, kao u drugom slučaju, osim kad zadatak traži izjavu, kad vrijedi novi 503 s fazom `declaration`.

### 6.4 Izjava u potvrdi predaje

`submission-receipt-v2` se ne mijenja: njegovih 16 polja, prefiks i vektor ostaju bajt-jednaki. Izjava se veže na jedan od dva načina ([OD-2]):

|          | A: potvrda v3                                                                                                                        | B: manifest predaje                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Oblik    | `ductus-submission-receipt-v3` = 16 polja v2 (uz novu vrijednost `receiptSchema`) i obvezno `declarationSha256` (64 heks ili `null`) | v2 ostaje; uz nju poslužitelj izdaje zaseban potpisani zapis `ductura-submission-manifest-v1` `{submissionId, receiptPayloadDigestSha256, declarationSha256}` s vlastitim prefiksom domene |
| Provjera | jedan potpis pokriva predaju i izjavu                                                                                                | dva potpisa; provjeravatelj mora tražiti oba                                                                                                                                               |
| Promjena | issuer, browser i `/provjera` prelaze na v3; v2 zapisi ostaju (inventar, bez dopisivanja)                                            | issuer i provjeravatelj dobivaju drugi zapis; v2 tok ostaje                                                                                                                                |
| Slabost  | glavno izdanje ugovora `submission.submit.post`                                                                                      | manifest se može izgubiti ili ne izdati, a potvrda v2 i dalje izgleda potpuno                                                                                                              |

Preporuka ugovora: **A**, jer jedan potpisani zapis ne može se odvojiti od izjave. Prije odluke ne gradi se ni jedno ni drugo.

Izjava nije u `artifactSha256`, `content_hash` ni u bajtovima dokumenta (D-228). U potvrdu ulazi samo njezin hash, nikad sadržaj.

### 6.5 Odjava, opoziv i rok

- Odjava, istek ili brisanje sesije nakon zahtjeva ne mijenjaju vezanu izjavu ni posao predaje (D-263 Q03).
- Potvrđeni opoziv prava prije zapisa ishoda blokira finalizaciju (Q03). Zahtjev i vezana verzija izjave ostaju; nastavnik izjavu ne vidi, jer predaje nema.
- Opoziv prije zahtjeva: `student.declaration.put` i predaja daju isti ishod kao za nepostojeći zadatak.
- Produljenje roka nakon zahtjeva ne mijenja vezanu izjavu (Q07).

### 6.6 Izvedba koraka 5 (SRV-1214)

- **Vezanje i svježina.** Migracija `20261204100000_submission_declaration_freshness.sql` dodaje `declaration.is_fresh`, jednu provjeru iz 6.2 (revizija i verzija zadatka, obvezni razgovori, `attachment_stale`). Okidač `declaration.pin_request` na `evidence.submission_request` njome bira zadnju potvrđenu verziju u istoj transakciji i pod istim zaključavanjem kao `app.request_submission`; stanje `confirmed` odnosno `stale` u `declaration.view_statement` računa ista funkcija. Expand stupce `declaration_version_id` i `declaration_sha256` dodao je SRV-1510; stari zahtjevi ostaju s NULL.
- **Bez blokade (6.3, OD-6).** Nesvježa verzija se ne veže, a predaja se zapisuje bez izjave. Tehnička greška pri čitanju izjave također daje predaju bez izjave. Razlozi `declaration_unconfirmed` i `attachment_stale` u `blocked` ne postoje dok ne postoji postavka zadatka.
- **Potvrda v3 (OD-2, A).** Format `ductus-submission-receipt-v3` i njegov verifikator su u `server/domain/forensics/submission-receipt-v3.ts` i `submission-receipt-verifier-v3.ts`, s neovisno izračunatim vektorom: 16 polja v2 uz `receiptSchema` v3 i obvezni `declarationSha256` (64 heks ili `null`), prefiks domene `ductus-submission-receipt-v3`, ulaz potpisa 61 bajt. Vektor v2 ostaje bajt-jednak.
- **Otvoreno.** Izdavatelj, rute predaje i `/provjera` i dalje izdaju i čitaju v2. Prijelaz na v3 mijenja tip potvrde u odgovorima postojećih ruta, što `contracts:breaking` odbija unutar `/api/v1`; traži glavno izdanje ugovora (6.4) i odluku vlasnika.

### 6.7 Postavka zadatka `declarationRequired` (PIL-K-IZJAVA-SRV)

Odluka vlasnika 23. 11. 2026. (niže) uključuje prvi slučaj iz 6.3. Migracija `20261214110000_assignment_declaration_required.sql`:

- **Postavka.** `institution.assignment.declaration_required`, zadano `false` (expand; postojeći zadaci i svaki put izrade koji je ne navodi ponašaju se kao do sada, OD-6). Čita je i postavlja samo nastavnik zadatka (iz odnosa, C-23): `institution.declaration_required_setting(zadatak)` i `institution.set_declaration_required(zadatak, vrijednost)`, preko HTTP-a `teacher.declaration-required.get` i `.put` (`/api/v1/teacher/assignments/{assignmentId}/declaration-required`, tijelo `{required}`). Administrator, student i nastavnik drugog kolegija dobivaju 404. Postavljač zaključava redak zadatka (`FOR UPDATE`), pa zahtjev za predaju koji je u tijeku (`FOR SHARE`) završava pod starom vrijednošću.
- **Zapis promjena.** Svaka promjena upisuje redak u `audit.declaration_required_event` (tko, kada, nova vrijednost) u istoj transakciji; redak se ne može mijenjati ni brisati. Postavljanje vrijednosti koja već vrijedi ništa ne upisuje. Odgovor rute nosi `changedAt` zadnje promjene (`null` dok nije mijenjana).
- **Pilot.** Za pilot je postavka uključena: nastavnik je uključuje na svakom pilotnom zadatku rutom `teacher.declaration-required.put` s `{required: true}`.
- **Provjera pri predaji.** Kad je postavka uključena, okidač `declaration.pin_request` odbija redak zahtjeva bez verzije svježe za predanu reviziju (6.2, OD-15) s ZD428 `declaration_required`, pa se od zahtjeva ništa ne zapisuje. Nacrt, zastarjela verzija i verzija druge revizije nisu potvrda. Tehnička greška pri čitanju izjave tada također odbija (pravilo 11 kako je vlasnik odlučio 23. 11.: tehnički neuspjela potvrda ne smije dopustiti predaju). Kad je postavka isključena, okidač radi kao u 6.6.
- **Već započet zahtjev.** Zahtjev zapisan dok je postavka bila isključena nema izjavu. Dok je postavka uključena, `app.record_submission` takav zahtjev ne zapisuje kao predaju (okidač `declaration.require_pinned_submission`, ZD428), osim ako je predaja već zapisana (ponovni pokušaj nakon 503 `signing` vraća postojeću). Takav zahtjev ostaje vezan (P5, P8), pa ga student ne može ponovno poslati s izjavom; predaja ide tek kad nastavnik postavku isključi. Prozor je samo zahtjev kojemu zapis nije uspio prije uključivanja postavke.
- **Odgovor rute.** `submitWork` preslikava ZD428 iz zahtjeva i iz zapisa u ishod `declaration_required`. Na žici je to 409 `{status: "declaration_required"}` bez `retry-after` na drugom glavnom izdanju rute predaje, `submission.submit-second.post` (`POST /api/v1/submission/v2`; isto tijelo, zaštite, odgovori i potvrda kao `submission.submit.post`, uz taj jedan odgovor). Nova grana 409 na `submission.submit.post` lomi njegove klijente (`contracts:breaking`), pa prvo izdanje ostaje kakvo jest i isti slučaj odbija svojim 503 `{status: "unavailable", stage: "request"}`; nikad ga ne propušta. Web prelazi na drugo izdanje. Web proces prije zahtjeva pita i `declaration.submission_gate(documentId, revision)` (isto pravilo, samo za vlastiti rad pozivatelja); okidači ostaju jamstvo, a greška pri čitanju te provjere je 503 `request`.
- **Čitanje.** `student.declaration.get` (i odgovor `put`) nosi `declarationRequired` (boolean, uvijek poslan, u shemi neobavezan radi starijih klijenata), pa web ne pogađa: dok je `true`, predaju nudi samo u stanju `confirmed` za trenutačnu reviziju.
- `submission-receipt-v2` se ne mijenja i ostaje bajt-jednak.

### 6.8 Pitanje nastavnika uz izjavu (SRV-IZJAVA-PITANJE)

Odluka vlasnika 23. 11. 2026. (NF-5, pitanje 3: „Da”; NF-3 PR-20, NF-4 NZ-15, NF-5 PG-6) uvodi u pilot jedno neobavezno pitanje nastavnika uz izjavu i neobavezan odgovor studenta. Migracija `20261214150000_declaration_teacher_question.sql`, samo expand; payload `ductura-declaration-v1`, njegov hash i `submission-receipt-v2` ostaju bajt-jednaki.

- **Pitanje.** Nastavnik zadatka (nastavnik kolegija ili mentor rada, iz odnosa `institution.work_relation`, C-23) postavlja najviše jedno pitanje po zadatku: tekst od 1 do 500 znakova (Unicode code point), NFC, bez razmaka na početku i kraju, bez kontrolnih i smjernih znakova osim prijeloma retka. `institution.declaration_question_setting(zadatak)` i `institution.set_declaration_question(zadatak, tekst)`; `null` uklanja pitanje. Preko HTTP-a `teacher.declaration-question.get` i `.put` (`/api/v1/teacher/assignments/{assignmentId}/declaration-question`, tijelo točno `{question}`, odgovor `{question, changedAt}`). Student, nastavnik drugog kolegija i administrator dobivaju 404, neispravan tekst 422.
- **Izmjena nakon objave i zapis.** Pitanje se smije mijenjati i nakon objave zadatka. Svaka promjena upisuje redak u `audit.declaration_question_event` (tko, kada, novi tekst ili `null`) u istoj transakciji; redak se ne može mijenjati ni brisati. Pitanje na snazi je zadnji redak. Postavljanje teksta koji već vrijedi ništa ne upisuje. Postavljači se slažu redom preko retka zadatka (`FOR UPDATE`).
- **Student čita.** `student.declaration.get` (i odgovor `put`) nosi `teacherQuestion`: `{questionId, text}` pitanja na snazi ili `null`. `questionId` je ID verzije pitanja (retka zapisa).
- **Odgovor.** `student.declaration.put` prima neobavezno polje `questionAnswer`: `{questionId, text}` (tekst od 1 do 2000 znakova, ista pravila teksta kao izjavni tekst 1.6) ili `null`/izostavljeno (bez odgovora). `questionId` mora biti verzija pitanja tog zadatka koju je student pročitao, i kad ju je nastavnik u međuvremenu promijenio; inače 422 `invalid_input`. Ostatak tijela je zatvoreno tijelo iz 7.1, nepromijenjeno. Web proces poziva `declaration.save_statement_answer(zadatak, tijelo, obrazac, odgovor)`, koji u jednoj transakciji poziva `save_statement` i zapisuje odgovor; svako odbijanje `save_statement` vraća se nepromijenjeno, a uz neispravan odgovor ne ostaje ništa od spremanja.
- **Veza s verzijom i svježina.** Odgovor je redak `declaration.question_answer` vezan uz točno jedan redak `declaration.statement` (nacrt ili potvrđenu verziju) i uz tekst pitanja na koje odgovara. Nije dio hashiranog payloada. Zato je nacrt, potvrđen, zastario ili vezan točno kao izjava kojoj pripada (5, 6.2: `declaration.is_fresh`); nema vlastitog pravila svježine. Odgovor nacrta nestaje s nacrtom koji `save_statement` zamijeni (okidač `statement_draft_answer`); odgovor potvrđene verzije nikad se ne mijenja ni briše. `student.declaration.get` nosi `questionAnswer`: `{questionId, questionText, text}` retka o kojem je stanje, ili `null`.
- **Nastavnik čita.** `teacher.declaration.get` uz izjavu nosi `question` (pitanje na snazi ili `null`) i `questionAnswer` (odgovor vezane verzije, `null` bez vezane izjave ili bez odgovora). Baza: `app.teacher_declaration_answer(zadatak, student)` za nastavnika kolegija ili mentora rada studenta; čitanje vezanog odgovora upisuje redak dnevnika pristupa s površinom `declaration` (isti petominutni redak kao čitanje izjave). Od SRV-IZJAVA-MENTOR (odluka vlasnika 25. 11. 2026.) mentor rada čita i izjavu i odgovor kroz istu rutu `teacher.declaration.get` (odjeljak 7.1).
- **Pristup (RLS).** `declaration.question_answer` ima prisilni RLS i samo vlasnika `ductus_evidence`; aplikacija nema izravan pristup tablici. Odgovor piše samo student vlasnik kroz vlastitu sesiju (`save_statement_answer`), a čitaju ga samo student vlasnik (`read_statement`), nastavnik zadatka i mentor (`app.teacher_declaration_answer`). Retci u `db/main/tests/030-institution-access-matrix.sql` i `232-declaration-question.sql`.
- **Bez učinka na predaju i ocjenu.** Odgovor nije obavezan, ne blokira predaju (ni dok je `declarationRequired` uključen, 6.7) i ne ulazi u ocjenu.

## 7. Rute

Oblik ruta prati `server/contracts/routes/` (zatvorena tijela, odgovor greške `{status: <kod>}`, `MUTATION_GUARD`, isti 404 za tuđe, nepoznato i neispravno). Rute su prijedlog; dodaju se tek nakon odobrenja.

### 7.1 Popis

| Id                                     | Metoda i staza                                                                                                       | Pristup            | Učinak                                                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `student.declaration.get`              | `GET /api/v1/student/assignments/{assignmentId}/declaration`                                                         | `student_enrolled` | stanje (5), nacrt ili zadnja verzija, `recorded` sa zapisima prijenosa, kandidati za prilog s cijelim sadržajem do trenutačne zadnje poruke, `throughSeq`, `messagesSha256`, razlogom i stanjem priloga, vanjski prilozi i `teacherView` (7.2)                    |
| `student.declaration.put`              | `PUT /api/v1/student/assignments/{assignmentId}/declaration`                                                         | `student_enrolled` | sprema nacrt ili potvrđuje (`confirm: true`); vraća isto što i `get`                                                                                                                                                                                              |
| `student.declaration-attachments.post` | `POST /api/v1/student/assignments/{assignmentId}/declaration-attachments`                                            | `student_enrolled` | sprema vanjski prilog (bajtovi u tijelu, `content-type` iz `EXTERNAL_FORMATS`); vraća `{externalAttachmentId, format, byteLength, contentSha256}`; prijenos ne prilaže, prilaže tek `put` (dodatak ugovora, nije u nalogu)                                        |
| `teacher.declaration.get`              | `GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration`                                    | `course_teacher`   | nastavnik kolegija ili mentor rada (iz odnosa, C-23; SRV-IZJAVA-MENTOR): samo izjava vezana uz zapisanu predaju: payload (JCS-bajtovi), `declarationSha256` i `teacherView`; priloženi razgovori samo za čitanje, poruke do `throughSeq`; inače `{state: "none"}` |
| `teacher.declaration-question.get`     | `GET /api/v1/teacher/assignments/{assignmentId}/declaration-question`                                                | `course_teacher`   | pitanje nastavnika uz izjavu i vrijeme zadnje promjene (6.8)                                                                                                                                                                                                      |
| `teacher.declaration-question.put`     | `PUT /api/v1/teacher/assignments/{assignmentId}/declaration-question`                                                | `course_teacher`   | postavlja ili uklanja (`null`) pitanje, tijelo `{question}`; svaka promjena zapisana (6.8)                                                                                                                                                                        |
| `teacher.declaration-attachment.get`   | `GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration/attachments/{externalAttachmentId}` | `course_teacher`   | bajtovi vanjskog priloga iz vezane izjave, kao preuzimanje (dodatak ugovora, nije u nalogu)                                                                                                                                                                       |

Tijelo `student.declaration.put`, zatvoreno:

```
{
  baseVersion,            // 0 za prvi zapis, inače broj zadnje verzije koju je klijent vidio
  revision,
  form: { formId, formVersion, formSha256 },
  ownWork: { confirmed },  // uz confirm: true mora biti true
  humanHelp: { received, entries: [{ text }] },
  ai: {
    use,                   // ili null u nacrtu
    declaredTools: [{ toolLabel, purposeText, phaseText }],
    attachments: [{ conversationId, throughSeq, messagesSha256 }],
    externalAttachmentIds: [uuid]
  },
  confirm,                 // boolean
  questionAnswer           // neobavezno: { questionId, text } ili null (6.8)
}
```

Klijent ne šalje `reason`, `recorded`, `principalId`, `confirmedAt` ni ID ustanove; svaki takav ključ je nepoznat i daje `invalid_input`. Obvezne priloge klijent mora navesti; poslužitelj ih ne dodaje sam, jer student potvrđuje točno ono što je vidio.

### 7.2 `teacherView` i pravilo 5

`teacherView` računa jedna funkcija iz payloada i spremljenih poruka do `throughSeq`. `teacher.declaration.get` i `student.declaration.get` (u stanju `bound`, i kao pregled prije potvrde) vraćaju njezin izlaz bajt-jednak za istu verziju. Funkcija:

- prikazuje razlog `transferred_deleted` kao `transferred` odnosno `pasted_known` ([OD-7]); podatak o kasnije obrisanom tekstu je međustanje i ne smije u nastavnički pregled (pravilo 7);
- ne vraća nijedan nepriloženi razgovor, poruku iza `throughSeq`, nacrt ni prethodnu verziju izjave;
- označava svaku stavku vrstom dokaza (`observed`, `declared`);
- nema zbroja, broja ni udjela prenesenog teksta.

### 7.3 Kodovi grešaka

| Ruta                                                              | Status i kod                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sve                                                               | 401 `unauthorized`; 404 `not_found` (tuđe, nepoznato, neispravno i opozvano daju isti odgovor); 503 `unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `student.declaration.put`, `student.declaration-attachments.post` | `MUTATION_GUARD` (403 `origin_missing`, `origin_mismatch`, `cross_site`; 413 `body_too_large`; 408 `body_timeout`; 400 `content_length_invalid`, `content_length_mismatch`, `body_stream_error`)                                                                                                                                                                                                                                                                                                                                         |
| `student.declaration.put`                                         | 415 `unsupported_media_type`; 400 `invalid_json`; 422 `invalid_input` (oblik, nepoznat ključ, granica, izjavni tekst); 422 `invalid_attachment` (tuđi, nepostojeći ili razgovor drugog zadatka, nepoznat vanjski prilog); 409 `declaration_conflict` `{currentVersion}`; 409 `stale_revision` `{currentRevision}`; 409 `form_outdated`; 409 `incomplete` (potvrda bez `ownWork.confirmed` ili bez `ai.use`); 409 `mandatory_attachment_missing` `{conversationIds}`; 409 `attachment_stale` `{conversationIds}`; 409 `already_submitted` |
| `student.declaration-attachments.post`                            | 415 `unsupported_media_type` (format izvan `EXTERNAL_FORMATS`); 422 `invalid_input` (UTF-8, BOM, kontrolni znak, zaglavlje PDF-a, prazno tijelo); 409 `too_many_attachments`; 409 `attachments_too_large` (zbroj iznad `MAX_EXTERNAL_TOTAL_BYTES`); 409 `already_submitted`                                                                                                                                                                                                                                                              |
| `teacher.declaration.get`, `teacher.declaration-attachment.get`   | samo zajednički retci; prilog koji nije u vezanoj izjavi daje 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `submission.submit.post`                                          | uz postojeće: 409 `blocked` s razlozima `declaration_unconfirmed` i `attachment_stale`, samo kad zadatak traži izjavu (6.3); 503 s fazom `declaration`                                                                                                                                                                                                                                                                                                                                                                                   |

Novi kodovi dobivaju ključeve poruka u katalogu (`error-catalog.json`, `locales/`); tekst prolazi skener.

### 7.4 Izdanja `declaration-v2` i `declaration-v3` (AI-RECORDED-5000)

Baza zapisuje do 5000 prijenosa po izjavi (`assistant.ai_transfer_max()`), a tijelo `declaration-v2` nosi najviše 500 stavki u `ai.recorded`. Ugovor v2 se ne mijenja; dodaju se rute v3 s istim tijelima, pristupom i greškama, uz granicu 5000:

| v2                               | v3                              | Staza v3                                                                             |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `student.declaration-second.get` | `student.declaration-third.get` | `GET /api/v1/student/assignments/{assignmentId}/declaration-v3`                      |
| `student.declaration-second.put` | `student.declaration-third.put` | `PUT /api/v1/student/assignments/{assignmentId}/declaration-v3`                      |
| `teacher.declaration-second.get` | `teacher.declaration-third.get` | `GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration-v3` |

- **Razlog 503 na v2.** Izjava s više od 500 zapisanih prijenosa ne stane u tijelo v2, pa ruta v2 odgovara zajedničkim 503 `unavailable` umjesto da vrati odrezan popis (student potvrđuje točno ono što je vidio, a nastavnik ne smije dobiti polovičnu izjavu). To je dokumentirano stanje, a ne kvar: poslužitelj ga ne bilježi kao `server_error`. Klijent tada čita rutu v3.
- **Spremanje na v2.** `student.declaration-second.put` takvu izjavu ipak spremi (RPC se izvrši), a samo odgovor je 503; ponovno čitanje ide kroz v3.
- **Iznad 5000.** Odgovor izvan svakog ugovora daje 503 i bilježi se kao `server_error` na studentskim rutama, kao svaki odgovor izvan ugovora.
- **Rubovi u testovima.** `server/http/statement/recorded-5000.integration.test.ts`: 500 (v2 i v3 200), 501 (v2 503 bez zapisa, v3 200), 5000 (v3 200), 5001 (503).

## 8. Pohrana i matrica pristupa (skica, PLAN P-7)

Je li potvrda izjave trajni zapis na poslužitelju, PLAN P-7 ostavlja otvorenim, a PO-17 kaže da izjava ne ide u predaju ([OD-1]). Ugovor predlaže trajni zapis, jer bez njega nema ni priloga razgovora za nastavnika (D-41) ni hasha u potvrdi. Ako vlasnik odobri:

- nova shema `declaration` s tablicama nacrta (jedan redak po studentu, zadatku i rundi), potvrđenih verzija (samo dodavanje; okidač odbija `UPDATE`, `DELETE` i `TRUNCATE`), priloga i vanjskih datoteka (bajtovi u pohrani objekata, ključ iz `contentSha256`);
- svaka tablica `ENABLE` i `FORCE ROW LEVEL SECURITY`; uloga weba nema `INSERT`, `UPDATE`, `DELETE` ni `TRUNCATE`; upis samo kroz `SECURITY DEFINER` RPC sa `search_path = ''` i akterom iz `require_actor()`;
- retci u `db/main/tests/030-institution-access-matrix.sql` za svaku tablicu, politiku i RPC.

| Akter                                     | Nacrt i potvrđene verzije     | Priloženi razgovor            | Nepriloženi razgovor | Vanjska datoteka       |
| ----------------------------------------- | ----------------------------- | ----------------------------- | -------------------- | ---------------------- |
| student vlasnik                           | da                            | da, cijeli                    | da (svoj)            | da (svoja)             |
| drugi student                             | ne                            | ne                            | ne                   | ne                     |
| nastavnik kolegija, prije predaje         | ne                            | ne                            | ne                   | ne                     |
| nastavnik kolegija, nakon predaje         | samo vezana verzija, kroz RPC | da, do `throughSeq`, kroz RPC | ne                   | samo iz vezane izjave  |
| mentor rada, nakon predaje                | samo vezana verzija, kroz RPC | ne (još nije izvedeno)        | ne                   | ne (još nije izvedeno) |
| nastavnik drugog kolegija ili ustanove    | ne                            | ne                            | ne                   | ne                     |
| administrator ustanove, operater, podrška | ne                            | ne                            | ne                   | ne                     |
| worker                                    | samo ID i hash vezane verzije | ne                            | ne                   | ne                     |

Čitanje izjave nastavnika ide u dnevnik pristupa (pravilo 17); površina nije u zatvorenom popisu (PLAN P-5, [OD-10]).

## 9. Sintetički vektor

Sve vrijednosti su izmišljene; UUID-ovi predaje preuzeti su iz vektora potvrde v2. Vektor je izračunan izvan modula (Node `crypto` i neovisno Pythonov `json` i `hashlib`), a implementacijski test uspoređuje sve vrijednosti. Vektor vrijedi tek kad je shema odobrena; promjena sheme mijenja vektor.

Poruke izmišljenog razgovora i njihovi `content_sha256` (SHA-256 UTF-8 bajtova):

- `Primjer izmišljenog odlomka za lekturu.` → `bf39b3419f7625264a0560cf599f9ba46114cd3bde0fc96c0d2f2e1e48d557c6`
- `Izmišljeni odgovor pomoćnika s ispravljenim zarezom.` → `68d50dc2602b63df1f11c57b24a8fc19f4971fc8b9092495d55ff7d563633e3b`

`messagesSha256` za `throughSeq` 2: `4e3b9c6ac3fb78cb2d24ca5d69d6206f4a23e4f03c2f7561ad2dd40dc549dbc5`

Vanjski prilog `text/plain`, 47 bajtova, sadržaj `Izmišljeni ispis razgovora iz vanjskog alata.` i jedan novi redak: `a2851d45f6fc65bb4dc7832a57ea004c345ceab128d1576f61c116969282de90`

Payload JCS (1333 bajta):

```
{"ai":{"attachments":[{"conversationId":"1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b","messagesSha256":"4e3b9c6ac3fb78cb2d24ca5d69d6206f4a23e4f03c2f7561ad2dd40dc549dbc5","reason":"transferred","throughSeq":2},{"byteLength":47,"contentSha256":"a2851d45f6fc65bb4dc7832a57ea004c345ceab128d1576f61c116969282de90","externalAttachmentId":"6e5d4c3b-2a19-4f8e-9d7c-6b5a4f3e2d1c","format":"text/plain","reason":"external_upload"}],"declaredTools":[{"phaseText":"Završna dorada","purposeText":"Lektura uvoda","toolLabel":"Izmišljeni vanjski alat"}],"recorded":[{"aiTransferId":"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","aiTransferSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}],"use":"used"},"assignmentId":"3b7e2f4a-9c1d-4e8b-a5f6-0d2c4b6a8e91","assignmentVersion":1,"confirmedAt":"2026-11-02T10:40:00.123456Z","declarationId":"5d0c6a3e-8f21-4b7a-9c45-1e2f3a4b5c6d","declarationSchema":"ductura-declaration-v1","declarationVersion":1,"documentId":"doc-1","form":{"formId":"fpzg-izjava","formSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","formVersion":1},"humanHelp":{"entries":[{"kind":"language","text":"Izmišljena kolegica pročitala je uvod i predložila kraću rečenicu."}],"received":true},"ownWork":{"confirmed":true},"principalId":"72cd1705-85fc-4754-a382-c2500d038368","revision":7}
```

`declarationSha256`: `f89129ae57b4451a03b41615f3dd1f35a6b7de2841a17535f2ce525c95870638`

`formSha256` i `aiTransferSha256` su namjerno ponovljeni znakovi; nisu hash stvarnog obrasca ni zapisa. `formId` `fpzg-izjava` u vektoru je samo oznaka oblika; testovi izvan vektora koriste `test-izjava` dok [OD-11] nije zatvoren.

## 10. Testovi prije prvog retka koda

Prvi kodni PR M7.5 piše ove testove prije koda. Test koji samo provjerava da nema greške ne dokazuje ništa: svaki mora pasti kad se pravilo prekrši. Svi razgovori, obrasci, imena i tekstovi su izmišljeni (`demo-*`, `sim:*`).

| Sloj                   | Što                                                                                                                                                                                                                                                                                                                                    | Odjeljak  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| jedinica               | vektor iz 9: JCS, `messagesSha256`, `contentSha256` i `declarationSha256`; nekanonski bajtovi, duplikat ključa i nepoznat ključ na svakoj razini odbijeni                                                                                                                                                                              | 1, 9      |
| jedinica               | svaka granica iz 4 na vrijednosti prolazi, a za jedan preko nje se odbija; `MAX_ATTACHED_CONVERSATIONS` ne odbija obvezne razgovore                                                                                                                                                                                                    | 4         |
| jedinica               | izjavni tekst: NFC, prazan i samo razmaci, BOM, osamljeni zamjenski par, C0/C1, bidi, novi redak u jednorednom polju                                                                                                                                                                                                                   | 1.6       |
| jedinica               | vanjski prilog: svaki format iz `EXTERNAL_FORMATS` prolazi, format izvan popisa 415, neispravan UTF-8 i krivo zaglavlje PDF-a 422, prazno tijelo 422                                                                                                                                                                                   | 3         |
| svojstva (fast-check)  | tijelo `put` s ijednim ključem izvan zatvorenog skupa, ili s `reason`, `recorded`, `principalId`, `confirmedAt`, nikad ne dolazi do RPC-a                                                                                                                                                                                              | 7.1       |
| jedinica               | tablica razloga: tri razgovora s odgovorom (iz prvog prijenos, iz drugog lijepljenje `known` pa obrisan zalijepljeni tekst, iz trećeg ništa): obvezna su prva dva, drugi `transferred_deleted`; lijepljenje `not_observed` nije obvezno; prvi razlog po redu kad vrijedi više                                                          | 2.2       |
| integracija            | obvezni prilog se ne može ukloniti: `put` bez njega daje `mandatory_attachment_missing`, i kad je preneseni tekst obrisan                                                                                                                                                                                                              | 2.2       |
| integracija            | zastarjelo blokira potvrdu: kriv `messagesSha256`, nepostojeći `throughSeq`, prijenos iz poruke iza `throughSeq`, novi obvezni razgovor nakon prikaza; poruka iza `throughSeq` bez prijenosa ne blokira                                                                                                                                | 2.3, 2.4  |
| integracija, istodobno | potvrda u kartici A dok kartica B nastavlja isti razgovor: prilog je verzija koju je A vidio ili `attachment_stale`, nikad poruka koju A nije vidio; dva `put` s istim `baseVersion`: jedan uspije, drugi `declaration_conflict`; potvrda i predaja istodobno: predaja veže cijelu prethodnu ili cijelu novu verziju, nikad djelomičnu | 2.4, 5, 6 |
| pgTAP                  | matrica iz 8: nastavnik ne vidi nepriloženi razgovor, poruku iza `throughSeq`, nacrt ni izjavu prije predaje; drugi student i nastavnik drugog kolegija ništa; uloga weba nema izravan upis; okidači nepromjenjivosti; tuđi i nepostojeći ID isti ishod                                                                                | 8         |
| ruta                   | `teacher.declaration.get` prije predaje daje `{state: "none"}` i ne otkriva nacrt; nakon predaje vraća samo vezanu verziju; `teacher.declaration-attachment.get` za nepriloženu datoteku 404                                                                                                                                           | 7         |
| ruta                   | pravilo 5: `teacherView` iz studentove i nastavnikove rute bajt-jednak za istu verziju; `transferred_deleted` se nastavniku ne prikazuje                                                                                                                                                                                               | 7.2       |
| integracija            | predaja: zadatak bez zahtjeva za izjavu predaje se i bez izjave, i sa zastarjelom, i uz grešku čitanja izjave (`declarationSha256` `null`); zadatak sa zahtjevom odbija s `declaration_unconfirmed` i `attachment_stale` (kad postavka postoji)                                                                                        | 6.3       |
| integracija            | odjava nakon zahtjeva ne mijenja vezanu izjavu; opoziv prije zapisa blokira finalizaciju, vezana verzija ostaje; produljenje ne mijenja vezanu izjavu; `confirmedAt` nakon `dueAt` ne mijenja `afterDeadline`                                                                                                                          | 6.5       |
| jedinica               | vektor potvrde v2 iz `submission-receipt-v2.md` ostaje bajt-jednak                                                                                                                                                                                                                                                                     | 6.4       |
| jedinica               | oblik odgovora nema polja zbroja, udjela ni oznake; skener zabranjenih izraza nad novim ključevima u `locales/`                                                                                                                                                                                                                        | načela    |

## 11. Redoslijed izvedbe

Svaki korak je zaseban kritični PR, tek nakon odobrenja ugovora:

1. domena: shema v1, parser, granice, vektor i tablica razloga (bez baze);
2. migracija sheme `declaration` s RLS-om, okidačima i pgTAP matricom (traka S-B);
3. RPC-ovi nacrta, potvrde i vanjskog priloga s integracijskim testovima;
4. rute iz 7 i ugovori ruta (traka S-A), lažni dev server i vektori ruta;
5. veza s predajom: expand migracija na `submission_request`, provjera svježine, potvrda v3 ili manifest prema [OD-2];
6. M9.5: proizvođač priloga iz sheme `assistant` i integracijski dokaz (nakon ai-request-v1).

## Poznate granice

- Razlog `transferred_deleted` traži tekst događaja, a on postoji tek pri replayu. Izračun pripada rekonstrukciji pri predaji ili čitanju, ne prihvatu odsječka (odluka od 17. 10. o prihvatu bez replaya).
- Tekst vanjskog ispisa nije provjerljiv. Ductura sprema bajtove i hash; što piše u ispisu, izjavljuje student.
- Lijepljenje iz odgovora pomoćnika koje poslužitelj primi tek nakon brisanja odgovora dobiva `not_observed` (evidence-segment-v4), pa taj razgovor nije obvezan. Ishod je lažno negativan, nikad lažno pozitivan.
- Izjava se veže uz jednu reviziju. Svaka izmjena teksta nakon potvrde traži novu potvrdu (ako se prihvati [OD-15]).

## Odluke vlasnika (21. 11. 2026.)

Zapis: Ductus#2012 (c.7054485848, c.7054511795 i zapis za OD-4, OD-11, OD-12). Ove odluke zatvaraju otvorena pitanja ispod.

- **OD-1:** trajni zapis izjave na poslužitelju i hash izjave u potvrdi predaje, kako predlaže ugovor (odjeljak 8). Izjava i dalje nije dio hashiranih bajtova dokumenta.
- **OD-2:** mogućnost A iz odjeljka 6.4.
- **OD-3:** `EXTERNAL_FORMATS` = `text/plain`, `application/pdf`. Dubinska provjera PDF-a nije u v1.
- **OD-4:** sve predložene vrijednosti iz odjeljka 4 postaju konstante: 2 097 152 B po vanjskom prilogu, 10 vanjskih priloga, 10 485 760 B ukupno, 50 razgovora `student_added`, 20 unosa ljudske pomoći, 20 alata, 2000 znakova izjavnog teksta, 200 znakova polja alata.
- **OD-5 do OD-10, OD-13 do OD-16:** prihvaćeni prijedlozi kako su zapisani u ugovoru.
- **OD-11:** tekst obrasca izjave je verzionirana datoteka uz pravila fakulteta u `config/faculties/`, mijenja se samo PR-om koji odobri vlasnik (kao prekidač OC-1). `formSha256` je SHA-256 bajtova te datoteke. Dok službeni tekst FPZG-a nije u repou, postoji samo izmišljeni obrazac `test-izjava` u testovima, a sučelje koristi neutralan naziv „Izjava”.
- **OD-12:** vlasnik je odluku prepustio orkestratoru. Unos ljudske pomoći je `{ kind, text }` sa zatvorenim skupom vrsta (odjeljak 1.4) i obveznim kratkim opisom; uputa uz polje, bez provjere osobnih podataka.

Odluka vlasnika 23. 11. 2026. (PIL-K-IZJAVA-SRV, pregled WEB #492): (a) tehnički neuspjela potvrda izjave ne smije dopustiti predaju (PRODUCT §5, pravilo 11); (b) izjava se provjerava na poslužitelju; (c) uz OD-6 izjava je obavezna samo kad je zadatak traži postavkom, a za pilot je ta postavka uključena. Izvedba: odjeljak 6.7.

Odluka vlasnika 23. 11. 2026. (NF-5, pitanje 3: „Da”; zapis Ductus#2055 c.7114546002): pitanje nastavnika uz izjavu je u pilotu; jedno neobavezno pitanje po zadatku i neobavezan odgovor studenta koji ne blokira predaju i ne ulazi u ocjenu. Izvedba: odjeljak 6.8.

Odluka vlasnika 25. 11. 2026. (zapis Ductus#2055 c.7149114297): mentor rada vidi izjavu diplomskog rada. Izvedba (SRV-IZJAVA-MENTOR, migracija `20261219220000_mentor_declaration_read.sql`): `app.teacher_declaration` pušta nastavnika kolegija i mentora rada; pristup nastaje samo iz odnosa `institution.mentorship` (`audit.reader_role` = `mentor`, student je student tog mentorstva), kao kod `app.teacher_declaration_answer`. Čitanje se upisuje u dnevnik pristupa s ulogom `mentor`. Deklaracija `access` rute ostaje `course_teacher`, jer provjera `contracts:breaking` ne dopušta promjenu `x-access` ni `summary` postojeće rute (isto pitanje kao u `mentorship-consultations-v1.md`); stvarni pristup određuje baza.

## Otvorena pitanja

Oznake [OD-n] vrijede samo u ovom ugovoru. Pitanja označena „blokira kod” moraju biti zatvorena prije koraka koji ih treba.

- **[OD-1] Trajni zapis izjave (PLAN P-7, PO-17), blokira kod.** Ugovor predlaže trajni zapis i hash izjave u predaji. PLAN P-7 to ostavlja otvorenim, a SRV-19 navodi PO-17 („izjava i napomene ne idu u predaju”). Nalog orkestratora za ovaj zadatak traži hash izjave u potvrdi. Nesklad je otvoren; po pravilu stroža stavka vrijedi, ugovor ništa ne gradi dok vlasnik ne odluči.
- **[OD-2] Potvrda v3 ili manifest, blokira korak 5.** Preporuka A (odjeljak 6.4).
- **[OD-3] Popis vanjskih formata (M7.5-P02), blokira korak 1.** Izvor ne određuje vrijednosti. Prijedlog `text/plain` i `application/pdf`; otvoreno je i treba li dubinska provjera PDF-a prije prikaza nastavniku.
- **[OD-4] Brojčane granice, blokira korak 1.** Sve vrijednosti u odjeljku 4 označene [OD-4] su prijedlog, ne odluka.
- **[OD-5] Poveznica za dijeljenje.** D-77 je navodi, a Q22 traži zamrznutu verziju. Ugovor je u v1 ne prima kao prilog (stroža stavka). Otvoreno: smije li student poveznicu navesti kao izjavni tekst u `declaredTools`.
- **[OD-6] Blokada predaje (D-129 uvjetno, PLAN pitanje P-1).** Ductusov `ai-request-v1` kaže da se predaja sa zastarjelim prilogom odbija s `attachment_stale`. Pravilo 11 dopušta blokadu samo kad zadatak traži izjavu koju propisuje fakultet, a D-129 nije potvrđen. Ugovor primjenjuje strožu stavku (odjeljak 6.3): dok postavka ne postoji, izjava nikad ne blokira predaju. Posljedica: predaja bez svježe izjave nastavniku ne daje razgovore.
- **[OD-7] `transferred_deleted` i pravilo 7.** Razlog otkriva da je preneseni tekst kasnije obrisan, a to je međustanje koje ne smije u nastavnički pregled. Ugovor ga nastavniku prikazuje kao `transferred` ili `pasted_known`. Otvoreno: treba li taj razlog uopće postojati, jer obveznost je ista.
- **[OD-8] Definicija „obrisanog” teksta.** Ugovor predlaže: nijedan tekst događaja prijenosa ili lijepljenja `known` iz razgovora nije neprekinut podniz teksta revizije. Djelomično brisanje tada ne daje `transferred_deleted`.
- **[OD-9] Pitanje za refleksiju (D-40, PLAN P-7).** Nije u v1.
- **[OD-10] Dnevnik pristupa (pravilo 17, PLAN P-5).** Prijedlog: nova površina `declaration` u `student.access-log.get`, što je glavno izdanje te rute.
- **[OD-11] Izvor teksta obrasca, blokira korak 1.** Obrasca nema u konfiguraciji ovog repoa. Otvoreno: gdje stoji, tko ga objavljuje, kako se računa `formSha256` i kada doslovni naziv smije u sučelje (korak P-1, ✓ B-5).
- **[OD-12] Ljudska pomoć (R-09).** Slobodni unosi ili zatvoren skup vrsta pomoći; kako izbjeći tuđe osobne podatke u unosu (uputa uz polje, ne provjera).
- **[OD-13] Runde (D-28, D-263 Q08).** Izjava po rundi; do M7.1-P07 jedna po studentu i zadatku.
- **[OD-14] Prefiks sheme.** Ugovor predlaže `ductura-declaration-v1` za novi format; postojeći formati u ovom repou i dalje nose `ductus-`. Prefiks ulazi u hash, pa se mora odlučiti prije koda.
- **[OD-15] Izjava i revizija.** Ugovor veže izjavu uz reviziju, pa svaka izmjena teksta nakon potvrde traži novu potvrdu. Druga mogućnost je vezati izjavu samo uz priloge i zapis prijenosa.
- **[OD-16] Nazivi razloga.** Ductusov `ai-request-v1` koristi `transfer` i `student_added`; nalog za ovaj zadatak `transferred`, `pasted_known`, `transferred_deleted`, `student_added` i `external_upload`. Ugovor slijedi nalog; usklađenje ai-request-v1 pripada M9.5 ili njegovu reviewu.
- **Nesklad oznaka u planu.** U `PLAN-MIGRACIJE.md` „P-1” označava i korak izmjene pravila proizvoda i pitanje „Pravila predaje zadatka”. Ovaj ugovor piše „korak P-1” za prvo i „pitanje P-1” za drugo.
