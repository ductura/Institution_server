# NAC-SPEC-POTPIS: skupni potpis potvrda umjesto KMS potpisa po segmentu

Status: **PRIJEDLOG, samo dokument.** Mijenja ugovor (novi oblik potvrde), pa se ništa od ovoga ne gradi prije Danielova „da” (odluka 27. 11. 2026.: faza 1 je mjerenje, bez promjene ugovora, bez staginga i bez testa opterećenja izvan lokalne suhe probe). Nastavlja [nac-spec-delta.md](nac-spec-delta.md) (promet) i oslanja se na [sat-pisanja.md](sat-pisanja.md). Cilj projektiranja je oko 15 000 aktivnih pisaca uz 2x rezervu; 150 000 je test izdržljivosti.

## 1. Problem (izmjereno i izvedeno)

Danas se svaka potvrda segmenta potpisuje zasebno: `createSignPendingReceipt` (`server/evidence/sign-pending-receipt.ts`) šalje 59 bajtova ulaza D-92 portu `SigningKeyProvider`, koji u produkciji zove AWS KMS (`server/external/keys/aws-kms-ed25519-signer.ts`, ključ `ECC_NIST_EDWARDS25519`). Jedan KMS poziv znači jedan segment.

- Izmjereno ([sat-pisanja.md](sat-pisanja.md), suha proba): jedan sat pisanja jednog studenta daje **274 spremanja, dakle 274 potpisa**.
- Izvedeno (aritmetika, ne mjerenje): ako svi pišu istodobno po tom scenariju, 274 / 3600 s = 0,076 potpisa/s po piscu, pa je KMS opterećenje **oko 1 142 potpisa/s za 15 000 pisaca, oko 2 283/s uz 2x rezervu i oko 11 417/s za 150 000**.
- Nije izmjereno: kvota KMS-a za ovu vrstu poziva, latencija poziva i ponašanje pod opterećenjem. Brojku kvote nisam pronašao u repozitoriju i ne navodim je iz sjećanja; čita se iz AWS Service Quotas za račun i regiju produkcije (to je radnja za Daniela ili platformu, ne za pisca). Zahtjev je jasan i bez nje: potpis po segmentu raste linearno s brojem pisaca i dijeli kvotu računa.

Potpis po segmentu zato je izravno vezan uz ono što se ne može jeftino skalirati (vanjska usluga s kvotom i latencijom), dok je ostalo (hash, lanac, pohrana) lokalan rad.

## 2. Što se ne mijenja (nepromjenjive točke)

- Segment, njegov lanac i JCS hash ostaju bajt za bajt isti. Predmet potpisa je i dalje isti 59-bajtni ulaz D-92 (hash sadržaja potvrde); mijenja se samo **tko i koliko puta** ga potpisuje.
- Nijedan KMS ključ ne napušta KMS (D-71). Ne uvodi se novi ključ ni novi algoritam: Ed25519 nad istim ključem domene.
- SYNCED se prikazuje samo uz potpisanu potvrdu koju klijent sam provjeri (B-6). Potvrda s dokazom pripadnosti i potpisanim korijenom je potpisana potvrda; „poslano” i „spremljeno bez potvrde” ne postaju SYNCED.
- Stare potvrde v2 (potpis po segmentu) ostaju valjane zauvijek i ne potpisuju se ponovno. Verifikator mora prihvaćati obje vrste.
- Dnevni korijen (`server/evidence/daily-root`, D-93, SRV-1311) i stablo `evidence-log-merkle` (RFC 9162) ostaju kakvi jesu; ovaj prijedlog ih **ponovno koristi**, ne mijenja.
- Klijent nikad ne piše izravno u evidenciju; samo kroz rute.

## 3. Prijedlog: Merkle korijen po prozoru, dokaz pripadnosti po segmentu

### 3.1 Ideja

Server ne potpisuje svaku potvrdu, nego **korijen stabla svih potvrda jednog prozora** jedne domene dokaza. Potvrda koju klijent čuva postaje: sadržaj potvrde + dokaz pripadnosti (put kroz stablo) + potpisani zapis korijena. Klijent provjerava lokalno, bez poziva servera: (1) izračuna list iz digesta potvrde, (2) složi put do korijena, (3) provjeri da je korijen jednak onom u potpisanom zapisu, (4) provjeri potpis zapisa ključem domene. Jedan KMS poziv pokriva cijeli prozor, bez obzira na broj segmenata.

