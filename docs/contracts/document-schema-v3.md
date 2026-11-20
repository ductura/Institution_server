# Dokument v3: fusnota, unakrsna poveznica, `via` i `rq`

SRV-7A `shema-v3-dokument`, val 7, `Risk: critical`. Ovaj ugovor je nasljednik Ductusova [`docs/contracts/document-schema-v2.md`](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/contracts/document-schema-v2.md) (dalje „ugovor v2”). Određuje dokument v3, format koraka `ductus-edit-steps-v3` i v3 reviziju nula. Kod dolazi u PR-ovima iz odjeljka 9, a svaki nosi testove iz odjeljka 10.

Izvori:

- `PLAN-MIGRACIJE.md` (ductura/.github, grana `docs/kanonski-plan-ducture`, `docs/plan`): „Shema dokumenta: nesklad i gdje se rješava” (shema v3 = fusnota, unakrsna poveznica, atributi navoda `via` i `rq`) i „Val 7: Citati i izvori (shema v3)”;
- vlasnikove odluke iz plana: ✓ C-1 (shema po valovima), ✓ C-2 (`locator` ostaje i prikazuje se kao stranica; `via` i `rq` su atributi navoda u v3);
- prototip editora (`Institution_front_web_chrome`, `docs/prototip/editor`, `app.js`, `features.js`, `sources2.js`) i `docs/prototip/INVENTAR-editor.md` (E§3.2 do E§3.4, „Tiptap”, „Prilagođeni čvorovi”);
- ugovor v2 u cijelosti: sve što ovaj ugovor ne mijenja, vrijedi kako ondje piše;
- postojeći kod: `server/domain/document/{schema,validate,validate-sources,edit-step,revision-zero,normalize,equality,text-blocks,word-count}.ts`, `server/external/storage/edit-steps-v2-rules.ts`, `server/evidence/submission-reconstruction.ts`.

Gdje ugovor provodi plan tehničkim izborom, uz pravilo piše „izbor ugovora”, da review može provjeriti svaki takav izbor. Što izvori ne pokrivaju, nalazi se u odjeljcima „Poznate granice” i „Otvorena pitanja”.

## Invarijanta

Dokument v3 je jedan JCS (RFC 8785) objekt čiji SHA-256 pokriva tekst, navode sa svim atributima, fusnote, unakrsne poveznice i zapise izvora. Nijedan put (validator, snimka, korak, replay, rekonstrukcija, poslužitelj) to ne mijenja, ne skraćuje i ne briše tiho. Rad ima jednu verziju od revizije nula do predaje. Radovi v1 i v2 ostaju bajt-jednaki i valjani: nijedan put ih ne pretvara u v3.

## 1. Gornja razina

Dokument v3 ima točno tri ključa, kao v2:

| Ključ           | Oblik                       | Pravilo                                                             |
| --------------- | --------------------------- | ------------------------------------------------------------------- |
| `schemaVersion` | JSON broj `3`               | Bilo što drugo daje `SCHEMA_VERSION_INVALID`, bez zaokruživanja.    |
| `nodes`         | niz blokova                 | Pravila v2 vrijede nepromijenjena, uz inline čvorove iz odjeljka 3. |
| `sources`       | niz zapisa izvora, 0 do 500 | Kao u v2 (ugovor v2, odjeljci 1 i 2).                               |

- Skup ključeva je zatvoren (`UNKNOWN_FIELD`).
- `DOCUMENT_BLOCK_TYPES_BY_VERSION` dobiva `3` s istim skupom blokova kao v1 i v2 (`paragraph`, `heading`, `bulletItem`, `quote`). Shema v3 ne uvodi nijedan blok. Taj `Map` ostaje jedini popis prihvaćenih verzija.
- `DOCUMENT_FIELDS` za v3 je `{schemaVersion, nodes, sources}`.
- Granica od 2 MiB (`MAX_DOCUMENT_SNAPSHOT_BYTES`) vrijedi za cijeli dokument.

