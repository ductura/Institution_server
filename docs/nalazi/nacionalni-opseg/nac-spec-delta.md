# NAC-SPEC-DELTA: prijenos razlika umjesto cijelog dokumenta pri spremanju

Status: **PRIJEDLOG, samo dokument.** Mijenja ugovor, pa se ništa od ovoga ne gradi prije Danielova „da” (odluka 27. 11. 2026.: faza 1 je mjerenje, bez promjene ugovora). Ovaj dokument nastavlja [nac-f2-opt-izbor.md](nac-f2-opt-izbor.md) i oslanja se na mjerenje iz [sat-pisanja.md](sat-pisanja.md). Cilj projektiranja je oko 15 000 aktivnih pisaca uz 2x rezervu; 150 000 je test izdržljivosti.

## 1. Problem (izmjereno)

Jedan sat pisanja jednog studenta (suha proba, izmišljeni podaci): 2017 zahtjeva, 40,7 MB prometa, 274 potpisa. Promet je gotovo sav ponavljanje cijele snimke dokumenta:

- `evidence.commit.post` uz svaki segment nosi i `document` (cijela kanonska snimka u base64): 1 992 B do 165 470 B po spremanju, zajedno 32,5 MB poslano;
- `live.document.put` šalje JCS bajtove cijele snimke najviše jednom u sekundi (do 2 MiB), a `live.document.get` 200 vraća cijelu snimku: 10,3 MB primljeno.

Promet zato raste s veličinom dokumenta, a ne s brojem utipkanih znakova. Segment u istom zahtjevu već nosi korake uređivanja (`ductus-edit-steps-v1/-v3/-v4`) i `initialDocumentHash` / `finalDocumentHash`, pa je snimka u zahtjevu **suvišna za sadržaj**; trenutačno služi samo kao provjera (`service.ts`: `snapshot.sha256 !== s.finalDocumentHash` daje `document_mismatch`) i kao tekst koji server sprema uz reviziju.

Što nije izmjereno (traži lokalni stog, 1 pa 100 korisnika; Graditelj): CPU cijena ponavljanja koraka na serveru, veličina odgovora, vrijeme potvrde. Brojke u ovom dokumentu su stoga izvedene iz modela, ne obećanje; mjerilo nakon izmjene je isti scenarij i isti stroj prije i poslije.

## 2. Što se ne mijenja (nepromjenjive točke)

- Segment, njegov lanac (`predecessorSegmentHash`, `sequenceFrom/To`), potpisana potvrda v2 (jedna po spremanju) i JCS hash ostaju bajt za bajt isti. Delta ne dira dokaz, samo prijevoz dokumenta.
- SYNCED se prikazuje samo uz potpisanu potvrdu (B-6); delta ne uvodi novo stanje „spremljeno”.
- Nepoznato polje i neispravan korak su i dalje odbijeni (B-8); server ne prihvaća ništa što ne može sam ponoviti.
- Predaja ostaje `{documentId, revision}`; server rekonstruira reviziju iz zapisa (`submission-reconstruction.ts`).
- Klijent nikad ne piše izravno u evidenciju; samo kroz rute.

## 3. Prijedlog: spremanje s razlikom i povremenom potpunom kontrolnom točkom

### 3.1 Oblik zahtjeva

`evidence.commit.post` ostaje na istom putu; tijelo postaje unija dvaju oblika po zatvorenom polju `kind`:

| `kind`       | Polja uz `documentId`, `clientTransactionId`, `baseRevision`, `segments` | Kada                                            |
| ------------ | ------------------------------------------------------------------------ | ----------------------------------------------- |
| `full`       | `document` (kao danas)                                                   | kontrolna točka; uvijek dopuštena               |
| `delta`      | `baseDocumentHash` (SHA-256 snimke revizije `baseRevision`)              | zadano; bez `document`                          |

- Oblik bez `kind` ostaje valjan i znači `full` (stari klijenti rade; aditivna promjena, ne major). Time se `contracts:breaking` ne okida, uz uvjet da se `document` u shemi pretvori iz obaveznog u jedan od dva oblika bez promjene postojećeg oblika; to treba potvrditi provjerom prije izgradnje.
- `baseDocumentHash` je isti broj kao `segment.initialDocumentHash`; dupliciranje je namjerno: server odbija zahtjev ako se ne poklapaju, pa greška klijenta nikad ne postane tiha razlika.
- Granica tijela `MAX_COMMIT_BODY_BYTES` ostaje; delta je u praksi malena (jedan segment).

### 3.2 Što server radi s razlikom

1. Isti koraci kao danas do provjere segmenta i konteksta (zaštite, profil, `too_large`, vrsta rada).
2. Učita snimku revizije `baseRevision` (već u bazi uz reviziju) i provjeri da joj je hash jednak `initialDocumentHash`.
3. Ponovi korake segmenta nad njom istim ponavljačem koji koristi rekonstrukcija (`replayEvidenceSegmentsV2`; za slajdove i tablice njihovi ponavljači).
4. Kanonski oblik rezultata mora imati hash `finalDocumentHash`; inače `document_mismatch` (422), kao danas.
5. Rezultat sprema kao snimku nove revizije (isti tekst kakav bi poslao klijent). Time čitanje, `evidence.open`, živi prikaz i predaja ne mijenjaju ni redak.