### 3.2 Prozor

- **Prozor** je par (`evidenceDomainId`, interval): domena jer se potvrde već potpisuju ključem svoje domene (`store.receiptKeys(payload.evidenceDomainId)`), pa se stabla različitih domena ne miješaju.
- Predloženo trajanje `W = 1 s` (parametar, ne konstanta ugovora). Prozor se zatvara kad istekne `W` ili kad ima `L_max` listova (prijedlog 16 384), što god prije; prozor bez potvrda se ne potpisuje.
- Pripadnost prozoru je određena **jednom**, pri zatvaranju, i sprema se (jedinstveni ključ po potvrdi): segment ne može biti u dva prozora, a zatvoren prozor se nikad ne mijenja. Time je potpis deterministički nad istim popisom listova i ponovljeni pokušaj (pad radnika usred potpisa) daje isti zapis, isto kao danas za potpis po potvrdi.

### 3.3 Stablo i zapis korijena

- List i unutarnji čvor kao u `evidence-log-merkle.ts`: `SHA-256(0x00 ‖ D)` i `SHA-256(0x01 ‖ lijevo ‖ desno)`, bez udvostručavanja zadnjeg lista, redoslijed `acceptedAt` pa UTF-8 bajtovi `receiptId`. `D` je 32-bajtni digest potvrde. Ne piše se novo stablo.
- Zapis korijena: `{ domain, windowStart, windowEnd, root, count, keyId }`. Potpisuje se Ed25519 portom ključeva nad `UTF-8("ductura.evidence-window-root.v1") ‖ LF ‖ JCS(zapis)`. Posebna oznaka formata razdvaja ovaj potpis od potpisa potvrde i od dnevnog korijena (`ductura.evidence-daily-root.v1`): potpis jedne vrste ne smije proći kao druga.
- Zapis se sprema nepromjenjivo kroz port `external/storage` (`putImmutable`) kao i dnevni korijen; drukčiji zapis za isti prozor je sukob (analogno `daily_root_conflict`) i ništa ne prepisuje.

### 3.4 Oblik potvrde (nova shema, uz v2)

Nova shema potvrde (radni naziv `ductus-evidence-receipt-v3`; ime i polja treba uskladiti s rezervacijom formata, `format-reservation.test.ts`) nosi isti `payload` kao v2 plus:

| Polje        | Sadržaj                                                         |
| ------------ | --------------------------------------------------------------- |
| `inclusion`  | `{ index, treeSize, proof: [32-bajtni hashevi, base64url] }`    |
| `windowRoot` | zapis korijena iz 3.3 i njegov `signature` (omotnica kao danas) |

Veličina dokaza je `ceil(log2(n)) * 32` bajtova: 4 hasha (128 B) za 10 listova, 10 (320 B) za 1 000, 14 (448 B) za 16 384. Uz base64url oko 4/3 toga. To je uz potvrdu od nekoliko stotina bajtova zanemarivo; ne raste linearno s brojem pisaca.

Nova shema je **aditivna**: stara shema i stare rute ne mijenjaju se (kao `submission.submit-second.post` uz `submission.submit.post`), jer `contracts:breaking` (`server/contracts/breaking.ts`) ne dopušta promjenu postojeće sheme potvrde. Je li to nova vrijednost protokola na `evidence.commit.post` (uz postojeće `1` sinkrono i `2` odgođeno) ili nova ruta, odluka je izgradnje po tom pravilu; ovdje se samo traži da stara ruta ostane nepromijenjena (vidi „Odluke”, 1).

### 3.5 Tok spremanja

1. Isti koraci do spremanja segmenta i potvrde bez potpisa (`pending_signature`), kao danas u protokolu 2: segment je spremljen, lanac je valjan, odgovor je 202.
2. Potvrda ulazi u otvoreni prozor svoje domene.
3. Radnik zatvori prozor, složi stablo, **jednom** zove KMS za zapis korijena, provjeri potpis ključem domene iz registra (kao `verifiedReceipt` danas) i spremi zapis; zatim za svaku potvrdu prozora sprema `inclusion`.
4. Klijent ponovi isti zahtjev (kao u protokolu 2) i dobije potvrdu v3 s dokazom; tek sad je SYNCED.