## 2. Zapis izvora

Nepromijenjen u odnosu na v2 (ugovor v2, odjeljak 2): iste vrste, ista polja, iste granice i isti kodovi. `sourceSet` i `sourceRemove` rade kao u v2.

Izbor ugovora: DOI, ISBN, izvor bez godine („b. g.”) i oznake „preporučen” i „obvezan” nisu dio zapisa u dokumentu ni u v3. Plan ih ne stavlja u shemu v3. Pripadaju tablici izvora rada (SRV-7B), koja nije hashirani dokument. Dodavanje u zapis traži novu verziju sheme.

## 3. Inline čvorovi v3

Blok `paragraph`, `bulletItem` i `quote` u v3 smije sadržavati četiri inline čvora: tekst, navod, fusnotu i unakrsnu poveznicu. `heading` i dalje sadrži samo tekst.

### 3.1 Zajednička pravila atoma

Navod, fusnota i unakrsna poveznica su inline atomi:

- zauzimaju točno jednu poziciju i nemaju ključeve `marks`, `id`, `text` (osim fusnote, odjeljak 3.3) ni `children`;
- skup ključeva svakog atoma je zatvoren: svaki drugi ključ daje `UNKNOWN_FIELD`;
- tekstni čvorovi s obje strane atoma nisu susjedni u smislu `ADJACENT_TEXT_SAME_MARKS`. Atomi smiju stajati jedan do drugog, a blok smije sadržavati samo atome;
- neobavezno polje je ili odsutno ili valjano. Prazan niz se odbija, da isto značenje nema dva zapisa;
- u bloku `heading` svaki atom se odbija: navod s `CITATION_NOT_ALLOWED` (kao u v2), fusnota s `FOOTNOTE_NOT_ALLOWED`, unakrsna poveznica s `CROSS_REFERENCE_NOT_ALLOWED`. Izbor ugovora: kasnije dopuštanje u naslovu ne mijenja bajtove postojećih dokumenata, a obrnuto bi ih mijenjalo;
- nema zasebne granice broja atoma; vrijedi granica dokumenta od 2 MiB. Validator i replay rade iterativno;
- u dokumentu v1 i v2 fusnota i unakrsna poveznica daju `INLINE_TYPE_INVALID`. U v2 navod s `via` ili `rq` daje `UNKNOWN_FIELD`, kao i danas.

Skup ZABRANJENO i skup razmaka (Unicode `White_Space`) su oni iz ugovora v2 (odjeljak 3.2) i iz `server/domain/document/forbidden.ts`. „Uredan tekst do N” dalje znači: JSON niz s 1 do N Unicode kodnih točaka, bez znaka iz skupa ZABRANJENO i bez razmaka na početku i kraju (`isAllowedTrimmedText`). Validator ne obrezuje i ne normalizira, nego odbija.

### 3.2 Navod v3

```json
{
  "locator": "str. 12",
  "rq": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "sourceId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "type": "citation",
  "via": "Izmišljeni, 1973"
}
```

| Ključ      | Pravilo                                                                               | Greška                       |
| ---------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| `type`     | točno `"citation"`                                                                    | `INLINE_TYPE_INVALID`        |
| `sourceId` | obavezan, kao u v2                                                                    | `CITATION_SOURCE_ID_INVALID` |
| `locator`  | neobavezan, kao u v2 (1 do 100 kodnih točaka, bez ZABRANJENO; razmaci se ne odbijaju) | `CITATION_LOCATOR_INVALID`   |
| `via`      | neobavezan; uredan tekst do 200                                                       | `CITATION_VIA_INVALID`       |
| `rq`       | neobavezan; kanonski UUID v4 malim slovima, nil odbijen                               | `CITATION_REQUEST_INVALID`   |

