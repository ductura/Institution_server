# Udio predanog teksta i oznaka podudaranja s AI odgovorom v1

**Status: ODOBREN.** [Vlasnička odluka od 21. 11. 2026.](https://github.com/danielrisavi77-create/Ductus/issues/2052#issuecomment-7056641810) prihvaća preporuke OC6-1 do OC6-9 iz ovog ugovora. Odluka ima prednost pred ranijim prijedlozima i oznakama otvorenih pitanja u tekstu.

SRV-1220 `udio-i-oznaka-ugovor`, `Risk: critical`. Ugovor bez koda, po obliku `docs/contracts/declaration-v1.md`. Određuje:

1. izračun udjela predanog teksta iz zabilježenih događaja (Ustav v1.6 C-6 (a));
2. oznaku teksta podudarnog s odgovorom AI pomoćnika zabilježenim u Ducturi (C-6 (c));
3. zapis, sheme odgovora, tko vidi, rute, testne vektore i popis testova;
4. napomenu P-B kao obvezno polje prikaza.

Postotak podudarnosti s izvorima (C-6 (b)) nije u ovom ugovoru. Dolazi zasebnim ugovorom kroz D-260 i C-6a, i to samo za izvore koji ispune D-260 t. 5 (P-C).

Izvori:

- Ustav v1.6 C-6, koji je vlasnik doslovno potvrdio 21. 11. 2026. (Ductus#2012 c.7054679537; Drive dokument `1BdTofBG6B1agJnUM3olDQC-tpVnVb9FhSk2_Kd3vnEY`). Smiju se prikazati (a) udio predanog teksta isključivo iz zabilježenih događaja, (b) postotak podudarnosti s izvorima i (c) oznaka teksta podudarnog s odgovorom AI pomoćnika.
- Opis zadatka orkestratora (Ductus#2052, c.7056147951), uz uvjete P-A, P-B i P-C:
  - **P-A:** nema modela detektora.
  - **P-B:** uz svaki postotak i svaku oznaku stoji trajna napomena „nije dokaz autorstva”. Prikaz ne blokira predaju, ne pokreće sankciju, ne ulazi u rangiranje, a student vidi isto što i nastavnik.
  - **P-C:** ovaj val su (a) i (c).
- Odluke vlasnika od 21. 11. (c.7054441152): Q-10 je odgođen; OC-1 (prekidač u `config/faculties`, zadano isključen, mijenja se samo vlasnikovim PR-om); U-4 je isključen do nakon pilota (vidi [OC6-7]).
- Ductus `docs/PRODUCT.md` §5 (pravila 1, 2, 5, 9, 11 i 13 te rječnik); D-44 (vrsta dokaza), D-54 (pripisivanje je pozitivno ili ga nema), D-57 (karta podrijetla bez zbroja), D-58 (poznato podrijetlo i podudaranje s odgovorom pomoćnika), D-41 (nepriloženi razgovori su samo studentovi), D-268 O6.
- Ovaj repo:
  - `server/domain/forensics/evidence-segment-v2.ts`: zatvoren skup izvora događaja v2 do v4, `pasteOrigin`, `ai-transfer`, `import`;
  - `docs/contracts/document-schema-v4.md`: oznake `paste` i `imported`, „tekst je kasnije mijenjan” kao izvedena vrijednost, `textBlocksOf`;
  - `docs/contracts/declaration-v1.md`: oblik ugovora, `teacherView` i pravilo 5;
  - `server/contracts/routes/student.ts` i `teacher.ts`: oblik ruta, `course_teacher`, isti 404 za tuđe, nepoznato i neispravno;
  - `scripts/forbidden-terms/terms.ts`: rječnik zabranjenih izraza.

Gdje ugovor provodi izvor tehničkim izborom, piše „izbor ugovora”. Vrijednost koju izvor ne određuje ugovor ne izmišlja kao konačnu: predložena vrijednost stoji uz oznaku [OC6-n].

## Što ugovor ne odlučuje

- **Pružatelj i model računa** (Q-10, D-194 t. 6 i 7). Izračun ne zove nijednog pružatelja ni model. Ne zna ni za koji je model nastao uspoređeni odgovor.
- **Stvarni AI pružatelj i iznosi** (OA-1, OA-2). Testovi koriste samo izmišljene odgovore (odjeljak 9).
- **Postotak podudarnosti s izvorima** (C-6 (b), D-260, C-6a). Ugovor nema polje, rutu ni rezervirano mjesto za to.
- **Tekst sučelja.** Ugovor daje samo ključeve i zatvorene vrijednosti. Tekst prolazi katalog poruka (`locales/`), skener zabranjenih izraza i `ductus-ui-copy`; doslovni tekst napomene čeka [OC6-1].
- **Oznaka `aitext` u dokumentu** (val 12). Oznaka podudaranja iz ovog ugovora nije oznaka u shemi dokumenta. Ne mijenja bajtove dokumenta, `content_hash` ni lanac evidencije, a računa se iz predane revizije.
- **Izjava v1.** Podudaranje ne mijenja obveznost priloga u izjavi v1: obveznost i dalje dolazi samo iz zapisa prijenosa i presude `known` (declaration-v1, „Što ugovor ne odlučuje”). Treba li podudaranje samo priložiti razgovor (prototip B-2), pitanje je [OC6-3].
- **Rokovi čuvanja** zapisa (D-30 PRIJEDLOG, Q-16).

## Načela

| Pravilo                         | Ugovor                                                                                                                                                                      | Izvor               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Samo zabilježeni događaji       | Kategoriju znaka određuje isključivo izvor događaja koji ga je umetnuo u lanac evidencije. Ništa se ne zaključuje iz sadržaja, ritma, vremena ni stila.                     | C-6 (a), D-54       |
| Bez modela                      | Oba izračuna su čiste determinističke funkcije nad bajtovima: bez mreže, modela, ugrađivanja (embeddinga), sinonima i semantike. Isti ulaz uvijek daje iste bajtove zapisa. | P-A                 |
| Napomena je dio podatka         | `share.notice` i `aiMatch.notice` su obvezna polja sa zatvorenom vrijednošću. Zapis bez njih se odbija, a prikaz bez napomene je greška prikaza (odjeljak 6).               | P-B                 |
| Ne tvrdi ništa o autoru         | Kategorija kaže kako je tekst ušao u Ducturu, a oznaka da se tekst slovo po slovo podudara s odgovorom. Nijedno polje ne kaže tko je tekst napisao.                         | pravila 1 i 2, D-44 |
| Oznaka nema zbroj               | Za podudaranje nema postotka, broja znakova ni broja odlomaka. Postoje samo mjesta u tekstu. Jedini postotak u ugovoru je udio iz (a).                                      | C-6 (c), pravilo 9  |
| Ne blokira i ne sankcionira     | Izračun se radi tek nakon zapisane predaje i ne mijenja nijedan ishod. Ruta predaje se ne mijenja; greška izračuna daje stanje `failed`, nikad grešku predaje.              | P-B, pravilo 11     |
| Ne ulazi u rangiranje           | Nijedna popisna ruta, izvoz, paket, obavijest ni sortiranje ne nosi polja iz ovog ugovora. Nema praga, boje razine ni oznake „visoko” i „nisko”.                            | P-B, pravilo 13     |
| Student vidi isto što nastavnik | Obje rute vraćaju isti zapis, bajt-jednak, iz istog spremljenog retka.                                                                                                      | P-B, pravilo 5      |
| Tek nakon predaje               | Prije zapisane predaje zapis ne postoji, ni za studenta ni za nastavnika.                                                                                                   | opis zadatka        |
| Vrste dokaza se ne spajaju      | Udio je opaženo (iz lanca). Oznaka je izvedena usporedba. Ništa iz izjave (izjavljeno) ne ulazi u izračun i ne uspoređuje se s njim.                                        | D-44                |
| Zapis se ne mijenja             | Zapis se izračuna jednom po predaji i ne mijenja se. Kasnije brisanje razgovora ne mijenja izračunat zapis, a nova verzija izračuna daje novu shemu zapisa.                 | pravilo 14 (uzorak) |

## 1. Udio predanog teksta iz zabilježenih događaja

### 1.1 Jedinica i opseg

- **Jedinica** je Unicode točka (code point) teksta predane revizije. Ne broje se UTF-16 jedinice ni grafemi. Razmak i interpunkcija broje se kao i svaki drugi znak.
- **Opseg** je tekst koji `textBlocksOf` (`server/domain/document/text-blocks.ts`) vraća za predanu reviziju, istim redom. To je ista funkcija koja broji riječi. Granice blokova nisu znakovi. Inline atomi (navod, `inlineFormula`) nemaju znakova. Tablica, slika, formula i prijelom stranice nemaju teksta u `textBlocksOf`, pa nisu u udjelu (izbor ugovora; vidi „Poznate granice”).
- **Predana revizija** je revizija zapisana u potvrdi predaje (`SignedSubmissionReceipt`), rekonstruirana iz lanca od revizije 0 (D-98, B-12). Revizija 0 je prazan odlomak, pa svaki znak predane revizije potječe od nekog događaja iz lanca.

### 1.2 Kategorije

Kategorija je zatvoren skup od pet vrijednosti, u ovom stalnom redu:

| Ključ            | Izvori događaja (`source`) iz lanca                                             | Što znači                                                 |
| ---------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `written`        | `editor`, `composition`, `keyless-input`, `system-replacement`, `citation-form` | uneseno u Ducturinu editoru                               |
| `ai_transferred` | `ai-transfer`                                                                   | preneseno iz AI pomoćnika zapisom `ductus-ai-transfer-v1` |
| `pasted`         | `paste` (sa `pasteOrigin` ili bez njega), `drop`                                | zalijepljeno ili ispušteno izvana                         |
| `imported`       | `import`                                                                        | uvezeno iz datoteke (manifest uvoza)                      |
| `unattributed`   | `unattributed`, i svaki tekst koji umetne događaj `cut`                         | lanac nema pozitivno pripisan način unosa (D-54)          |

- Opis zadatka navodi četiri kategorije. Peta, `unattributed`, postoji zato što je D-54 izričit: pripisivanje je pozitivno ili ga nema. Tekst bez pripisivanja ne smije se prikazati kao „napisano u Ducturi” ni kao „zalijepljeno”, jer bi to bila tvrdnja koju lanac ne nosi ([OC6-2]).
- `pasteOrigin` ne mijenja kategoriju. Lijepljenje s `pasteOrigin.kind = ai-response` ostaje `pasted`, i uz presudu `known` (izbor ugovora, D-44: opaženo prenošenje i opaženo lijepljenje su različite činjenice). Je li tekst podudaran s odgovorom, govori oznaka iz odjeljka 2, ne kategorija ([OC6-2]).
- `keyless-input` je u `written` jer je tekst unesen u Ducturin editor. Kategorija ne tvrdi da je unesen tipkama ([OC6-2]).
- Nova vrijednost izvora u budućoj verziji formata evidencije nema kategoriju dok se ovaj ugovor ne izmijeni. Do tada izračun za lanac s takvim događajem daje `failed`, a ne tihu kategoriju.

### 1.3 Postupak: kategorija svakog znaka

Izračun ponavlja lanac od revizije 0 do predane revizije, istim replayem kao rekonstrukcija pri predaji. Uz dokument vodi oznaku kategorije za svaku točku teksta.

1. **Umetanje.** Korak `replace` čiji slice umeće tekst daje svakoj umetnutoj točki kategoriju događaja kojem korak pripada (1.2).
2. **Brisanje.** Obrisana točka izlazi iz izračuna sa svojom oznakom.
3. **Pomak bez ponovnog umetanja.** Tekst koji korak zadržava i samo pomiče (`replaceAround`: omatanje u okvir, promjena razine naslova, skidanje okvira; mapiranje pozicija svakog koraka) zadržava svoju oznaku.
4. **Oznake oblikovanja** (`addMark`, `removeMark`) ne mijenjaju kategoriju.
5. **Zamjena atoma bloka** ne dira tekst iz `textBlocksOf`.

**Tekst uređen nakon unosa** (izbor ugovora, u skladu s „tekst je kasnije mijenjan je izvedeno” iz document-schema-v4, 3.1):

- Svaka točka zadržava kategoriju događaja koji ju je umetnuo, dok god postoji. Ako student u zalijepljeni odlomak dopiše riječ, dopisane točke su `written`, a preostale zalijepljene ostaju `pasted`. Ako student prepiše riječ unutar prenesenog teksta, obrisane točke izlaze iz izračuna, a nove dobivaju kategoriju događaja kojim su unesene.
- Udio zato ne treba prag sličnosti ni parafrazu. Nema „djelomično zalijepljenog” stanja: svaka točka ima točno jednu kategoriju.
- Ako je tekst izrezan pa ponovno zalijepljen unutar dokumenta (`cut` pa `paste`), dobiva kategoriju `pasted`. Ponovljen tekst nakon poništavanja (undo) dobiva kategoriju događaja koji ga je vratio. Obje granice su u odjeljku „Poznate granice” i u [OC6-9].

**Invarijanta:** zbroj točaka svih kategorija u bloku jednak je duljini teksta tog bloka iz `textBlocksOf`. Ako nije, ili replay ne uspije, zapis se ne sprema, a stanje je `failed`.

### 1.4 Postotak i zaokruživanje

`T` je zbroj točaka svih kategorija, a `c_i` broj točaka kategorije `i`.

- Kad je `T > 0`, `percent_i` je cijeli broj od 0 do 100. Računa se metodom najvećeg ostatka, u cijelim brojevima, bez pomičnog zareza:
  1. `floor_i = ⌊100 · c_i / T⌋`, `rem_i = (100 · c_i) mod T`;
  2. `R = 100 − Σ floor_i`;
  3. po jedan postotni bod dobiva `R` kategorija s najvećim `rem_i`. Kod jednakog ostatka prednost ima kategorija s manje točaka, a zatim redoslijed iz 1.2 (izbor ugovora: mala kategorija ne nestaje zbog stalnog reda).
- **Zbroj je uvijek točno 100** kad je `T > 0`. Kategorija s `c_i = 0` nikad ne dobiva bod (zbroj ostataka je `R`, a svaki je manji od 1).
- Kategorija s `c_i > 0` i `percent_i = 0` prikazuje se kao „manje od 1 %”, nikad kao 0 %. Zbroj se i dalje računa iz `percent`. Tekst prikaza je stvar WEB-1220 i `ductus-ui-copy`.
- Kad je `T = 0` (prazan predani tekst), svi `percent` su 0, a prikaz ne pokazuje postotke nego prazno stanje. Pravilo „zbroj 100” vrijedi samo za `T > 0`.
- Zapis uz svaki postotak nosi i `codePoints`, da se postotak može provjeriti.

## 2. Oznaka podudaranja s AI odgovorom

### 2.1 Što se uspoređuje

- **Tekst rada:** svaki blok iz `textBlocksOf` predane revizije, zasebno. Podudaranje ne prelazi granicu bloka (izbor ugovora).
- **Odgovori:** tekst poruka uloge `assistant` iz razgovora Ducturina pomoćnika istog studenta za isti zadatak, zabilježenih prije `requestedAt` predaje i spremljenih u trenutku izračuna. Uspoređuju se samo odgovori zabilježeni u Ducturi: vanjski alati, priloženi vanjski ispisi (izjava, odjeljak 3) i izvori nisu u usporedbi.
- Dok shema `assistant` ne postoji u ovom repou (declaration-v1, 2.5; M9.5), skup odgovora je prazan, pa je popis oznaka prazan. Testovi pune odgovore izmišljenim tekstom kroz testnu podlogu.

### 2.2 Normalizacija `ductura-match-norm-v1`

Normalizacija je ista za tekst rada i za odgovor. Radi se po točki, da se svaka normalizirana pozicija može vratiti na točku izvornog teksta:

1. cijeli tekst u NFC (tekst dokumenta već jest);
2. za svaku točku redom:
   1. točke `U+00AD`, `U+200B`, `U+200C`, `U+200D`, `U+2060` i `U+FEFF` daju prazan niz;
   2. NFKC te točke;
   3. mala slova po Unicode zadanom pretvaranju (bez pravila lokala);
   4. zatvorena tablica: `‘ ’ ‚ ‛ ′` → `'`; `“ ” „ ‟ ″ « »` → `"`; `‐ ‑ ‒ – — ― −` → `-`;
   5. svaki znak sa svojstvom `White_Space` → `U+0020`;
3. niz razmaka sažima se u jedan razmak; razmak na početku i na kraju teksta se uklanja.

Interpunkcija ostaje, a dijakritici ostaju (`č` nije `c`). Nema korijenovanja, sinonima ni prijevoda (P-A). Treba li zanemariti interpunkciju, pitanje je [OC6-5].

### 2.3 Pravilo podudaranja

- `MIN_MATCH_CODE_POINTS` je imenovana konstanta, minimalna duljina podudarnog odlomka u točkama normaliziranog teksta. **Predloženo: 60** ([OC6-5]).
- **Riječ** je najdulji niz točaka općih kategorija `L`, `N` i `M`.
- Raspon `[i, j)` normaliziranog bloka je **podudaran** ako vrijedi sve:
  1. `B[i, j)` je neprekinut podniz normaliziranog teksta barem jednog odgovora;
  2. `i` je početak riječi u bloku, a `j` kraj riječi u bloku (točka prije `j` je u riječi, a točka na `j` nije ili je kraj bloka);
  3. `j − i ≥ MIN_MATCH_CODE_POINTS`.
- **Oznaka** je unija svih podudarnih raspona bloka, preko svih odgovora, sažeta u najveće neprekinute raspone.
- Vraćanje na izvorni tekst: svaka izvorna točka `k` daje normalizirani raspon `[a_k, b_k)`. Oznaka `[i, j)` postaje izvorni raspon `[from, to)`, gdje je `from` najmanji, a `to − 1` najveći `k` za koji je `a_k < j` i `b_k > i`. Uklonjene točke (prazan raspon) unutar oznake ulaze u nju.
- Algoritam nije propisan, propisan je rezultat. Izvedba mora biti linearna u zbroju duljina (npr. sufiksni automat po odgovoru), uz test izvedbe iz odjeljka 10.

### 2.4 Što oznaka ne nosi

- Ne nosi tekst odgovora, ID razgovora, ID poruke, broj odgovora ni vrijeme. Zapis ne otkriva iz kojeg je razgovora oznaka; nepriloženi razgovori ostaju samo studentovi (D-41). Treba li nastavnik moći otvoriti razgovor iz oznake, pitanje je [OC6-3].
- Ne razlikuje je li tekst ušao prijenosom, lijepljenjem ili unosom. To je udio iz odjeljka 1, i ta se dva podatka ne spajaju.
- Nema zbroja, postotka ni broja (načela).

## 3. Zapis `ductura-provenance-share-v1`

Zapis je jedan JCS objekt (RFC 8785) sa zatvorenim skupom ključeva na svakoj razini. Sastavlja ga poslužitelj jednom po predaji. Nepoznat ili nedostajući ključ, duplikat ključa i nekanonski bajtovi odbijaju se.

`recordSha256 = SHA-256(JCS(record))`, 64 mala heksadekadska znaka, sprema se uz zapis, nikad u njemu.

| Ključ              | Oblik                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| `provenanceSchema` | točno `ductura-provenance-share-v1` (prefiks kao `ductura-declaration-v1`, [OC6-6]) |
| `submissionId`     | kanonski UUID predaje iz potvrde                                                    |
| `documentId`       | kao u potvrdi predaje                                                               |
| `revision`         | cijeli broj ≥ 1, predana revizija                                                   |
| `share`            | objekt, 3.1                                                                         |
| `aiMatch`          | objekt, 3.2                                                                         |
| `computedAt`       | kanonski UTC `YYYY-MM-DDTHH:mm:ss.ffffffZ`, šest decimala, sat baze                 |

Nema imena studenta, kolegija ni ustanove, ni teksta rada. Prikaz čita tekst iz predane revizije kroz postojeće rute verzija.

### 3.1 `share`

| Ključ                     | Oblik                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `unit`                    | točno `code_point`                                                                                   |
| `totalCodePoints`         | cijeli broj ≥ 0, `T`                                                                                 |
| `categories`              | niz od točno pet objekata `{ category, codePoints, percent }`, redom iz 1.2, svaka kategorija jednom |
| `categories[].category`   | vrijednost iz 1.2                                                                                    |
| `categories[].codePoints` | cijeli broj ≥ 0; zbroj je `totalCodePoints`                                                          |
| `categories[].percent`    | cijeli broj od 0 do 100 iz 1.4; zbroj je 100 kad je `T > 0`, inače su svi 0                          |
| `notice`                  | točno `not_authorship_evidence` (P-B)                                                                |

### 3.2 `aiMatch`

| Ključ                | Oblik                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `normalization`      | točno `ductura-match-norm-v1`                                                                                                          |
| `minMatchCodePoints` | vrijednost `MIN_MATCH_CODE_POINTS` s kojom je zapis izračunat                                                                          |
| `spans`              | niz `{ blockId, from, to }`, poredan po redu bloka u `textBlocksOf`, pa po `from`; rasponi se ne preklapaju i ne dodiruju unutar bloka |
| `spans[].blockId`    | ID bloka iz predane revizije                                                                                                           |
| `spans[].from`, `to` | cijeli brojevi, `0 ≤ from < to ≤` duljina teksta bloka u točkama; `to` je isključiv                                                    |
| `notice`             | točno `not_authorship_evidence` (P-B)                                                                                                  |

Prazan `spans` znači samo da nema oznake. Ne razlikuje „nema odgovora” od „nema podudaranja”, jer bi to nastavniku otkrilo postoje li studentovi nepriloženi razgovori (D-41).

## 4. Kada se računa i pohrana (skica)

- **Okidač:** nakon što je predaja zapisana i potvrda izdana, worker dobiva zaseban posao `provenance_share` za tu predaju. Posao nije u transakciji predaje i ne može promijeniti njezin ishod (P-B, pravilo 11).
- **Ulaz je zamrznut:** lanac do predane revizije i odgovori iz 2.1 zabilježeni prije `requestedAt`. Ponovni pokušaj nakon greške računa isti ulaz. Odgovor obrisan prije izračuna nije u usporedbi ([OC6-4]).
- **Ponovni pokušaji:** najviše `MAX_SHARE_ATTEMPTS` (predloženo 3). Nakon toga stanje je `failed`, bez novog pokušaja. Novi izračun stare predaje moguć je samo novom verzijom sheme zapisa.
- **Pohrana**, ako vlasnik odobri:
  - shema `provenance`, tablica zapisa po predaji, samo dodavanje (okidač odbija `UPDATE`, `DELETE` i `TRUNCATE`);
  - `ENABLE` i `FORCE ROW LEVEL SECURITY`; uloga weba nema `INSERT`, `UPDATE`, `DELETE` ni `TRUNCATE`;
  - upis samo kroz `SECURITY DEFINER` RPC workera sa `search_path = ''`; čitanje kroz RPC s akterom iz `require_actor()`;
  - retci u `db/main/tests/030-institution-access-matrix.sql` za tablicu, politike i RPC-ove.
- **Prekidač:** `provenanceShareV1` u `config/faculties/`, zadano isključen, mijenja se samo PR-om koji odobri vlasnik (po uzoru na OC-1; [OC6-4]). Dok je isključen, posao se ne stvara, a rute vraćaju `disabled`.

| Akter                                     | Zapis predaje              |
| ----------------------------------------- | -------------------------- |
| student vlasnik, nakon predaje            | da, kroz RPC               |
| student vlasnik, prije predaje            | nema zapisa                |
| drugi student                             | ne                         |
| nastavnik kolegija, nakon predaje         | da, kroz RPC, isti bajtovi |
| nastavnik drugog kolegija ili ustanove    | ne                         |
| administrator ustanove, operater, podrška | ne                         |
| worker                                    | samo upis, kroz RPC        |

Zapis nema teksta rada, pa čitanje ne ide u dnevnik pristupa, kao ni `teacher.submission-receipt.get`. Tekst se čita kroz rute verzija, koje imaju svoja pravila zapisa.

## 5. Rute

Oblik prati `server/contracts/routes/`: zatvorena tijela, odgovor greške `{status: <kod>}`, isti 404 za tuđe, nepoznato, neispravno i opozvano. Rute su prijedlog i dodaju se tek nakon odobrenja.

| Id                             | Metoda i staza                                                                         | Pristup            |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------ |
| `student.provenance-share.get` | `GET /api/v1/student/assignments/{assignmentId}/provenance-share`                      | `student_enrolled` |
| `teacher.provenance-share.get` | `GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/provenance-share` | `course_teacher`   |

Obje rute vraćaju isto tijelo 200, zatvorenu uniju po `state`:

```
{ state: "disabled" }                        // prekidač fakulteta isključen
{ state: "none" }                            // nema zapisane predaje
{ state: "pending" }                         // predaja zapisana, izračun nije gotov
{ state: "failed" }                          // izračun nije uspio (1.3, 4); bez razloga
{ state: "ready", record, recordSha256 }     // record: zapis iz 3, recordSha256: 64 heks
```

- Pravilo 5: za istu predaju `teacher.provenance-share.get` i `student.provenance-share.get` vraćaju bajt-jednak `record` i isti `recordSha256`, iz istog retka.
- Stanje se odnosi na zadnju zapisanu predaju. Starije predaje (runde, dorada) su izvan v1 ([OC6-8]).
- Greške: 401 `unauthorized`; 404 `not_found`; 503 `unavailable`. Nema mutacija, pa nema `MUTATION_GUARD`.
- `failed` i `pending` ne nose razlog, broj pokušaja ni vrijeme.
- Nijedna druga ruta (popisi radova, sažetak procesa, Merlin paket, izvoz, PDF potvrde, `/provjera`, obavijesti) ne dobiva polja iz ovog ugovora. To provjerava test iz odjeljka 10.

## 6. Napomena P-B kao obvezno polje prikaza

- `share.notice` i `aiMatch.notice` su obvezni, s jedinom vrijednošću `not_authorship_evidence`. Parser zapisa i klijentski parser odbijaju zapis bez njih ili s drugom vrijednošću.
- **Pravilo prikaza** (WEB-1220):
  - svaki prikazani postotak iz `share` stoji u istom elementu kao vidljiva napomena;
  - dok su oznake podudaranja vidljive u tekstu, napomena je stalno vidljiva uz njih, ne samo u opisu koji se otvara pokazivačem (tooltip);
  - svaka oznaka ima pristupačan opis (`aria-describedby`) koji upućuje na napomenu;
  - prikaz koji ne može prikazati napomenu ne prikazuje ni postotak ni oznaku.
- Napomena se ne može sakriti, zatvoriti ni isključiti postavkom.
- Ključ kataloga je `provenance.notice` (prijedlog). Doslovni tekst „nije dokaz autorstva” sada pada na skeneru: rječnik ima unos „dokaz autorstva” (`dokaz\p{L}* (?:o )?autorstv`), a engleski „proof of authorship”. Tekst zato ne smije u `locales/` dok se Rječnik ne uskladi kroz Q-18 ili dok vlasnik ne odobri iznimku u `scripts/forbidden-terms/` (`EXCEPTIONS`) ([OC6-1]). Pisac ne mijenja docs Ductusa.
- Ostali tekst prikaza mora izbjeći unose „AI postotak” (npr. „udio AI”, „udio izvora”, „udio podrijetla”, „AI 18 %”), „rizik”, „sumnja”, „ljudskost”, „plagijat” i engleske „flagged”, „AI-detected” i „proof of authorship”. Postotak se nikad ne piše odmah iza „AI”. Prijedlog kategorija: „napisano u Ducturi”, „preneseno iz AI pomoćnika”, „zalijepljeno”, „uvezeno”, „bez zabilježenog načina unosa”; prijedlog oznake: „podudara se s odgovorom AI pomoćnika”. Odluka je na WEB-1220 kroz `ductus-ui-copy`.
- Prikaz koristi jednak neutralan izgled za sve kategorije: bez crvene, žute ili zelene kao razine, bez praga i bez poretka po veličini.

## 7. Granice i konstante

| Konstanta               | Vrijednost                | Status                                     |
| ----------------------- | ------------------------- | ------------------------------------------ |
| `MIN_MATCH_CODE_POINTS` | 60                        | prijedlog [OC6-5]                          |
| `MAX_SHARE_ATTEMPTS`    | 3                         | prijedlog                                  |
| `MATCH_NORMALIZATION`   | `ductura-match-norm-v1`   | izbor ugovora; promjena je nova vrijednost |
| `SHARE_CATEGORIES`      | 5 vrijednosti iz 1.2      | [OC6-2]                                    |
| `SHARE_NOTICE`          | `not_authorship_evidence` | P-B                                        |

Promjena `MIN_MATCH_CODE_POINTS` ne mijenja već spremljene zapise: zapis nosi vrijednost s kojom je izračunat.

## 8. Redoslijed izvedbe (prijedlog)

Svaki korak je zaseban kritični PR, tek nakon odobrenja ugovora. Raspodjela na SRV-1221, SRV-1222 i WEB-1220 je pretpostavka; konačnu daje orkestrator.

1. **SRV-1221, domena:** kategorije i replay s oznakama znakova, zaokruživanje, normalizacija, podudaranje, parser zapisa i vektori iz 9. Bez baze i bez rute.
2. **SRV-1222, pohrana i rute:**
   - migracija sheme `provenance` (traka S-B) s RLS-om, okidačima i pgTAP retcima;
   - posao workera i prekidač u `config/faculties/`;
   - rute iz 5 s ugovorom rute, vektorima, lažnim dev serverom i introspekcijom u `tests/db/logout-old-cookie.integration.test.ts`.
3. **WEB-1220, prikaz:** prikaz nakon predaje za studenta i nastavnika, s napomenom iz 6, nakon [OC6-1].

## 9. Testni vektori

Sve vrijednosti su izmišljene. Vektori su izračunani izvan modula, Pythonom (`unicodedata`, `json`, `hashlib`) i neovisno Node `crypto`. Implementacijski test uspoređuje sve vrijednosti. Vektori vrijede tek kad je ugovor odobren; promjena pravila mijenja vektor.

### 9.1 Kategorije i tekst uređen nakon unosa

Događaji redom, od revizije 0 (blok `b1` je blok revizije 0, `00000000-0000-4000-8000-000000000000`; ostali ID-ovi su `b2b2b2b2-0000-4000-8000-000000000002` do `b5b5b5b5-0000-4000-8000-000000000005`):

| #   | Izvor          | Korak                                                                                                   |
| --- | -------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `editor`       | `b1` umetne `Kućno kompostiranje smanjuje količinu otpada. ` (46 točaka, zadnja je razmak)              |
| 2   | `ai-transfer`  | `b1` na kraj umetne `Kompost nastaje razgradnjom organske tvari uz prisutnost kisika.` (64)             |
| 3   | `paste`        | `b2` umetne `Prema izmišljenom izvoru, četvrti s kompostištima imaju manje otpada.` (69)                |
| 4   | `editor`       | `b2` obriše `izvoru` (6) i na isto mjesto umetne `istraživanju` (12)                                    |
| 5   | `import`       | `b3` umetne `Uvezeni odlomak iz ranijeg nacrta.` (34)                                                   |
| 6   | `unattributed` | `b3` na kraj umetne ` (dopuna)` (9)                                                                     |
| 7   | `editor`       | `b4` umetne `„Zreli kompost” ima miris šumskog tla i tamnu boju te se koristi kao gnojivo u vrtu.` (84) |
| 8   | `editor`       | `b5` umetne `Proces obično traje nekoliko mjeseci, ovisno o vlazi.` (53)                                |

Očekivano: `T = 365`; `written` 195 (46 + 12 + 84 + 53), `ai_transferred` 64, `pasted` 63 (69 − 6), `imported` 34, `unattributed` 9.

Zaokruživanje: `floor` = 53, 17, 17, 9, 2; `rem` = 155, 195, 95, 115, 170; `R = 2`; bodove dobivaju `ai_transferred` i `unattributed`. **`percent` = 53, 18, 17, 9, 3** (zbroj 100).

### 9.2 Zaokruživanje

Redom `written`, `ai_transferred`, `pasted`, `imported`, `unattributed`:

| `codePoints`    | `percent`          | Što provjerava                                  |
| --------------- | ------------------ | ----------------------------------------------- |
| 1, 1, 1, 0, 0   | 34, 33, 33, 0, 0   | jednak ostatak i jednak broj točaka: red iz 1.2 |
| 199, 1, 0, 0, 0 | 99, 1, 0, 0, 0     | jednak ostatak: prednost manjoj kategoriji      |
| 598, 1, 1, 0, 0 | 100, 0, 0, 0, 0    | `c_i > 0` uz `percent` 0: prikaz „manje od 1 %” |
| 1, 2, 0, 0, 0   | 33, 67, 0, 0, 0    | najveći ostatak                                 |
| 1, 1, 1, 1, 1   | 20, 20, 20, 20, 20 | bez ostatka                                     |
| 0, 0, 7, 0, 0   | 0, 0, 100, 0, 0    | jedna kategorija                                |
| 0, 0, 0, 0, 0   | 0, 0, 0, 0, 0      | `T = 0`: prazno stanje, bez zbroja 100          |

### 9.3 Normalizacija

Ulaz (JSON): `"  Ｋompost­iranje — „Zreli”​ kompost\tiz VRTA  "`

Izlaz: `kompostiranje - "zreli" kompost iz vrta`

Provjerava: puna širina (NFKC), meka crtica i razmak nulte širine, crticu, navodnike, tabulator, sažimanje i rubne razmake.

### 9.4 Podudaranje

Izmišljeni odgovori pomoćnika (SHA-256 UTF-8 bajtova samo radi identifikacije u testu):

- O1 `Kompost nastaje razgradnjom organske tvari uz prisutnost kisika. Proces obično traje nekoliko mjeseci.` → `111833ee12d01eeb5d06ba08dc9a3bb26a359302946bd3dca6d3f9990fdadd13`
- O2 `"Zreli kompost" ima miris šumskog tla i tamnu boju te se koristi kao gnojivo. Može se miješati sa zemljom.` → `d562c7387b215102b9ea3d8ef6a0394904aa05b33a0ffd2936552144b272186f`

Nad tekstom iz 9.1, uz `MIN_MATCH_CODE_POINTS = 60`:

| Blok | Oznaka `[from, to)` | Izvorni tekst oznake                                                          | Što provjerava                                                                 |
| ---- | ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `b1` | `[46, 109)`         | `Kompost nastaje razgradnjom organske tvari uz prisutnost kisika`             | 63 točke; završna točka rečenice je izvan oznake (kraj riječi)                 |
| `b2` | nema                | —                                                                             | zalijepljen tekst bez odgovora nije označen                                    |
| `b3` | nema                | —                                                                             | uvezen tekst                                                                   |
| `b4` | `[1, 76)`           | `Zreli kompost” ima miris šumskog tla i tamnu boju te se koristi kao gnojivo` | unesen tekst, velika slova i navodnici normalizirani; oznaka počinje na riječi |
| `b5` | nema                | —                                                                             | zajednički odlomak `proces obično traje nekoliko mjeseci` ima 36 < 60 točaka   |

`b1` i `b4` pokazuju da oznaka ne ovisi o kategoriji: tekst `b1` je `ai_transferred`, a `b4` `written`.

### 9.5 Zapis

`submissionId` `3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a`, `documentId` `7d6c5b4a-3f2e-4a1b-9c8d-7e6f5a4b3c2d`, `revision` 11, `computedAt` `2026-11-21T10:15:00.000000Z`.

JCS (844 bajta):

```
{"aiMatch":{"minMatchCodePoints":60,"normalization":"ductura-match-norm-v1","notice":"not_authorship_evidence","spans":[{"blockId":"00000000-0000-4000-8000-000000000000","from":46,"to":109},{"blockId":"b4b4b4b4-0000-4000-8000-000000000004","from":1,"to":76}]},"computedAt":"2026-11-21T10:15:00.000000Z","documentId":"7d6c5b4a-3f2e-4a1b-9c8d-7e6f5a4b3c2d","provenanceSchema":"ductura-provenance-share-v1","revision":11,"share":{"categories":[{"category":"written","codePoints":195,"percent":53},{"category":"ai_transferred","codePoints":64,"percent":18},{"category":"pasted","codePoints":63,"percent":17},{"category":"imported","codePoints":34,"percent":9},{"category":"unattributed","codePoints":9,"percent":3}],"notice":"not_authorship_evidence","totalCodePoints":365,"unit":"code_point"},"submissionId":"3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a"}
```

`recordSha256`: `5210c1ad1f0c0899dde1a79f4c33b733572dd306ffe26b376eb348e5bf3d8073`

## 10. Testovi prije prvog retka koda

Prvi kodni PR piše ove testove prije koda. Svaki test mora pasti kad se pravilo prekrši. Svi tekstovi, osobe i odgovori su izmišljeni (`demo-*`, `sim:*`).

| Sloj                  | Što                                                                                                                                                                                                                                 | Odjeljak |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| jedinica              | vektor 9.1: kategorije po događaju, dopisano i prepisano unutar zalijepljenog teksta, brisanje; svaki izvor iz zatvorenog skupa ima točno jednu kategoriju; nepoznat izvor daje `failed`                                            | 1.2, 1.3 |
| jedinica              | `pasteOrigin` `ai-response` uz presudu `known` ostaje `pasted`; tekst koji umetne `cut` je `unattributed`                                                                                                                           | 1.2      |
| jedinica              | `replaceAround` (okvir, razina naslova) i `addMark`/`removeMark` ne mijenjaju kategoriju; zamjena atoma bloka ne mijenja broj točaka                                                                                                | 1.3      |
| svojstva (fast-check) | za slučajan lanac: invarijanta iz 1.3 (zbroj po bloku jednak duljini iz `textBlocksOf`); zbroj `percent` je 100 za `T > 0`; kategorija s 0 točaka ima 0 %; isti lanac daje iste bajtove zapisa                                      | 1.3, 1.4 |
| jedinica              | svi retci iz 9.2; izračun samo u cijelim brojevima (nema `/` nad brojevima s pomičnim zarezom u modulu)                                                                                                                             | 1.4      |
| jedinica              | vektor 9.3; svaka točka iz tablice 2.2; dijakritik ostaje; mapiranje na izvorne pozicije uz uklonjene točke i NFKC koji širi točku                                                                                                  | 2.2      |
| jedinica              | vektor 9.4; podudaranje točno `MIN_MATCH_CODE_POINTS` označeno, a jedna točka manje nije; oznaka ne prelazi granicu bloka; dva odgovora s preklapanjem daju jednu sažetu oznaku; početak i kraj na riječi                           | 2.3      |
| jedinica              | vektor 9.5: JCS i `recordSha256`; nepoznat, nedostajući i duplikat ključa odbijeni na svakoj razini; zapis bez `notice` ili s drugom vrijednošću odbijen                                                                            | 3, 6     |
| arhitektura           | modul izračuna ne uvozi adaptere, mrežu, `server/external/**` ni pomoćnika; nema poziva modelu (P-A)                                                                                                                                | načela   |
| izvedba               | izmišljen rad od 15 000 riječi i 500 odgovora od po 8000 točaka: izračun unutar granice koju odredi SRV-1221 i linearan rast s duljinom                                                                                             | 2.3      |
| integracija           | predaja: posao `provenance_share` nastaje tek nakon zapisane predaje; greška ili prekid posla ne mijenja potvrdu, ishod ni rutu predaje; nakon `MAX_SHARE_ATTEMPTS` stanje `failed`; prekidač isključen daje `disabled` i bez posla | 4        |
| integracija           | odgovor zabilježen nakon `requestedAt` nije u usporedbi; brisanje razgovora nakon izračuna ne mijenja zapis                                                                                                                         | 2.1, 4   |
| pgTAP                 | matrica iz 4: student vlasnik i nastavnik kolegija čitaju nakon predaje; drugi student, nastavnik drugog kolegija, administrator i podrška ništa; uloga weba nema izravan upis; okidači nepromjenjivosti                            | 4        |
| ruta                  | pravilo 5: `record` i `recordSha256` iz studentove i nastavnikove rute bajt-jednaki; prije predaje obje daju `none`; tuđi, nepoznat i neispravan ID isti 404                                                                        | 5        |
| ugovor                | nijedna druga ruta u `server/contracts/routes/` ni `openapi/v1.json` nema ključeve `share`, `aiMatch`, `percent` ni `spans` iz ovog ugovora; popisne rute nemaju sortiranje ni filtar po njima                                      | 5        |
| klijent (WEB-1220)    | svaki prikazani postotak i svaka oznaka imaju vidljivu napomenu i `aria-describedby`; bez napomene nema prikaza; „manje od 1 %” za `c_i > 0` i 0 %; skener zabranjenih izraza nad novim ključevima                                  | 6        |

## Poznate granice

- **Unutarnji izrezi i lijepljenje.** Tekst izrezan pa zalijepljen unutar istog rada dobiva `pasted`, jer lanac bilježi lijepljenje, a ne odakle je tekst došao. Udio `pasted` može biti veći od stvarnog lijepljenja izvana, nikad manji ([OC6-9]).
- **Poništavanje.** Tekst vraćen poništavanjem dobiva kategoriju događaja koji ga je vratio, a ne kategoriju s kojom je prvi put unesen ([OC6-9]).
- **Sadržaj izvan `textBlocksOf`.** Tekst tablica i opisa slika nije u udjelu ni u usporedbi.
- **Obrisani odgovori.** Odgovor koji je student obrisao prije izračuna nije uspoređen. Ishod je izostanak oznake, nikad lažna oznaka ([OC6-4]).
- **Podudaranje je slovo po slovo.** Parafraza, prijevod i promjena reda riječi ne daju oznaku, a jedna promijenjena interpunkcija dijeli odlomak. To je namjerno (P-A): oznaka govori samo da je tekst isti.
- **Kratko podudaranje** ispod `MIN_MATCH_CODE_POINTS` nema oznake, pa i čest izraz koji je slučajno isti kao u odgovoru ostaje bez oznake ako je kraći od granice.

## Nesklad izvora

- **Ustav v1.6 C-6 (c) i U-4.** Odluka od 21. 11. (c.7054441152) drži U-4 isključenim do nakon pilota, a D-268 O6 i M9.6 drže oznaku isključenom do M9.6-P04. Kasnije istog dana vlasnik je doslovno potvrdio C-6 v1.6, a orkestrator (P-C) stavlja (c) u ovaj val. Ugovor slijedi C-6 v1.6, ali se kod za (c) ne spaja dok vlasnik ne potvrdi da C-6 zamjenjuje U-4 i O6 ([OC6-7]).
- **D-57 „karta podrijetla bez zbroja”** i izlazni kriterij M7. Udio iz (a) je zbroj. Ugovor ga drži kao zaseban prikaz i ne dira kartu podrijetla, ali D-57 i kriterij M7 treba uskladiti s C-6 (a) ([OC6-7]).
- **Declaration-v1, `teacherView`** kaže „nema zbroja, broja ni udjela prenesenog teksta”. To ostaje: udio se ne ubacuje u prikaz izjave, nego ima svoju rutu.
- **Rječnik** (Ductus `docs/PRODUCT.md` §5, `scripts/forbidden-terms/terms.ts`) zabranjuje „dokaz autorstva”, a P-B traži napomenu „nije dokaz autorstva” ([OC6-1]). Usklađuje se kroz Q-18; ovaj PR ne mijenja Ductusove dokumente ni skener.
- **Oznaka „C-6” u planu.** U `docs/plan/PLAN-MIGRACIJE.md` „✓ C-6” je pitanje o `/provjera`, a ne članak Ustava. Ovaj ugovor uvijek piše „Ustav v1.6 C-6”.

## Otvorena pitanja

- **[OC6-1] Tekst napomene, blokira WEB-1220.** „nije dokaz autorstva” i „not proof of authorship” padaju na skeneru. Mogućnosti: (a) Q-18 mijenja Rječnik tako da dopušta točno tu niječnu napomenu; (b) vlasnik odobri dvije iznimke u `EXCEPTIONS` (`hr` i `en`, točan literal, jedan ključ `provenance.notice`). Ugovor preporučuje (b) kao uži zahvat dok se Q-18 ne zatvori. Ključ zapisa `not_authorship_evidence` ne ovisi o odluci.
- **[OC6-2] Kategorije.** Pet kategorija umjesto četiri (peta `unattributed`, D-54); `keyless-input` u `written`; `pasteOrigin` `ai-response` uz `known` ostaje `pasted`. Druga mogućnost je spojiti `unattributed` s `written`, ali to bi bila tvrdnja koju lanac ne nosi.
- **[OC6-3] Oznaka i nepriloženi razgovori.** Zapis ne otkriva razgovor iz kojeg je oznaka (D-41). Prototip (B-2) predviđa da podudaranje samo priloži razgovor izjavi. To bi mijenjalo izjavu v1 (obveznost nikad iz usporedbe teksta) i traži odluku vlasnika te novu verziju ugovora izjave.
- **[OC6-4] Prekidač i obrisani odgovori.** Prekidač `provenanceShareV1` u `config/faculties/`, zadano isključen, kao OC-1. Treba li za usporedbu zadržati odgovore koje je student obrisao? Ugovor predlaže ne, dok se ne zatvore Q-16 i D-30.
- **[OC6-5] Granica i interpunkcija.** `MIN_MATCH_CODE_POINTS` = 60 je prijedlog (oko deset riječi). Treba li normalizacija zanemariti interpunkciju? Ugovor predlaže ne (manje lažnih oznaka).
- **[OC6-6] Prefiks sheme.** `ductura-provenance-share-v1`, kao `ductura-declaration-v1` (OD-14). Prefiks ulazi u hash, pa se mora odlučiti prije koda.
- **[OC6-7] Odnos C-6 v1.6 prema U-4, D-268 O6 i D-57.** Potvrda da C-6 v1.6 zamjenjuje isključenje oznake do nakon pilota i ograničenje „bez zbroja” za ovaj prikaz.
- **[OC6-8] Runde i dorada.** v1 prikazuje zapis zadnje zapisane predaje. Prikaz starijih predaja (D-28, runde) dolazi s M7.1-P07.
- **[OC6-9] Unutarnje lijepljenje i poništavanje.** Treba li hvatanje u editoru bilježiti da je zalijepljeni tekst došao iz istog rada ili da je vraćen poništavanjem? To bi bila nova verzija formata evidencije, pa ugovor do odluke prihvaća granicu iz „Poznatih granica”.