Potpis ne ide u sinkroni put zahtjeva: zahtjev ne čeka KMS, što je već postojeće ponašanje protokola 2.

## 4. Latencija

Vrijeme do SYNCED se mijenja: danas je to (pohrana + jedan KMS poziv); prema prijedlogu je to **do `W` čekanja do zatvaranja prozora + složiti stablo + jedan KMS poziv + čitanje**. Pri `W = 1 s` očekivani dodatak je oko pola sekunde (prosjek), najviše `W`, uz bilo koju latenciju KMS-a koja već postoji. Nije izmjereno; model i mjerenje u 8.

- Veći `W` smanjuje broj KMS poziva i produžava čekanje; manji obrnuto. Pri 15 000 pisaca i, primjera radi, 20 aktivnih domena, to je najviše 20 poziva/s uz `W = 1 s` (jedan po domeni u prozoru), nasuprot 1 142/s danas; broj aktivnih domena nije u repozitoriju pa je 20 pretpostavka za račun, ne podatak.
- Najgori slučaj za kvotu je mnogo malih domena s po jednom potvrdom u prozoru; tada broj poziva teži broju aktivnih domena u sekundi. Granica: **najviše jedan poziv po (domena, prozor)**, a rijetke domene mogu dobiti dulji prozor (odluka 4).
- Ritam pisanja je 1 potvrda svakih 5 do 15 s po piscu (pretpostavka iz [sat-pisanja.md](sat-pisanja.md), ne izmjereno u WEB-u), pa pojedini pisac rijetko ovisi o istom prozoru dvaput.

## 5. Kvote

Formula za izgradnju (ne brojka): `pozivi/s = Σ po aktivnim domenama (prozora u sekundi) = D_aktivnih / W` (gornja granica; stvarno manje jer prozor bez potvrda ne šalje poziv). Uz ostalo opterećenje računa (svi pozivi istog računa i regije dijele kvotu) potreban je prostor od najmanje 2x (rezerva iz cilja).

- Dnevni korijen već troši jedan poziv po domeni na dan; zanemariv u odnosu na ovo.
- Ograničenje broja istodobnih KMS poziva po radniku mora postojati (inače oporavak nakon ispada, 6, može sam probiti kvotu): `maxInFlight` kao parametar radnika, uz iste granice kakve danas ima `MAX_RECEIPT_SIGN_TIMEOUT_MS` (60 000 ms) i `MAX_SIGNATURE_RETRY_ATTEMPTS` (10).
- Kad kvota ipak padne (KMS vrati ograničenje brzine), to je kod transporta `KmsTransportError` kao i svaka druga privremena greška: prozor ostaje zatvoren i nepotpisan, ponovni pokušaj s rastućim razmakom (postojeći `signature-retry.ts`), bez gubitka potvrda.

## 6. Ispad KMS-a

Danas: potvrde ostaju u `pending_signature`, radnik ih pokušava do 10 puta s razmakom do 300 s, zatim ih preuzima `reconcile-pending-receipts`. Klijenti čekaju bez SYNCED-a (B-6). Prijedlog zadržava to ponašanje i sužava posao:

- **Povrat je jeftiniji:** zatvoreni prozori čekaju svoj potpis; oporavak nakon ispada od jednog sata je najviše (3 600 / `W`) × `D_aktivnih` poziva umjesto oko 4,1 milijuna za 15 000 pisaca. Poziva se redom, uz `maxInFlight` iz 5.
- **Zapis prozora je nepromjenjiv:** nepotpisan zatvoren prozor ima fiksan popis listova i fiksan korijen, pa kasniji potpis daje isti zapis; ne smije se dodavati potvrde u već zatvoren prozor da bi se „nadoknadilo” (vidi 3.2).
- **Prozori u ispadu** se ne spajaju automatski: spajanje bi promijenilo korijen već odabranog prozora. Ako Daniel želi manji broj poziva pri oporavku, moguće je zatvarati nove prozore dulje dok ispad traje (do `L_max` ili gornje granice trajanja); to je izbor, ne zadano (odluka 4).
- **Što se ne smije:** potpisivati drugim, lokalnim ključem dok je KMS nedostupan, i označiti SYNCED bez potpisanog korijena. Oba bi slomila D-71 i B-6.
- **Pohrana potpisa:** server drži zapise (postojeći put radnika za potvrde u `pending_signature`) dok korijen nije potpisan; što točno ide u bazu, a što u pohranu objekata, odlučuje izgradnja uz migraciju (RLS i retci pgTAP matrice za svaku novu tablicu).