- **`via`** je izvornik koji student nije čitao, nego ga navodi prema izvoru `sourceId` (sekundarni navod, „cit. prema”; prototip `sources2.js`, polje „ako izvornik niste čitali”, `app.js` `citeInner`). To je slobodan tekst kakav je student upisao, ne upućuje na zapis izvora i ne ulazi u bibliografiju. Prikaz: `via`, zatim „cit. prema” i oblik navoda za `sourceId` (npr. „(Izmišljeni, 1973, cit. prema Autorica, 2019: 14)”). Granica od 200 kodnih točaka je izbor ugovora.
- **`rq`** je oznaka zahtjeva „Mentor traži potvrdu” uz taj navod (prototip `sources2.js`, `s2Req`). Sam zahtjev (tko, kada, je li potvrda priložena) nije u dokumentu. Izbor ugovora: oznaka je UUID v4 zapisa zahtjeva izvan dokumenta, a ne prototipni niz `rq…`, da bude isti prostor ID-eva kao ostali zapisi poslužitelja. Oznaka bez zapisa zahtjeva (zahtjev povučen, riješen ili nepoznat) je valjana i prikazuje se kao navod bez zahtjeva, kao siroče navoda u v2. Tko i kada upisuje `rq`, otvoreno je (odjeljak „Otvorena pitanja”, P1).
- Navod siroče (izvor nije u `sources`) je valjan, kao u v2 (ugovor v2, odjeljak 3.3).

### 3.3 Fusnota

```json
{ "text": "Objašnjenje koje ne pripada tijelu teksta.", "type": "footnote" }
```

| Ključ  | Pravilo                        | Greška                  |
| ------ | ------------------------------ | ----------------------- |
| `type` | točno `"footnote"`             | `INLINE_TYPE_INVALID`   |
| `text` | obavezan; uredan tekst do 2000 | `FOOTNOTE_TEXT_INVALID` |

- Fusnota je atom s običnim tekstom, kao u prototipu (`features.js`, čvor `footnote` s atributom `text`; „samo objašnjenje, bez citiranja”). Nema oznaka (podebljano, kurziv), navoda ni drugih čvorova u sebi.
- Izbor ugovora: prijelom retka i tab su u skupu ZABRANJENO, pa fusnota ima jedan odlomak. Editor ih pri umetanju pretvara u razmak; validator ih odbija, ne mijenja. Granica od 2000 kodnih točaka je izbor ugovora.
- Broj fusnote se ne sprema. Izvodi se redom pojavljivanja u dokumentu (prva fusnota u dokumentu je 1), kao u prototipu (`.fn` se numerira nakon iscrtavanja). Premještanje fusnote mijenja brojeve bez ijednog dodatnog koraka.
- Fusnota s praznim tekstom ne postoji: brisanje teksta je brisanje fusnote.

### 3.4 Unakrsna poveznica

```json
{ "targetId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "type": "crossReference" }
```

| Ključ      | Pravilo                                               | Greška                           |
| ---------- | ----------------------------------------------------- | -------------------------------- |
| `type`     | točno `"crossReference"`                              | `INLINE_TYPE_INVALID`            |
| `targetId` | obavezan; kanonski UUID v4 malim slovima, nil odbijen | `CROSS_REFERENCE_TARGET_INVALID` |

- `targetId` je `id` bloka na koji poveznica upućuje. U v3 jedini cilj koji prikaz razrješava je naslov (`heading`). Tablica i slika (prototip `kind` `t` i `s`) dolaze sa shemom v4.
- Izbor ugovora: nema polja `kind`. Vrsta cilja izvodi se iz bloka na koji `targetId` upućuje. Spremljena vrsta mogla bi se razići s ciljem. Ako v4 doda cilj koji nije blok s `id`-em, polje dodaje v4.
- Poveznica čiji `targetId` nije `id` nijednog bloka, ili jest, ali blok nije naslov, je valjana. Validator je ne odbija, ne briše i ne mijenja. Prikaz je pokazuje kao poveznicu bez cilja („Ono na što referenca upućuje više ne postoji.”, prototip `features.js`). Razlog: brisanje poglavlja ili pretvaranje naslova u odlomak ne smije postati nevaljan korak.
- Tekst poveznice („poglavlje 2.1”) se ne sprema. Izvodi se iz trenutačnog broja cilja (odjeljak 4), pa se mijenja sam kad se poglavlje premjesti.
- ID-evi blokova i ID-evi izvora su odvojeni prostori: `targetId` nikad ne upućuje na izvor, a `sourceId` nikad na blok.