Redoslijed provjera `stale_base` → `chain_conflict` → `invalid` → `not_continuous` ostaje (F-099) i radi se prije ponavljanja koraka, da skup izračun ne bude vrata za zahtjeve koji će ionako biti odbijeni.

### 3.3 Povremena potpuna kontrolna točka

Klijent šalje `full` kad god vrijedi jedno od:

- svaka `N`-ta revizija (prijedlog `N = 50`, usklađeno s `RECONSTRUCTION_CHECKPOINT_INTERVAL` radnika, da se kontrolna točka klijenta i radnika poklapaju);
- prvo spremanje nakon otvaranja rada (`evidence.open` ionako vraća cijelu snimku);
- prvo spremanje nakon prekida veze ili neuspjelog pokušaja (vidi 3.5);
- nakon odgovora `delta_base_mismatch` (3.4).

Kontrolna točka je jedini put kojim se klijentova i serverova snimka ponovno vežu, pa ograničava štetu svake pogreške na najviše `N` spremanja. Server je ne smije tražiti češće nego što je navedeno; `full` je uvijek prihvatljiv.

### 3.4 Greške

Postojeći kodovi ostaju. Dodaje se jedan zatvoreni odgovor 409 `delta_base_mismatch` s postojećim `WorkState`: snimka revizije koju server drži nema hash `baseDocumentHash`. Klijent tada šalje isto spremanje kao `full`; potvrda i lanac se ne mijenjaju. Novi kod greške na postojećoj ruti je promjena ugovora (vidi „Odluke”), a bez njega se isti slučaj može izraziti postojećim `document_mismatch`; razlika je u tome što klijent tada ne može razlikovati „kriva razlika” od „kriva baza”.

### 3.5 Ponavljanje, dvostruki zahtjevi i prekid veze

- Idempotencija ostaje po (`documentId`, `clientTransactionId`): ponovljen zahtjev vraća `duplicate`, bez ponovnog ponavljanja koraka. `txid_reused` ostaje za isti ključ s drugim segmentom.
- Zahtjev izgubljen u prekidu veze šalje se ponovno kao isti zahtjev. Kad se red nakupi (spremanja se redaju do povratka veze), **svaki ostaje svoj segment i svoja delta**; klijent ne spaja segmente jer bi to promijenilo lanac i potvrde. Ako je neki odgovor izgubljen, klijent ne zna je li revizija nastala: zato prvi zahtjev nakon prekida ide kao `full`, a odgovor `duplicate` ili `stale_base` ga usmjerava (kao danas).
- Redoslijed je strog: `sequenceFrom = lastSequenceTo + 1` i `initialDocumentHash` mora biti hash trenutne revizije. Delta ne može preskočiti ni zamijeniti segment.

## 4. Prikaz uživo (`live.document.*`)

Uživo je predmemorija zadnjeg stanja, ne dokaz, pa je tu sloboda veća, ali ista načela:

- `live.document.put` dobiva drugi oblik: razlika od posljednjeg prihvaćenog žetona (`If-Match: "<token>"`) umjesto cijele snimke. Server je primjenjuje na spremljeno stanje, provjerava valjanost i hash rezultata te izdaje novi žeton. Nepoznat ili star žeton: 409 `conflict` s trenutnim žetonom (postojeće ponašanje), a klijent tada šalje cijelu snimku (`If-None-Match: *` ili `If-Match` s `full`).
- Cijela snimka uživo šalje se i periodično (prijedlog svakih 30 objava), da pokvareni lanac razlika ne traje.
- `live.document.get` 200 ostaje cijela snimka (čitatelji nemaju stanje; čitanja 304 već nose zanemariv promet). Razlika za čitatelje je poseban, kasniji korak i ne ulazi u ovu odluku.
- Nakon predaje bajtovi uživo su predana revizija, kao danas (`ductus-live-state: submitted`).

## 5. Rekonstrukcija

- Zapis koji se čuva ne mijenja se: segmenti, lanac, potvrde, snimka po reviziji i kontrolne točke radnika (`evidence.reconstruction_checkpoint`). Rekonstrukcija zato radi isto kao danas: čita najnoviju kontrolnu točku prije tražene revizije i ponavlja samo segmente iza nje.
- Klijentove `full` kontrolne točke nisu dokaz: dokaz je lanac segmenata. Snimka koju je server sam izračunao ponavljanjem postaje snimka revizije samo ako joj hash odgovara `finalDocumentHash` iz lanca. Time je tvrdnja „server je ponovio korake i dobio isti dokument” provjerljiva neovisno o klijentu.
- Replay (`evidence.replay.post`) nije dotaknut: već vraća bajtove segmenata i početni dokument, a ne snimke po reviziji.

## 6. Predaja i završno stanje