## 7. Sigurnosna razmatranja (za attack plan prije izgradnje)

Zadatak je kritičan (`server/external/keys` i `server/domain/forensics` imaju floor `critical`), pa prije koda treba attack plan ([ductus-attack-plan]) kao zaseban issue. Početni popis napada koji moraju postati testovi:

1. **Potvrda izvan prozora:** dokaz za list koji nije u korijenu mora pasti (`root_mismatch`); prazan dokaz s `treeSize > 1`, dokaz predug/prekratak za `treeSize`, `index >= treeSize`, i dokaz s hashem koji nije 32 bajta.
2. **Zamjena razina stabla:** unutarnji čvor predstavljen kao list (i obrnuto) ne smije proći; zato prefiksi `0x00`/`0x01` iz `evidence-log-merkle.ts` i test s dokazom koji tretira unutarnji čvor kao list.
3. **Zamjena vrste potpisa:** potpis potvrde v2 se ne smije prihvatiti kao potpis korijena i obrnuto; potpis dnevnog korijena isto (različite oznake formata).
4. **Dvije verzije istog prozora:** dva različita korijena za isti (`domain`, `windowStart`) = sukob koji se otkriva i prijavljuje, ništa se ne prepisuje.
5. **Izostavljena potvrda:** server može propustiti potvrdu iz prozora; klijent tada nema dokaz i ostaje bez SYNCED-a (sigurno), a rekonciliator je mora naći. Test: potvrda spremljena, a nikad ušla u prozor, završi potpisana ili vidljivo zaglavljena.
6. **Vrijeme:** `acceptedAt` potvrde mora biti u `[windowStart, windowEnd)` zapisa; verifikator to provjerava.
7. **Preuzimanje tuđeg dokaza:** čitanje potvrde ostaje isto što i danas (vlasnik rada; tuđe je nepostojeće, 404). Dokaz pripadnosti ne otkriva druge listove: sadrži samo hasheve susjeda, a ne njihove potvrde.
8. **Opis potpisa:** `keyId`/`keyVersion` su nepovjerljiv ulaz (kao u `aws-kms-ed25519-signer.ts`): vrijedi samo ključ s popisa povjerenja domene.
9. **Ponavljanje nakon pada:** isti prozor potpisan dvaput daje iste bajtove, pa je ishod „već potpisano”, ne druga potvrda.

## 8. Mjerenje (faza 1, bez promjene ugovora)

Ništa od donjeg ne mijenja ugovor, a **ne pokreće se** staging ni test opterećenja izvan lokalne suhe probe bez Danielova odobrenja.

1. Prije odluke: dodati u [sat-pisanja.md](sat-pisanja.md) model „KMS poziva po satu i po sekundi” za 1, 100, 15 000, 30 000 i 150 000 pisaca (aritmetika iz odjeljka 1), uz lažni KMS (`test-support/fake-kms`) s konfigurabilnom latencijom.
2. Lokalno (Graditelj, lokalni stog): isti scenarij s 1, pa 100 korisnika, uz bilježenje broja KMS poziva i latencije lažnog KMS-a; to je donja granica koju prijedlog treba smanjiti, ne brojka za produkciju.
3. Za usporedbu nakon izgradnje: isti scenarij i stroj; mjerilo je „KMS poziva po potvrdi” (danas 1) i „vrijeme od 202 do potvrde s dokazom”. Bez obećanog postotka.
4. **Kvota KMS-a** čita se iz AWS Service Quotas (Daniel ili platforma); to je ulaz u odluku 3, a ne nešto što pisac smije pretpostaviti.

## 9. Kriteriji prihvaćanja (za izgradnju, kad Daniel odobri)