## 4. Izvedeno, ne spremljeno

Isto načelo kao bibliografija u v2 (ugovor v2, odjeljak 4): što se može izvesti iz hashiranih bajtova, ne sprema se drugi put.

- Bibliografija: kao u v2. `via` ne daje unos.
- Broj fusnote: redoslijed fusnota u dokumentu (odjeljak 3.3).
- Broj poglavlja i tekst unakrsne poveznice: iz redoslijeda i razine naslova (`deriveChapters`).
- Stil s navodima u fusnotama (prototip `citeStyle: 'fusnote'`) je način prikaza i izvoza. Ne stvara čvorove `footnote` i ne mijenja dokument.

Izvođenje je čista i totalna funkcija: svaki dokument valjan po odjeljcima 1 do 3 daje rezultat bez iznimke.

## 5. Format koraka `ductus-edit-steps-v3`

Format v3 je format v2 (ugovor v2, odjeljak 5) uz ova pravila. Sve ostalo vrijedi nepromijenjeno: zatvoreni ključevi, zabranjeni `__proto__`, `constructor` i `prototype`, ID novog bloka `null`, `MAX_EDIT_STEP_BYTES`, kanonski oblik i kodovi odbijanja.

1. **Atomi u sliceu.** Slice smije sadržavati navod v3, fusnotu i unakrsnu poveznicu u obliku iz odjeljka 3, s istim pravilima polja. Nevaljano polje daje `invalid_value` s putem polja, a atom u naslovu `invalid_node`. Format v1 odbija svaki atom (`invalid_node`), a format v2 fusnotu i unakrsnu poveznicu (`invalid_node`) te `via` i `rq` (`unknown_field`).
2. **Jedna pozicija.** `from`, `to` i `gapFrom` koji bi presjekli atom odbijaju se s `invalid_position`.
3. **B-12.** Svaki korak koji uklanja raspon s barem jednim atomom nosi `removedSha256`: SHA-256 nad `removedRangeCanonical`, JCS sliceom sa svim atributima atoma (`sourceId`, `locator`, `via`, `rq`, `text`, `targetId`). Korak sa `structure` preko atoma odbija se s `not_canonical`.
4. **Promjena atributa atoma je zamjena.** Izmjena teksta fusnote, `locator`, `via` i `rq` te postavljanje ili uklanjanje `rq` piše se kao `replace` jedne pozicije atoma sliceom s novim atomom i s `removedSha256` starog atoma. Tako ProseMirror piše `setNodeMarkup` nad listom (`replaceWith`). Korak `attr` i dalje mijenja samo `nodeId` bloka. Izbor ugovora: nijedan atribut atoma ne mijenja se bez hasha starog oblika.
5. **Oznake.** `addMark` i `removeMark` preko raspona s atomom ostavljaju atom bez oznaka, kao navod u v2. Replay to drži testom.
6. **Koraci nad izvorima.** `sourceSet` i `sourceRemove` kao u v2.
7. **Izbor formata.** Replay bira format prema `schemaVersion` revizije nula rada: `1` je `ductus-edit-steps-v1`, `2` je `ductus-edit-steps-v2`, `3` je `ductus-edit-steps-v3`. Svaki drugi format nad radom se odbija i ništa se ne upisuje (ugovor v2, odjeljak 5.4). `parseEditSteps` prima sva tri formata i za nepoznat vraća `unsupported_format`.