- `submission.submit.post` i `submission.submit-second.post` ostaju `{documentId, revision}`. Server rekonstruira reviziju iz zapisa i uspoređuje s `content_hash`; jedino što se mijenja je izvor `content_hash` revizije: to je i dalje snimka koju je server upisao u istoj transakciji kao potvrdu.
- Predana revizija mora imati potpisanu potvrdu zadnjeg segmenta; delta to ne ublažava. Segment bez potvrde (202 `pending_signature`) i dalje blokira predaju (`blocked: segment_unsigned`).
- Završno stanje: tekst predane revizije identičan je onom koji bi nastao slanjem cijelih snimaka. To je glavni kriterij prihvaćanja (6.1).

### 6.1 Kriteriji prihvaćanja (za izgradnju, kad Daniel odobri)

1. **Isti ishod:** za isti niz izmišljenih izmjena, spremanje sa `full` i sa `delta` daju isti `finalDocumentHash`, istu snimku po reviziji i istu potpisanu potvrdu (osim vremena `acceptedAt`).
2. **Test koji bi pao bez izmjene:** zahtjev `delta` bez `baseDocumentHash`, s krivim hashom, s `baseDocumentHash` različitim od `initialDocumentHash`, s korakom koji daje drugi `finalDocumentHash` i s većim `sequenceFrom` od očekivanog mora biti odbijen, a nijedan red ne smije nastati.
3. **Tuđe je nepostojeće:** `delta` za rad drugog studenta i za rad druge ustanove daje 404 kao danas, bez razlike u odgovoru i vremenu prema nepostojećem radu.
4. **Prekid veze:** niz spremanja složenih u red i poslanih po povratku, uz izgubljen odgovor usred niza, završava istom revizijom i istim lancem kao bez prekida.
5. **Stari klijent:** zahtjev bez `kind` radi kao danas (vektori ugovora ostaju zeleni).
6. **Rekonstrukcija i predaja** nad radom sastavljenim samo od `delta` spremanja (uz kontrolnu točku svakih `N`) daju isti rezultat kao nad radom od `full` spremanja.
7. **Mjerenje:** isti scenarij sat-pisanja prije i poslije, isti stroj; bez obećanog postotka. Očekivanje iz modela je da promet po spremanju prestane ovisiti o veličini dokumenta, osim kod kontrolnih točaka.

## 7. Rizici i granice

- **CPU na serveru:** ponavljanje koraka prenosi trošak s mreže na server, unutar transakcije spremanja. Nije izmjereno; mjeri se prije odluke o `N` i o tome ide li ponavljanje u transakciji ili odgođeno kod radnika. Odgođeno ponavljanje bi ostavilo reviziju bez snimke neko vrijeme, pa čitanje i predaja moraju znati čekati; to je veća promjena i ovdje se ne predlaže.
- **Dva ponavljača:** server mora imati ponavljač za svaku vrstu rada (tekst v1 do v4, slajdovi, tablice). Prvi korak izgradnje može pokriti samo tekst, a ostale vrste ostaju na `full` dok ne dobiju svoj ponavljač.
- **Veličina zapisa se ne mijenja:** segmenti i snimke po reviziji i dalje se spremaju; ušteda je u prometu, ne u pohrani.
- **Mjerilo 15 000 pisaca:** bez lokalnog stoga ne može se tvrditi da je promet jedino usko grlo; ovaj prijedlog rješava samo ono što je izmjereno.

## 8. Odluke koje treba Daniel

1. **Smije li se otvoriti izgradnja** (spremanje s razlikom i kontrolnom točkom, 3.1 do 3.5)? Pretpostavka ovog dokumenta: da, kao aditivna promjena bez majora.
2. **Novi kod 409 `delta_base_mismatch`** na postojećoj ruti ili ponovno korištenje `document_mismatch`? Novi kod je promjena ugovora; preporuka: dopustiti ga, jer klijent bez njega ne zna kako se oporaviti.
3. **Prikaz uživo s razlikom (odjeljak 4)** u istom koraku ili zasebno? Preporuka: zasebno, nakon spremanja (manji rizik, dokaz se ne dira).
4. **Interval kontrolne točke `N`:** 50 (kao radnik) ili izmjeriti pa odlučiti. Preporuka: 50, ponovno razmotriti nakon mjerenja CPU-a.
5. **Ponavljanje unutar transakcije** ili odgođeno (7). Preporuka: unutar transakcije, uz mjerenje.

Do odgovora ne gradi se ništa; nema promjene ugovora, migracije ni koda.

## 9. Pretpostavke ovog dokumenta

- Server već drži snimku svake revizije (`snapshotText` se upisuje uz commit) i ima ponavljače koraka kojima radnik rekonstrukcije već radi (`replayEvidenceSegmentsV2`); nisam pokretao taj kod nad stvarnim opterećenjem.
- Stanje klijenta (WEB repo, `migracija/kopija-ductus-front`) nije čitano; način na koji klijent čuva zadnju potvrđenu snimku i red spremanja treba provjeriti u izgradnji. Ritam spremanja je pretpostavka iz [sat-pisanja.md](sat-pisanja.md).
- Brojke u odjeljku 1 su iz tog mjerenja (baza `54d3fd78ce5a`); ovaj PR ih ne ponavlja i ne pokreće ništa.