1. **Isti dokaz:** za isti niz segmenata, potvrda v3 verificira isti `payloadDigest` kao v2; klijentski verifikator prihvaća v2 i v3 i odbija ono iz 7.
2. **Test koji bi pao bez izmjene:** broj poziva potpisniku za N potvrda jednog prozora je 1 (a ne N); svaka potvrda iz prozora verificira s dokazom; izmijenjen list, krivi `index`, krivi `treeSize`, zamijenjen korijen i krivi ključ moraju biti odbijeni.
3. **Tuđe je nepostojeće:** 404 za potvrdu rada druge osobe i druge ustanove, bez razlike u odgovoru prema nepostojećem.
4. **Ispad KMS-a:** pad potpisnika usred niza daje potvrde bez SYNCED-a; po povratku se svi prozori potpišu, bez promjene korijena i bez dupliciranih zapisa.
5. **Stari klijenti i potvrde:** potvrde v2 i dalje se verificiraju; vektori ugovora ostaju zeleni (`contracts:breaking` bez izuzetka).
6. **Izgradnja je montirana:** radnik zove novi put iz postojećeg `signing-worker` rasporeda, a ne samo test.

## 10. Rizici i granice

- **Latencija do SYNCED:** raste za najviše `W` (4). Nije izmjereno; može biti neprihvatljiva za korisničko iskustvo, što je razlog za odluku 2.
- **Složenost verifikatora na klijentu:** novi kod u WEB repou (provjera puta i korijena) koji mora biti isti bajt za bajt kao na serveru; zato golden vektori (`server/domain/forensics/golden-vectors`) uz izgradnju.
- **Jedna točka:** korijen prozora ovisi o jednoj KMS operaciji; ispad KMS-a zaustavlja SYNCED jednako kao i danas, samo je povrat brži.
- **Pohrana:** ne smanjuje se (potvrde i dalje postoje); dodaju se zapis korijena po prozoru i dokazi.
- **Domena s jednim pisačem:** nema uštede (jedan list, jedan poziv); korist je tamo gdje je mnogo segmenata u istoj domeni.
- **Ne rješava drugi trošak:** promet cijelog dokumenta rješava [nac-spec-delta.md](nac-spec-delta.md); to je neovisan prijedlog.

## 11. Odluke koje treba Daniel

1. **Smije li se otvoriti izgradnja** skupnog potpisa (nova shema potvrde v3, aditivno uz v2; novi protokol ili nova ruta; major se ne traži)? Preporuka: da, nakon mjerenja iz 8.2 i očitane kvote iz 8.4.
2. **Je li prihvatljiv dodatak latenciji do SYNCED** (do `W`)? Preporuka: `W = 1 s`, ponovno razmotriti nakon mjerenja.
3. **Kvota KMS-a:** stvarna vrijednost za produkcijski račun i regiju (ulaz za 5); do tada nema obećanja koliko pisaca stane.
4. **Prozor:** fiksni `W` za sve domene ili dulji za rijetke domene i u ispadu (6)? Preporuka: fiksni `W` na početku, dulji prozor kao kasniji korak.
5. **Dnevni korijen** ostaje nad digestima potvrda (nepromijenjen, preporuka) ili nad korijenima prozora (manje listova, ali mijenja postojeći dokaz).
6. **Attack plan** kao zaseban issue prije koda (kritično, treba ODOBRENO neovisnog pregleda).

Do odgovora ne gradi se ništa; nema promjene ugovora, migracije ni koda.

## 12. Pretpostavke ovog dokumenta

- Pročitano u repozitoriju (baza `4bd4c6e98634`): `server/evidence/sign-pending-receipt.ts`, `sign-within.ts`, `signature-retry.ts`, `server/worker/signing/signing-worker.ts`, `server/external/keys/README.md` i `aws-kms-ed25519-signer.ts` (README), `server/evidence/daily-root/README.md`, `server/domain/forensics/evidence-log-merkle.ts` i `evidence-receipt-verifier.ts` (zaglavlja). Nisam pokretao ništa niti mjerio ikakvo opterećenje.
- Brojke u odjeljku 1 i veličine dokaza su aritmetika nad izmjerenim `274 potpisa/sat` i formulom `ceil(log2(n)) * 32`; provjereno je samo računom, ne na stogu.
- Broj aktivnih domena (20) u odjeljku 4 je primjer računa, ne podatak.
- Ime sheme `ductus-evidence-receipt-v3` je radno; ime koje bi sudaralo s postojećom rezervacijom formata ili s v3 potvrdom predaje (`submission-receipt-v3`) treba izabrati u izgradnji.
- Kanonski opis zadatka u Ductus#2028 ne sadrži NAC-SPEC-POTPIS; vrijedio je opis iz naloga orkestratora.