ProseMirror oblik atoma u replayu: `{type: "citation", attrs: {sourceId, locator, via, rq}}` (neobavezno odsutno je `null`), `{type: "footnote", attrs: {text}}` i `{type: "crossReference", attrs: {targetId}}`. Editor v3 (WEB-7A) mora koristiti shemu koja daje isti JSON, inače se njegovi koraci ne mogu ponoviti.

## 6. v3 revizija nula

Struktura kao u v2 (jedan prazan odlomak s fiksnim ID-om `00000000-0000-4000-8000-000000000000`, `sources: []`), uz `schemaVersion: 3`:

```
{"nodes":[{"children":[],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":3,"sources":[]}
```

- SHA-256 tih UTF-8 bajtova je `b6d1831785f40ae90b5a44a70d28b401913eecd347f02961f14874734fcd9141` (izračunato izvan koda, `sha256sum`). Test ga uspoređuje sa zapisanim heksom, a ne s ponovnim izračunom.
- Konstante v1 i v2 (`REVISION_ZERO_JCS`, `REVISION_ZERO_SHA256`, `REVISION_ZERO_V2_JCS`, `REVISION_ZERO_V2_SHA256`) ostaju nepromijenjene. Dodaju se `REVISION_ZERO_V3_JCS` i `REVISION_ZERO_V3_SHA256`.

## 7. Prihvat i verzija rada

- Domena (`validateVersionedDocument`, `verifyVersionedDocumentSnapshot`) prihvaća v1, v2 i v3, svaki po svojim pravilima. `validateDocument` i dalje prima samo v1.
- Ovaj zadatak ne mijenja bazu. Nijedan rad ne postaje v3, a `app.open_student_work` i dalje upisuje reviziju nula kakvu danas upisuje. Okidač iste verzije (SRV-33) odbija snimku v3 za rad v1 ili v2, pa se v3 dokument ne može upisati u postojeći rad.
- Rad postaje v3 tek kasnijim korakom baze, istim putem kao v2 (ugovor v2, odjeljak 7): v3 funkcija revizije nula, provjera formata `ductus-edit-steps-v3` naspram revizije nula u poslužiteljskom prihvatu i validator odsječka koji prima taj format. Korak baze ide tek kad editor v3 (WEB-7A) piše dokument i korake v3.
- Nema pretvorbe v2 u v3 postojećeg rada. Rad zadržava verziju revizije nula (D-225).

## 8. Potrošači inline čvorova

Nijedan potrošač atom ne izostavlja tiho, ne pretvara u tekstni čvor i ne baca iznimku na valjanom dokumentu v3.

| Potrošač                         | Mjesto                                              | Ishod                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeDocument`              | `server/domain/document/normalize.ts`               | atom ostaje zaseban čvor, bajt-jednak; tekst se ne spaja preko njega                                                                                             |
| `documentsEqual`, `contentEqual` | `server/domain/document/equality.ts`                | atomi su jednaki samo uz isti tip i ista polja (odsutno nije jednako postojećem); atom nikad nije jednak tekstu; dokumenti različitih verzija nikad nisu jednaki |
| `textBlocksOf`                   | `server/domain/document/text-blocks.ts`             | navod v3 u vidljivom obliku, s `via` ispred „cit. prema”; fusnota i unakrsna poveznica bez znakova u tekstu bloka                                                |
| `documentWordCount`              | `server/domain/document/word-count.ts`              | svaki atom je jedna pozicija bez riječi koja razdvaja tekst s obje strane; tekst fusnote se ne broji                                                             |
| `deriveChapters`                 | `server/domain/document/chapters.ts`                | naslov nema atoma, pa je nepromijenjen                                                                                                                           |
| replay v3                        | `server/external/storage/edit-steps-v3-*.ts` (novo) | odjeljak 5                                                                                                                                                       |
| rekonstrukcija predaje           | `server/evidence/submission-reconstruction.ts`      | v3 rad replayerom v3 od v3 revizije nula; nepoznata verzija `unavailable` kao danas                                                                              |

Izbor ugovora za `textBlocksOf` i `documentWordCount`: brzi put nastavnika i broj riječi prikazuju tijelo teksta. Prikaz fusnote i poveznice u tekstu je posao sučelja (UI-7A, WEB-7A), koje ima i broj fusnote i broj cilja.

## 9. Redoslijed PR-ova

1. **Ugovor** (ovaj dokument).
2. **Shema i validator:** `schema.ts` (tipovi i konstante v3), `validate.ts` (v3 pravila i novi kodovi, dodani na kraj popisa), `revision-zero.ts` (v3 konstante), zlatni vektori v3 u `server/domain/document/`, testovi klasa iz odjeljka 10.
3. **Potrošači:** `normalize`, `equality`, `text-blocks`, `word-count` (odjeljak 8), s testom svakog na dokumentu v3 sa sva tri atoma.
4. **Format koraka:** `ductus-edit-steps-v3` u `edit-step.ts` (odjeljak 5), uz nepromijenjeno ponašanje v1 i v2.
5. **Replay:** `server/external/storage/edit-steps-v3-*` (pravila, poslužiteljski i preglednički replayer) i izbor po verziji u `server/evidence/submission-reconstruction.ts`.

Svaki PR ostavlja granu zelenom i ne mijenja nijedan postojeći test v1 ili v2. Korak baze iz odjeljka 7 nije dio SRV-7A.

## 10. Klase ulaza i obavezni testovi

Klase 1 do 31 iz ugovora v2 vrijede i za v3, uz zamjenu verzije. Novo:

| Klasa | Ulaz                                                                                                                                                                                  | Ishod                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 32    | v3 bez `sources`; v3 s nepoznatim ključem; `schemaVersion` `"3"`, `3.5`, `4`                                                                                                          | `SOURCES_NOT_ARRAY`, `UNKNOWN_FIELD`, `SCHEMA_VERSION_INVALID`                |
| 33    | fusnota i unakrsna poveznica u v1 i v2; navod s `via` ili `rq` u v2                                                                                                                   | `INLINE_TYPE_INVALID`; `UNKNOWN_FIELD`                                        |
| 34    | `via`: odsutan, `""`, 1, 200 i 201 kodna točka, razmak na rubu, znak iz ZABRANJENO, broj                                                                                              | prihvat do 200; inače `CITATION_VIA_INVALID`                                  |
| 35    | `rq`: velika slova, nil, v1 UUID, prototipni `rqabc123`, broj, `""`                                                                                                                   | `CITATION_REQUEST_INVALID`                                                    |
| 36    | fusnota: bez `text`, `""`, 1, 2000 i 2001 kodna točka, razmak na rubu, prijelom retka, tab, usamljeni surogat; s `marks`, `id`, `children`                                            | prihvat do 2000; inače `FOOTNOTE_TEXT_INVALID` ili `UNKNOWN_FIELD`            |
| 37    | unakrsna poveznica: bez `targetId`, velika slova, nil, broj; s `kind`, `text`                                                                                                         | `CROSS_REFERENCE_TARGET_INVALID` ili `UNKNOWN_FIELD`                          |
| 38    | fusnota, unakrsna poveznica i navod u `heading`                                                                                                                                       | `FOOTNOTE_NOT_ALLOWED`, `CROSS_REFERENCE_NOT_ALLOWED`, `CITATION_NOT_ALLOWED` |
| 39    | unakrsna poveznica na nepostojeći blok, na odlomak i na naslov; `rq` bez zahtjeva; navod siroče; tri atoma uzastopno; blok samo s atomima; tekst s istim oznakama s obje strane atoma | prihvat, bez promjene bajtova                                                 |
| 40    | v3 revizija nula                                                                                                                                                                      | JCS i SHA-256 jednaki zapisanima u odjeljku 6                                 |
| 41    | korak v3: atom u sliceu; uklanjanje raspona s fusnotom ili poveznicom bez hasha, s krivim hashom, s hashom drugog teksta fusnote                                                      | prihvat; `missing_field` ili `invalid_removed_hash`                           |
| 42    | korak v3: zamjena atoma s promijenjenim `text`, `via`, `rq` ili `locator`, s hashom starog atoma                                                                                      | prihvat; replay daje dokument s novim atributom                               |
| 43    | format v1 i v2 sa sliceom fusnote ili poveznice; v2 s `via`                                                                                                                           | `invalid_node`; `unknown_field`                                               |
| 44    | format v3 nad v2 radom i obrnuto; v3 nad v1 radom                                                                                                                                     | odbijeno, ništa upisano                                                       |
| 45    | potrošači iz odjeljka 8 na v3 dokumentu sa sva tri atoma i sa siročadi                                                                                                                | ishod iz tablice, bez iznimke                                                 |

Uz to fast-check svojstva (a) do (g) iz ugovora v2 vrijede za validator i parser v3, uz generator koji umeće i briše sva tri atoma. Generatori koriste samo sintetičke podatke: „Izvor 1”, „str. 12”, „Izmišljeni, 1973”, izmišljen tekst fusnote i UUID-e oblika `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`. Nema stvarnih radova, osoba, knjiga ni DOI-ja.

## Za klijenta (UI-7A, WEB-7A do WEB-7D)

- Editor v3 imenuje čvorove `citation`, `footnote` i `crossReference`, s atributima iz odjeljka 5, i pretvara ih u kanonski oblik iz odjeljka 3. Prototipni `page` je kanonski `locator`, a prototipni `xref` s `kind` i `target` je `crossReference` s `targetId`.
- Klijent prije umetanja: obrezuje `via` i tekst fusnote, a prijelom retka u fusnoti pretvara u razmak. Neobavezno polje (`locator`, `via`, `rq`) koje bi bilo prazno izostavlja. Fusnota čiji bi tekst bio prazan se ne umeće, a postojeća se uklanja kao cijeli atom (odjeljak 3.3), jer je `text` obavezan.
- Dok rad nije v3 (odjeljak 7), klijent šalje dokument i korake verzije revizije nula rada, a v3 polja ne šalje.
- Broj fusnote, tekst unakrsne poveznice i bibliografija računaju se pri prikazu (odjeljak 4).

## Poznate granice

- Granice duljina (`via` 200, fusnota 2000) i 500 izvora su izbor ugovora. Nisu izmjerene na stvarnim radovima.
- Fusnota ima jedan odlomak i nema oblikovanja. Više odlomaka ili kurziv u fusnoti traže novu verziju sheme.
- Navod, fusnota i unakrsna poveznica nisu dopušteni u naslovu. Kasnije olabavljenje ne mijenja postojeće bajtove.
- Unakrsna poveznica u v3 razrješava se samo na naslov. Tablice i slike dolaze sa shemom v4.
- Lokator od samih razmaka ostaje valjan, kao u v2.

## Otvorena pitanja

- **P1 (`rq`).** U prototipu mentor sam upisuje `rq` u studentov dokument (`setNodeMarkup`). U Ducturi samo studentov editor piše korake u studentovu evidenciju, a nastavnik nema put upisa u nju. Ugovor zato određuje samo oblik `rq`. Tko i kada ga upisuje (npr. studentov editor kad student otvori zahtjev) i gdje živi zapis zahtjeva, odlučuje orkestrator ili vlasnik, prije PR-a koji `rq` puni. Do tada nijedan put ne upisuje `rq`, a validator ga prihvaća.

## Što bi ovaj ugovor moglo oboriti na reviewu?

- Čitanje `rq` kao podatka koji upisuje nastavnik (P1).
- Odbijanje prijeloma retka u fusnoti (odjeljak 3.3) i zabrana atoma u naslovu (odjeljak 3.1): oboje je strože od prototipa i može se kasnije olabaviti bez promjene bajtova.
- Unakrsna poveznica bez polja `kind` (odjeljak 3.4).
