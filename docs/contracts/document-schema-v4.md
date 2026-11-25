# Dokument v4: bogati sadržaj, oznake i naslovnica

SRV-10A `shema-v4-dokument`, val 10, `Risk: critical`. Ovaj ugovor je nasljednik [`document-schema-v3.md`](document-schema-v3.md) (dalje „ugovor v3”), a preko njega i Ductusova [`docs/contracts/document-schema-v2.md`](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/contracts/document-schema-v2.md) („ugovor v2”). Određuje dokument v4, format koraka `ductus-edit-steps-v4` i v4 reviziju nula. Kod dolazi u PR-ovima iz odjeljka 11, a svaki nosi testove iz odjeljka 12.

Izvori:

- `PLAN-MIGRACIJE.md` (ductura/.github, grana `docs/kanonski-plan-ducture`, `docs/plan`): „Shema dokumenta: nesklad i gdje se rješava” (shema v4 = prikaz, formula, fxi, prijelom stranice, okvir, blok koda, `vg`, oznake sup, sub, hl, lang i link te `paste` i `imported`) i „Val 10: Bogati sadržaj i stranice (shema v4), izvoz”;
- vlasnikove odluke iz plana: ✓ C-1 (shema po valovima), ✓ B-7 (oznaka lijepljenja ostaje, uz napomenu da je tekst kasnije mijenjan); oznaka `aitext` nije u v4, nego u valu 12;
- nalog orkestratora za SRV-10A (Ductus#2028, c.7041083305): tablica, slika (privitak i obrezivanje), formula, blok koda, okvir, prijelom stranice, strani jezik, naslovnica i oblik stranice, oznake `paste` i `imported`; validator, kanonski JCS, nepoznata polja odbijena (B-8);
- prototip editora (`Institution_front_web_chrome`, `docs/prototip/editor`: `features.js`, `rich.js`, `more2.js`, `pages.js`, `acad.js`, `stem.js`) i `docs/prototip/INVENTAR-editor.md` (odjeljci 2.3, 2.4 i 2.6: „Prilagođeni čvorovi”, rich, more2, pages, acad, stem);
- Ductus `docs/PRODUCT.md` §5, pravila 5, 7 i 8;
- ugovori v2 i v3 u cijelosti: sve što ovaj ugovor ne mijenja, vrijedi kako ondje piše;
- postojeći kod: `server/domain/document/{schema,validate,validate-sources,forbidden,edit-step,revision-zero,normalize,equality,text-blocks,word-count,chapters}.ts`, `server/external/storage/edit-steps-v2-rules.ts`, `server/external/storage/editor/`, `server/evidence/submission-reconstruction.ts`.

Gdje ugovor provodi plan tehničkim izborom, uz pravilo piše „izbor ugovora”, da review može provjeriti svaki takav izbor. Što izvori ne pokrivaju, nalazi se u odjeljcima „Poznate granice” i „Otvorena pitanja”.

## Invarijanta

Dokument v4 je jedan JCS (RFC 8785) objekt čiji SHA-256 pokriva tekst sa svim oznakama i njihovim atributima, sve blokove i atome sa svim poljima, zapise izvora, podatke naslovnice i SHA-256 svake priložene slike. Nijedan put (validator, snimka, korak, replay, rekonstrukcija, izvoz, poslužitelj) to ne mijenja, ne skraćuje i ne briše tiho. Rad ima jednu verziju od revizije nula do predaje. Radovi v1, v2 i v3 ostaju bajt-jednaki i valjani: nijedan put ih ne pretvara u v4.

Posljedica za slike: bajtovi slike nisu u dokumentu, ali njihov SHA-256 jest. Zamjena bajtova slike bez promjene dokumenta otkriva se usporedbom hasha, a izvoz i rekonstrukcija nikad ne koriste privitak čiji se hash ne slaže (odjeljak 5.2).

## 1. Gornja razina

| Ključ           | Oblik                       | Pravilo                                                          |
| --------------- | --------------------------- | ---------------------------------------------------------------- |
| `schemaVersion` | JSON broj `4`               | Bilo što drugo daje `SCHEMA_VERSION_INVALID`, bez zaokruživanja. |
| `nodes`         | niz blokova, barem jedan    | Blokovi iz odjeljka 2.                                           |
| `sources`       | niz zapisa izvora, 0 do 500 | Kao u v2 i v3 (ugovor v2, odjeljci 1 i 2).                       |
| `cover`         | objekt, neobavezan          | Podaci naslovnice (odjeljak 7).                                  |

- Skup ključeva je zatvoren (`UNKNOWN_FIELD`). `cover` je ili odsutan ili valjan.
- `DOCUMENT_BLOCK_TYPES_BY_VERSION` dobiva `4` sa skupom blokova iz odjeljka 2. Taj `Map` ostaje jedini popis prihvaćenih verzija.
- `DOCUMENT_FIELDS` za v4 je `{schemaVersion, nodes, sources, cover}`, uz `cover` neobavezan.
- Granica od 2 MiB (`MAX_DOCUMENT_SNAPSHOT_BYTES`) vrijedi za cijeli dokument.
- Svi brojevi u dokumentu v4 su cijeli brojevi (JSON broj bez razlomka i eksponenta, `Number.isSafeInteger`, bez `-0`). Izbor ugovora: JCS zapis decimalnog broja ovisi o pretvorbi broja u tekst, pa se postoci i mjere pišu cijelim brojevima.

## 2. Blokovi v4

| `type`        | Vrsta                       | Novo u v4      | Sadržaj                                           |
| ------------- | --------------------------- | -------------- | ------------------------------------------------- |
| `paragraph`   | tekstni blok                | `variantGroup` | inline čvorovi                                    |
| `heading`     | tekstni blok, razina 1 do 3 | ne             | samo tekst (s oznakama)                           |
| `bulletItem`  | tekstni blok                | ne             | inline čvorovi                                    |
| `orderedItem` | tekstni blok                | da             | inline čvorovi (odjeljak 2.2)                     |
| `quote`       | tekstni blok                | ne             | inline čvorovi                                    |
| `codeBlock`   | tekstni blok                | da             | samo tekst, bez oznaka (odjeljak 4.2)             |
| `box`         | omotač                      | da             | jedan ili više blokova `paragraph` (odjeljak 4.3) |
| `table`       | atom bloka                  | da             | polja (odjeljak 5.1)                              |
| `image`       | atom bloka                  | da             | polja (odjeljak 5.2)                              |
| `formula`     | atom bloka                  | da             | polja (odjeljak 4.1)                              |
| `pageBreak`   | atom bloka                  | da             | nema (odjeljak 4.4)                               |

Zajednička pravila blokova:

- Svaki blok, uključujući atom bloka i omotač, ima `id` po pravilima v1 (UUID, jedinstven u cijelom dokumentu, bez obzira na velika i mala slova). Blok unutar okvira (`box`) dijeli isti prostor ID-eva.
- Skup ključeva svakog bloka je zatvoren (`UNKNOWN_FIELD`). Neobavezno polje je ili odsutno ili valjano; prazan niz, prazan objekt i prazan tekst se odbijaju, da isto značenje nema dva zapisa.
- Gniježđenje postoji samo na jednom mjestu: `box` sadrži blokove `paragraph`. Nijedan drugi blok ne sadrži blok, a `box` ne stoji u `box`.
- Atom bloka (`table`, `image`, `formula`, `pageBreak`) zauzima jednu poziciju, kao inline atom u v3: nema `children` i ne sadrži tekstne čvorove.
- Tekstni blokovi v1 do v3 i njihova pravila (prazan blok je `children: []`, `ADJACENT_TEXT_SAME_MARKS`, naslov bez atoma) vrijede nepromijenjeni, uz oznake iz odjeljka 3 i atom iz odjeljka 4.1.

### 2.1 `variantGroup` na odlomku

```json
{
  "children": [],
  "id": "…",
  "type": "paragraph",
  "variantGroup": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
}
```

- Neobavezan; kanonski UUID v4 malim slovima, nil odbijen (`VARIANT_GROUP_INVALID`). Samo na `paragraph` (i na odlomku u okviru); na drugom bloku je `UNKNOWN_FIELD`.
- Odlomci s istom vrijednosti su inačice istog mjesta (prototip `features.js`, `insVar`, `varKeep`). Broj inačice („inačica 2”) se ne sprema: izvodi se redom pojavljivanja u dokumentu.
- Odlomci iste skupine ne moraju biti susjedni i ne moraju biti dva. Skupina s jednim odlomkom je valjana: editor je pri „Zadrži samo ovu inačicu” uklanja (prototip briše `vg`), a validator je ne odbija.
- Svaka inačica je obični odlomak dokumenta, pa njezin nastanak i ulazak u dokument bilježe koraci kao i svaki drugi tekst (PRODUCT §5, pravilo 8).

### 2.2 `orderedItem` (numerirani popis, prototip `olist`)

Stavka numeriranog popisa je plosnat tekstni blok iste razine kao `bulletItem`, nikad omotač: uzastopne stavke su jedan popis. Nema polja osim `type`, `id` i `children`, i vrijede sva pravila tekstnog bloka (oznake iz odjeljka 3, inline atomi v3, prazna stavka je `children: []`).

- **Broj se ne sprema.** Broj stavke je njezin položaj u nizu uzastopnih blokova `orderedItem` (od 1); bilo koji drugi blok prekida niz, a sljedeća stavka opet počinje od 1. Zato isti sadržaj ima samo jedan zapis, a umetanje ili brisanje stavke ne mijenja druge blokove. Broj računaju prikaz i izvoz (odjeljak 8).
- **Bez gniježđenja.** Stavka ne sadrži blok, a popis u popisu ne postoji. Blok u `children` daje postojeću šifru `INLINE_TYPE_INVALID`, nepoznato polje `UNKNOWN_FIELD`, a ponovljeni `id` `NODE_ID_DUPLICATE`. Nema nove šifre greške.
- **Samo v4.** Blok nije u shemama v1 do v3 (`NODE_TYPE_INVALID`). Promjena je MINOR i kompatibilna unatrag: dokument bez ovog bloka ostaje valjan i ima iste bajtove i hash.
- Potrošači (odjeljak 11): brojanje riječi, normalizacija i jednakost tretiraju stavku kao svaki tekstni blok. Čitač teksta (`textBlocksOf`) i usporedba verzija (`work.compare.get`, vremenski stroj) daju stavku kao blok vrste `paragraph` s njezinim tekstom, jer žičani ugovor tih ruta poznaje samo vrste `heading`, `paragraph`, `bulletItem` i `quote`, a nova vrsta bila bi lomljenje ugovora. Broj stavke nije tekst pa nije dio usporedbe; zamjena odlomka stavkom istog teksta nije razlika u usporedbi. DOCX izvoz piše „1. ”, „2. ” ispred stavke, pa je sposobnost izvoza `degraded`, kao za `bulletItem`.

## 3. Oznake teksta v4

U v1 do v3 `marks` je niz nizova `"bold"` i `"italic"`. U v4 element niza je ili niz (oznaka bez atributa) ili objekt (oznaka s atributima):

| Oznaka       | Zapis                                                                  | Pravilo atributa                                                                                | Prototip                 |
| ------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------ |
| podebljano   | `"bold"`                                                               | nema                                                                                            | Bold                     |
| kurziv       | `"italic"`                                                             | nema                                                                                            | Italic                   |
| eksponent    | `"sup"`                                                                | nema                                                                                            | more2 `sup`              |
| indeks       | `"sub"`                                                                | nema                                                                                            | more2 `sub`              |
| marker       | `{"color": "#f2d24b", "type": "highlight"}`                            | `color`: `#` i šest malih heksadekadskih znamenki                                               | rich `hl`, atribut `c`   |
| strani jezik | `{"lang": "en", "type": "lang"}`                                       | `lang`: 2 ili 3 mala slova a–z (primarni jezik po BCP 47); `und` je „drugi jezik”               | acad `lang`, atribut `l` |
| poveznica    | `{"href": "https://primjer.invalid/", "type": "link"}`                 | `href`: `https://`, `http://` ili `mailto:` i barem jedan znak U+0021 do U+007E, ukupno do 2048 | acad `link`              |
| zalijepljeno | `{"pasteId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "type": "paste"}` | `pasteId` obavezan, `sourceId` neobavezan; oba kanonski UUID v4 malim slovima, nil odbijen      | features `paste`         |
| uvezeno      | `"imported"`                                                           | nema                                                                                            | features `imported`      |

- **Kanonski redoslijed** je redoslijed retka u tablici: `bold`, `italic`, `sup`, `sub`, `highlight`, `lang`, `link`, `paste`, `imported`. Niz je poredan po njemu (`MARKS_UNSORTED`), a svaka vrsta se pojavljuje najviše jednom, bez obzira na atribute (`MARKS_DUPLICATE`).
- `sup` i `sub` se isključuju: tekst s obje oznake daje `MARKS_EXCLUSIVE` (prototip `excludes`).
- Oznaka bez atributa piše se samo kao niz; objekt `{"type": "bold"}` je `MARK_INVALID`. Oznaka s atributima piše se samo kao objekt; niz `"lang"` je `MARK_INVALID`. Objekt oznake ima zatvoren skup ključeva (`UNKNOWN_FIELD`); nevaljan atribut daje `MARK_ATTRIBUTE_INVALID` s putem atributa.
- `ADJACENT_TEXT_SAME_MARKS` u v4 uspoređuje oznake s atributima: dva susjedna tekstna čvora s `lang` `en` i `de` nisu iste oznake, a s dva puta `en` jesu.
- Oznake smiju stajati na tekstu u `paragraph`, `heading`, `bulletItem`, `orderedItem` i `quote`. U `codeBlock` smiju samo oznake podrijetla `paste` i `imported`, a oznake oblikovanja ne (odjeljak 4.2). Inline atomi i dalje nemaju `marks`.
- U dokumentima v1 do v3 svaka oznaka osim `bold` i `italic`, i svaki objekt u `marks`, daje `MARK_INVALID`, kao danas.

### 3.1 `paste` i `imported` (✓ B-7)

- **`paste`** označava tekst koji je u dokument ušao lijepljenjem izvana. `pasteId` je UUID v4 koji editor stvori pri jednom lijepljenju; svi tekstni čvorovi tog lijepljenja nose isti `pasteId`. `sourceId` je ID zapisa izvora ako ga je editor prepoznao (prototip `src`); ne mora postojati u `sources` (siroče je valjano, kao navod u v2).
- **`imported`** označava tekst unesen uvozom datoteke (prototip „Uvezeni tekst, nastao prije Ducture”, dijalog „Uvoz teksta”).
- **Oznaka ostaje (✓ B-7).** `paste` i `imported` ulaze u dokument samo sa sliceom koraka `replace` koji umeće taj tekst, a izlaze samo s uklanjanjem samog teksta. Koraci `addMark` i `removeMark` s `paste` ili `imported` se odbijaju (odjeljak 9). Prototipno uklanjanje oznake nakon parafraze (`appendTransaction`, manje od 35 % trigrama) se ne prenosi.
- **„Tekst je kasnije mijenjan” je izvedeno, ne spremljeno.** Izvorni zalijepljeni tekst je tekst koji je korak lijepljenja umetnuo s tim `pasteId` i nalazi se u zapisu koraka. Tekst je mijenjan ako se tekst svih čvorova s tim `pasteId`, redom pojavljivanja, razlikuje od njega. Računa se pri prikazu iz evidencije (odjeljak 8).
- Izbor ugovora: prototipni atributi `orig` (izvorni tekst) i `ok` (obrazloženje potvrde) nisu u dokumentu. `orig` bi se ponavljao na svakom tekstnom čvoru lijepljenja i udvostručio dokument, a već je u zapisu koraka. `ok` je studentova izjava uz lijepljenje, zapis izvan dokumenta kao zahtjev `rq` u v3 (odjeljak „Otvorena pitanja”, P3).
- Oznaka mjesta i vrste unosa nije tvrdnja o autoru (PRODUCT §5, pravila 1 i 8). Tekst sučelja za `paste` koristi „zalijepljeno”, nikad izraze iz Rječnika.

### 3.2 Marker

- `highlight` je studentovo bojenje teksta (prototip „Marker je Vaše označavanje”). Izbor ugovora: boja je uvijek `#rrggbb` malim slovima. Prototipni ključevi pretvaraju se u boju pri umetanju: `y` → `#f2d24b`, `g` → `#7fc97f`, `b` → `#7fb2e5`, `r` → `#ef9aa7`. Prozirnost je stvar prikaza i nije u dokumentu.
- Prikazuje li se marker nastavniku i ide li u izvoz, otvoreno je (P2). Validator ga prihvaća.

## 4. Formula, blok koda, okvir, prijelom stranice

### 4.1 Formula

Blok:

```json
{ "id": "…", "tex": "\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i", "type": "formula" }
```

U retku (inline atom):

```json
{ "tex": "x^{2}", "type": "inlineFormula" }
```

| Polje | Pravilo                                                                   | Greška                |
| ----- | ------------------------------------------------------------------------- | --------------------- |
| `tex` | obavezan; uredan tekst do 4000 (blok) ili do 1000 (u retku) kodnih točaka | `FORMULA_TEX_INVALID` |

- „Uredan tekst” je onaj iz ugovora v3 (odjeljak 3.1, `isAllowedTrimmedText`): bez znaka iz skupa ZABRANJENO i bez razmaka na rubu. Prijelom retka je u skupu ZABRANJENO; u LaTeX-ovom matematičkom načinu prijelom retka znači razmak, pa ga editor pri spremanju pretvara u razmak.
- Validator ne provjerava je li `tex` ispravan LaTeX. Formula koju KaTeX ne može iscrtati je valjana i prikazuje se kao zapis (prototip „bez KaTeX-a `<code>`”).
- Prazna formula ne postoji: brisanje zapisa je brisanje formule (prototipno „prazna formula” se ne sprema).
- Broj formule („(3)”) se ne sprema; izvodi se redom blok-formula u dokumentu. Formula u retku nema broj (prototip `fxi`).
- `inlineFormula` je inline atom po pravilima ugovora v3, odjeljak 3.1: jedna pozicija, bez `marks`, nije dopušten u naslovu (`INLINE_FORMULA_NOT_ALLOWED`), u v1 do v3 je `INLINE_TYPE_INVALID`.

### 4.2 Blok koda

```json
{
  "caption": "Funkcija za izračun prosjeka",
  "children": [
    { "marks": [], "text": "def prosjek(xs):\n    return sum(xs) / len(xs)", "type": "text" }
  ],
  "id": "…",
  "language": "python",
  "type": "codeBlock"
}
```

| Polje      | Pravilo                                                                      | Greška                  |
| ---------- | ---------------------------------------------------------------------------- | ----------------------- |
| `language` | neobavezan; jedan od `c`, `html`, `java`, `javascript`, `python`, `r`, `sql` | `CODE_LANGUAGE_INVALID` |
| `caption`  | neobavezan; uredan tekst do 300                                              | `CODE_CAPTION_INVALID`  |
| `children` | niz tekstnih čvorova; od oznaka samo `paste` i `imported`; bez inline atoma  | `CODE_CONTENT_INVALID`  |

- Blok koda je tekstni blok kao odlomak, pa se u njemu tipka koracima nad tekstom. Tekst smije sadržavati prijelom retka (U+000A), kao svaki tekstni čvor. Prazan blok koda je `children: []`.
- Izbor ugovora: oznake podrijetla `paste` i `imported` smiju na tekst bloka koda, jer oznaka ostaje do uklanjanja samog teksta (odjeljak 3.1, ✓ B-7): kod zalijepljen ili uvezen u blok koda, i odlomak s takvim tekstom pretvoren u blok koda, zadržavaju oznaku. Oznake oblikovanja (`bold` do `link`) u bloku koda ne postoje; pretvorba odlomka u blok koda ih uklanja kao `removeMark`.
- Odsutan `language` znači „bez bojenja” (prototip `''`). Prototipni `c` pokriva C, C++ i C#.
- Broj ispisa („Ispis 2.”) se ne sprema; izvodi se redom blokova koda.
- Tab: editor ga pretvara u četiri razmaka (prototip). Validator ne odbija tab u tekstu koda, jer ga ne odbija ni u drugom tekstu.

### 4.3 Okvir

```json
{
  "children": [
    {
      "children": [{ "marks": [], "text": "Svaki konačan skup je ograničen.", "type": "text" }],
      "id": "…",
      "type": "paragraph"
    }
  ],
  "id": "…",
  "kind": "theorem",
  "type": "box"
}
```

| Polje      | Pravilo                                                                                  | Greška                 |
| ---------- | ---------------------------------------------------------------------------------------- | ---------------------- |
| `kind`     | obavezan; `definition`, `theorem`, `lemma`, `corollary`, `example`, `remark` ili `proof` | `BOX_KIND_INVALID`     |
| `children` | niz s barem jednim blokom `paragraph`; nijedan drugi blok                                | `BOX_CHILDREN_INVALID` |

- Vrste odgovaraju prototipnim `BX` (`stem.js`): `def` Definicija, `teorem` Teorem, `lema` Lema, `korolar` Korolar, `primjer` Primjer, `napomena` Napomena, `dokaz` Dokaz.
- Broj okvira („Teorem 2.”) se ne sprema; izvodi se redom okvira iste vrste. `proof` nema broj.
- `children` koji nije niz je `CHILDREN_NOT_ARRAY`, kao u tekstnom bloku.
- Izbor ugovora: okvir je jedino gniježđenje u v4, jer je u prototipu omotač odlomaka (`tbox`, `content: 'paragraph+'`), a dva uzastopna okvira iste vrste moraju ostati dva. Plosnati zapis (svaki odlomak nosi vrstu) ne bi ih razlikovao.

### 4.4 Prijelom stranice

```json
{ "id": "…", "type": "pageBreak" }
```

Bez ikakvih drugih polja. Tvrdi prijelom: sljedeći blok u izvozu i u prikazu stranica počinje na novoj stranici (prototip `more2.js`, `pages.js`).

## 5. Tablica i slika

Prototipni čvor `prikaz` s `kind` `tablica` ili `slika` u v4 su dva bloka, `table` i `image`, svaki sa svojim zatvorenim skupom ključeva. Oba su atomi bloka. Zajednička polja:

| Polje    | Pravilo                                        | Greška                  |
| -------- | ---------------------------------------------- | ----------------------- |
| `title`  | neobavezan; uredan tekst do 500 (naslov iznad) | `FIGURE_TITLE_INVALID`  |
| `source` | neobavezan; uredan tekst do 500 („Izvor: …”)   | `FIGURE_SOURCE_INVALID` |

Broj („Tablica 3.”, „Slika 2.”) se ne sprema; izvodi se redom, posebno za tablice i posebno za slike (prototip `D.prikazN`).

### 5.1 Tablica

```json
{
  "cellFills": [{ "color": "#fff2cc", "column": 1, "row": 2 }],
  "header": true,
  "headerFill": "#dce6f2",
  "id": "…",
  "landscape": false,
  "merges": [{ "column": 0, "columnSpan": 2, "row": 1, "rowSpan": 1 }],
  "rows": [
    ["Grad", "Kućanstva", "Udio"],
    ["Izmišljeni Grad", "", "12 %"],
    ["Drugi Grad", "340", "9 %"]
  ],
  "source": "izrada autora",
  "stripes": true,
  "title": "Kućno kompostiranje po gradovima",
  "type": "table"
}
```

| Polje        | Pravilo                                                                                                              | Greška                |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `rows`       | obavezan; niz od barem jednog retka; redak je niz od barem jedne ćelije; svi retci iste duljine; najviše 3000 ćelija | `TABLE_ROWS_INVALID`  |
| ćelija       | JSON niz: `""` ili tekst od 1 do 1000 kodnih točaka bez znaka iz ZABRANJENO (razmaci na rubu dopušteni)              | `TABLE_CELL_INVALID`  |
| `header`     | obavezan JSON `true` ili `false`: prvi redak je zaglavlje                                                            | `BLOCK_FLAG_INVALID`  |
| `stripes`    | obavezan `true` ili `false`: pruge na parnim retcima tijela                                                          | `BLOCK_FLAG_INVALID`  |
| `landscape`  | obavezan `true` ili `false`: tablica u izvozu stoji na položenoj stranici                                            | `BLOCK_FLAG_INVALID`  |
| `headerFill` | neobavezan; boja `#rrggbb` malim slovima; samo uz `header: true`                                                     | `TABLE_FILL_INVALID`  |
| `cellFills`  | neobavezan; neprazan niz `{row, column, color}`, poredan po `row` pa `column`, bez ponavljanja                       | `TABLE_FILL_INVALID`  |
| `merges`     | neobavezan; neprazan niz `{row, column, rowSpan, columnSpan}`, poredan po `row` pa `column`                          | `TABLE_MERGE_INVALID` |

- Ćelija je običan tekst, bez oznaka, navoda i drugih čvorova (prototip: ćelija je `contenteditable="plaintext-only"`, `rows` je niz nizova teksta). Prijelom retka u ćeliji je u skupu ZABRANJENO; editor ga pretvara u razmak.
- **Spajanje.** `row` i `column` su indeksi od nule gornje lijeve ćelije; `rowSpan` i `columnSpan` su cijeli brojevi od 1, a barem jedan je veći od 1. Područje spajanja leži unutar tablice i ne preklapa se s drugim. Ćelije koje spajanje pokriva, osim gornje lijeve, su `""`. Kršenje bilo kojeg od toga daje `TABLE_MERGE_INVALID`.
- **Boje.** `cellFills` upućuje na ćeliju unutar tablice koja nije pokrivena spajanjem. Prototipni ključevi boja zaglavlja pretvaraju se u boju (Siva `#d9d9d9`, Plava `#dce6f2`, Zelena `#e2efda`, Žuta `#fff2cc`, Ružičasta `#f8dde0`); „Bez boje” je odsutno polje.
- Izbor ugovora: zastavice su obavezne, jer `false` i odsutno polje bili bi dva zapisa istog značenja, a prototip ima različite zadane vrijednosti (`head` zadano uključeno, ostale isključene).
- Grafikon iz tablice (prototip `acChart`) nije čvor: to je nova slika (odjeljak 5.2).

### 5.2 Slika

```json
{
  "align": "center",
  "attachmentId": "ffffffff-ffff-4fff-8fff-ffffffffffff",
  "attachmentSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "crop": { "bottom": 0, "left": 10, "right": 5, "top": 0 },
  "id": "…",
  "landscape": false,
  "source": "izrada autora",
  "title": "Kompostište u dvorištu",
  "type": "image",
  "widthPercent": 60
}
```

| Polje              | Pravilo                                                                                                                  | Greška                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `attachmentId`     | neobavezan; kanonski UUID v4 malim slovima, nil odbijen; dolazi samo zajedno s `attachmentSha256`                        | `IMAGE_ATTACHMENT_INVALID` |
| `attachmentSha256` | neobavezan; 64 mala heksadekadska znaka; dolazi samo zajedno s `attachmentId`                                            | `IMAGE_ATTACHMENT_INVALID` |
| `crop`             | neobavezan; objekt s točno `left`, `right`, `top`, `bottom`, svaki cijeli broj od 0 do 45; ne svi nula; samo uz privitak | `IMAGE_CROP_INVALID`       |
| `widthPercent`     | obavezan; cijeli broj od 20 do 100 (postotak širine teksta)                                                              | `IMAGE_LAYOUT_INVALID`     |
| `align`            | obavezan; `left`, `center` ili `right`                                                                                   | `IMAGE_LAYOUT_INVALID`     |
| `landscape`        | obavezan `true` ili `false`                                                                                              | `BLOCK_FLAG_INVALID`       |

- **Privitak.** Bajtovi slike su privitak rada: zaseban zapis na poslužitelju (tablica privitaka s RLS-om i pgTAP retcima, poseban SRV zadatak vala 10), nikad u dokumentu. Izbor ugovora: prototipni `img` (data URL) nema mjesta u v4; slika ulazi u dokument tek kad privitak postoji i ima hash.
- `attachmentSha256` je SHA-256 točno onih bajtova koje poslužitelj čuva pod `attachmentId`. Prikaz, izvoz i rekonstrukcija čitaju privitak, provjeravaju hash i, ako se ne slaže ili privitka nema, prikazuju sliku kao nedostupnu; nikad ne koriste druge bajtove i nikad ne mijenjaju dokument.
- Slika bez privitka (oba polja odsutna) je valjana: to je prototipno „Slika još nije priložena”.
- Je li `attachmentId` privitak istog rada, validator dokumenta ne zna. To provjerava poslužiteljski put koji privitak čita, iz odnosa pozivatelja prema radu (Ustav C-23), nikad iz samog dokumenta.
- **Obrezivanje.** `crop` je postotak širine (`left`, `right`) ili visine (`top`, `bottom`) izvorne slike koji se pri prikazu i izvozu odreže. Izbor ugovora: obrezivanje ne mijenja privitak; izvorni bajtovi ostaju, pa „Ctrl+Z vraća cijelu” vrijedi i nakon spremanja. Prototip reže sliku u novu sliku; v4 to ne radi.
- Prirodna širina i visina slike (prototip `nw`, `nh`) i vrsta datoteke su podaci privitka, ne dokumenta.

## 6. Unakrsna poveznica u v4

Oblik i pravila iz ugovora v3, odjeljak 3.4, vrijede nepromijenjeni. U v4 prikaz razrješava više vrsta cilja; vrsta se i dalje izvodi iz bloka na koji `targetId` upućuje:

| Cilj                     | Tekst poveznice (izveden)       |
| ------------------------ | ------------------------------- |
| `heading`                | „poglavlje 2.1”                 |
| `table`                  | „Tablica 3”                     |
| `image`                  | „Slika 2”                       |
| `formula`                | „(4)”                           |
| `codeBlock`              | „Ispis 1”                       |
| `box` s brojem           | „Teorem 2”, „Definicija 1” …    |
| bilo što drugo ili ništa | poveznica bez cilja (ugovor v3) |

- `box` vrste `proof`, odlomak, odlomak u okviru, `pageBreak` i nepostojeći blok su „bilo što drugo”.
- Izbor ugovora: prototipni zasebni identitet cilja (`pid`, `rid`) se ne prenosi. Svaki blok ima `id`, pa je on cilj.

## 7. Naslovnica i oblik stranice

```json
{
  "cover": { "date": "studeni 2026.", "place": "Zagreb", "study": "Diplomski studij politologije" }
}
```

| Polje   | Pravilo                         | Greška                |
| ------- | ------------------------------- | --------------------- |
| `cover` | objekt s barem jednim poljem    | `COVER_INVALID`       |
| `study` | neobavezan; uredan tekst do 200 | `COVER_FIELD_INVALID` |
| `place` | neobavezan; uredan tekst do 100 | `COVER_FIELD_INVALID` |
| `date`  | neobavezan; uredan tekst do 50  | `COVER_FIELD_INVALID` |

- U dokumentu su samo podaci naslovnice koje student upisuje (prototip dijalog „Podaci za naslovnicu”: studij, mjesto, mjesec i godina).
- Izbor ugovora: ime studenta i mentora nisu u dokumentu. Prototip kaže „U aplikaciji ime studenta i mentora dolaze iz prijave i zadatka”, a osobni podatak u hashiranom dokumentu ostao bi u evidenciji i nakon promjene imena. Naslov rada dolazi iz prvog naslova razine 1, vrsta rada iz zadatka, a sveučilište i sastavnica iz profila pravila fakulteta. Sve to je izvedeno pri prikazu i izvozu.
- **Oblik stranice** (pismo, veličina, prored, margine, brojevi stranica) nije u dokumentu. Dolazi iz profila pravila fakulteta (prototip `pages.js`: „ne mijenjate ih sami”; PRODUCT §5, pravilo 12). Jedini podatak o stranici u dokumentu je `landscape` na tablici i slici te `pageBreak`.
- `date` je slobodan tekst kakav student upisuje („studeni 2026.”), ne datum za računanje.

## 8. Izvedeno, ne spremljeno

Isto načelo kao u v2 i v3: što se može izvesti iz hashiranih bajtova (ili iz evidencije), ne sprema se drugi put.

- Bibliografija, broj fusnote, broj poglavlja i tekst unakrsne poveznice: kao u v3, uz ciljeve iz odjeljka 6.
- Brojevi tablica, slika, blok-formula, ispisa koda i numeriranih okvira: redom pojavljivanja, svaka vrsta (i svaka vrsta okvira) zasebno.
- Broj inačice odlomka: redom unutar skupine `variantGroup`.
- Broj stavke numeriranog popisa: položaj u nizu uzastopnih `orderedItem` (odjeljak 2.2).
- „Tekst je kasnije mijenjan” uz `paste`: iz evidencije (odjeljak 3.1).
- Naslovnica: odjeljak 7. Prijelomi stranica osim `pageBreak`: mjere se pri prikazu i izvozu.

Izvođenje iz dokumenta je čista i totalna funkcija: svaki dokument valjan po odjeljcima 1 do 7 daje rezultat bez iznimke.

## 9. Format koraka `ductus-edit-steps-v4`

Format v4 je format v3 (ugovor v3, odjeljak 5) uz ova pravila. Sve ostalo vrijedi nepromijenjeno: zatvoreni ključevi, zabranjeni `__proto__`, `constructor` i `prototype`, ID novog bloka `null` (uz iznimku iz točke 3), `MAX_EDIT_STEP_BYTES`, kanonski oblik i kodovi odbijanja.

1. **Slice.** Slice smije sadržavati blokove, atome i oznake iz odjeljaka 2 do 5 u obliku dokumenta, s istim pravilima polja. Nevaljano polje daje `invalid_value` s putem polja, a čvor na mjestu gdje ga v4 ne dopušta (atom u naslovu, oznaka oblikovanja u bloku koda, blok koji nije odlomak u okviru) `invalid_node`. Formati v1 do v3 sve to odbijaju s `invalid_node` ili `unknown_field`, kao danas.
2. **Jedna pozicija.** `from`, `to` i `gapFrom` koji bi presjekli inline atom ili atom bloka odbijaju se s `invalid_position`.
3. **Promjena polja atoma bloka je zamjena.** Izmjena tablice (svaka ćelija, redak, boja, spajanje), slike (privitak, obrezivanje, širina, poravnanje), formule i zastavica piše se kao `replace` točno jedne pozicije atoma bloka sliceom s jednim atomom iste vrste i s `removedSha256` starog atoma. Atom u tom sliceu nosi `nodeId` zamijenjenog bloka: to je nastavak bloka, kao otvorena strana slicea u v2. Replayer provjerava da je `nodeId` jednak i da je vrsta ista; inače `not_canonical`. Tako ProseMirror piše `setNodeMarkup` nad listom (`replaceWith`).
4. **B-12.** Svaki korak koji uklanja raspon s barem jednim atomom (inline ili bloka) nosi `removedSha256`: SHA-256 nad `removedRangeCanonical`, JCS sliceom sa svim poljima. Uklanjanje teksta s oznakama nosi hash kao u v1 do v3; oznake s atributima su u JCS-u.
5. **Okvir.** Omatanje odlomaka u `box`, skidanje okvira (tekst ostaje) i promjena `kind` pišu se kao `replaceAround` (ProseMirror `wrapIn`, `lift`, `setNodeMarkup` nad čvorom koji nije list). Promjena `language` ili `caption` bloka koda i `variantGroup` odlomka također su `replaceAround`, kao promjena razine naslova u v1.
6. **Oznake.** `addMark` i `removeMark` rade s `bold`, `italic`, `sup`, `sub`, `highlight`, `lang` i `link`. S `paste` ili `imported` odbijaju se s `invalid_mark` (✓ B-7, odjeljak 3.1). `addMark` koji bi na tekst s `sup` dodao `sub` (ili obrnuto) zamjenjuje oznaku, kao ProseMirror `excludes`; replay to drži testom. Oznake preko atoma i bloka koda ostavljaju ih bez oznaka.
7. **Naslovnica.** Novi korak `coverSet` postavlja cijeli `cover` (`{stepType: "coverSet", cover: {…}}`) ili ga uklanja (`{stepType: "coverSet"}` bez `cover`); diskriminator je `stepType`, kao u svim koracima od v1. Ako dokument već ima `cover`, korak nosi `removedSha256` nad JCS-om starog `cover`, kao `sourceSet` u v2. Korak koji ne mijenja ništa odbija se s `not_canonical`.
8. **Koraci nad izvorima.** `sourceSet` i `sourceRemove` kao u v2.
9. **Izbor formata.** Replay bira format prema `schemaVersion` revizije nula rada: `1` do `3` kao u v3, `4` je `ductus-edit-steps-v4`. Svaki drugi format nad radom se odbija i ništa se ne upisuje. `parseEditSteps` prima sva četiri formata i za nepoznat vraća `unsupported_format`.

ProseMirror oblik u replayu: svaki blok i atom je čvor istog imena kao `type`; atributi su polja dokumenta bez `type`, `id` i `children` (neobavezno odsutno je `null`), uz identitet bloka kao u v2. `box` ima sadržaj `paragraph+`, `codeBlock` sadržaj `text*` bez oznaka, a atomi bloka su listovi. Oznaka s atributima je `{type, attrs: {…}}` s istim imenima atributa. Editor v4 (WEB-10C) mora koristiti shemu koja daje isti JSON, inače se njegovi koraci ne mogu ponoviti.

## 10. v4 revizija nula i prihvat

Struktura kao u v3 (jedan prazan odlomak s fiksnim ID-om `00000000-0000-4000-8000-000000000000`, `sources: []`, bez `cover`), uz `schemaVersion: 4`:

```
{"nodes":[{"children":[],"id":"00000000-0000-4000-8000-000000000000","type":"paragraph"}],"schemaVersion":4,"sources":[]}
```

- SHA-256 tih UTF-8 bajtova je `52da86d9b1344b46cf3028d3cf891bbc78a70a860b4c4e481c792a77b66557d5` (izračunato izvan koda, `sha256sum`). Test ga uspoređuje sa zapisanim heksom, a ne s ponovnim izračunom.
- Konstante v1 do v3 ostaju nepromijenjene. Dodaju se `REVISION_ZERO_V4_JCS` i `REVISION_ZERO_V4_SHA256`.
- Domena (`validateVersionedDocument`, `verifyVersionedDocumentSnapshot`) prihvaća v1 do v4, svaki po svojim pravilima. `validateDocument` i dalje prima samo v1.
- Ovaj zadatak ne mijenja bazu. Nijedan rad ne postaje v4, a `app.open_student_work` i dalje upisuje reviziju nula kakvu danas upisuje. Okidač iste verzije (SRV-33) odbija snimku v4 za rad v1 do v3. Rad postaje v4 tek kasnijim korakom baze, istim putem kao v3 (ugovor v3, odjeljak 7), kad editor v4 piše dokument i korake v4.
- Nema pretvorbe postojećeg rada u v4 (D-225).

## 11. Potrošači i redoslijed PR-ova

| Potrošač                         | Mjesto                                              | Ishod u v4                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeDocument`              | `normalize.ts`                                      | spaja susjedni tekst s istim oznakama (s atributima) i u bloku koda; atomi bloka, okvir i atributi ostaju bajt-jednaki                                                                                                  |
| `documentsEqual`, `contentEqual` | `equality.ts`                                       | blokovi, atomi i oznake jednaki samo uz isti tip i ista polja; odsutno nije jednako postojećem; različite verzije nikad nisu jednake                                                                                    |
| `textBlocksOf`                   | `text-blocks.ts`                                    | odlomci u okviru kao zasebni blokovi, redom; stavka numeriranog popisa kao `paragraph` (odjeljak 2.2); blok koda kao blok sa svojim tekstom; `inlineFormula` bez znakova; tablica, slika, formula i prijelom bez teksta |
| `documentWordCount`              | `word-count.ts`                                     | broji tekst odlomaka (i u okviru), naslova, natuknica, stavki numeriranog popisa i citata; ne broji blok koda, ćelije, naslove i izvore tablica i slika ni formule; `inlineFormula` razdvaja riječi                     |
| usporedba verzija                | `server/evidence/compare/blocks.ts`                 | stavka numeriranog popisa je blok `paragraph` s tekstom (odjeljak 2.2); ostali blokovi koje ta usporedba ne poznaje (okvir, tablica, slika, blok koda) i dalje daju `unavailable` kao do sada                           |
| `deriveChapters`                 | `chapters.ts`                                       | naslov je samo na gornjoj razini, pa je nepromijenjen                                                                                                                                                                   |
| replay v4                        | `server/external/storage/edit-steps-v4-*.ts` (novo) | odjeljak 9                                                                                                                                                                                                              |
| rekonstrukcija predaje           | `server/evidence/submission-reconstruction.ts`      | v4 rad replayerom v4 od v4 revizije nula; nepoznata verzija `unavailable` kao danas                                                                                                                                     |

Izbor ugovora za brojanje riječi: akademski opseg rada broji tijelo teksta, bez tablica, ispisa koda i formula. Pravilo fakulteta koje kaže drukčije dolazi iz profila pravila (PRODUCT §5, pravilo 12) i mijenja prikaz, ne dokument.

Redoslijed PR-ova (svaki ostavlja granu zelenom i ne mijenja nijedan postojeći test v1 do v3):

1. **Ugovor** (ovaj dokument).
2. **Shema i validator, dio 1** (zaseban ulaz `validateDocumentV4`; `validateVersionedDocument` i dalje odbija `schemaVersion: 4`, a v4 ulazi u `DOCUMENT_BLOCK_TYPES_BY_VERSION` i `VersionedDocument` tek u PR-u 4, zajedno s potrošačima, da nijedan put ne primi v4 dokument koji potrošač ne zna): `schema.ts` (tipovi i konstante v4), validator oznaka v4, `variantGroup`, `inlineFormula`, `formula`, `codeBlock`, `box`, `pageBreak`; `revision-zero.ts` (v4 konstante); novi kodovi dodani na kraj popisa.
3. **Shema i validator, dio 2:** `table`, `image`, `cover`; zlatni vektori v4 (`golden-vectors-v4.json`) s kanonskim JCS-om i SHA-256.
4. **Potrošači** iz tablice gore, s testom svakog na dokumentu v4 sa svim blokovima, atomima i oznakama.
5. **Format koraka** `ductus-edit-steps-v4` u `edit-step.ts`.
6. **Replay:** `server/external/storage/edit-steps-v4-*` i poslužiteljska shema editora v4, izbor po verziji u rekonstrukciji.

Korak baze iz odjeljka 10 i tablica privitaka nisu dio SRV-10A.

## 12. Klase ulaza i obavezni testovi

Klase 1 do 45 iz ugovora v2 i v3 vrijede i za v4, uz zamjenu verzije. Novo:

| Klasa | Ulaz                                                                                                                                                                                  | Ishod                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 46    | v4 bez `sources`; s nepoznatim ključem; `cover: {}`; `schemaVersion` `"4"`, `4.5`, `5`                                                                                                | `SOURCES_NOT_ARRAY`, `UNKNOWN_FIELD`, `COVER_INVALID`, `SCHEMA_VERSION_INVALID`                  |
| 47    | svaki novi blok, `inlineFormula`, objekt oznake i nova oznaka u v1, v2 i v3                                                                                                           | `NODE_TYPE_INVALID`, `INLINE_TYPE_INVALID`, `MARK_INVALID`                                       |
| 48    | oznake: svih devet zajedno osim `sub`; `sup` i `sub`; dvaput `lang` s različitim jezikom; krivi redoslijed; `{"type":"bold"}`; `"lang"`; nepoznat ključ u objektu                     | prihvat; `MARKS_EXCLUSIVE`; `MARKS_DUPLICATE`; `MARKS_UNSORTED`; `MARK_INVALID`; `UNKNOWN_FIELD` |
| 49    | atributi: `color` velikim slovima, s prozirnošću, bez `#`; `lang` `EN`, `e`, `engl`, `hr-HR`; `href` `javascript:`, `https://`, razmak, 2049 znakova; `pasteId` nil, v1, velika slova | `MARK_ATTRIBUTE_INVALID`                                                                         |
| 50    | susjedni tekst s `lang` `en` i `de`; s dva puta `en`; s `link` različitih adresa                                                                                                      | prihvat; `ADJACENT_TEXT_SAME_MARKS`; prihvat                                                     |
| 51    | `variantGroup`: valjan, nil, velika slova, na naslovu, skupina s jednim odlomkom                                                                                                      | prihvat; `VARIANT_GROUP_INVALID`; `UNKNOWN_FIELD`; prihvat                                       |
| 52    | formula i `inlineFormula`: bez `tex`, `""`, 4000/4001 i 1000/1001 kodnih točaka, prijelom retka, razmak na rubu; `inlineFormula` u naslovu                                            | prihvat do granice; inače `FORMULA_TEX_INVALID`; `INLINE_FORMULA_NOT_ALLOWED`                    |
| 53    | blok koda: tekst s prijelomima retka, prazan, s `paste` ili `imported`, s oznakom oblikovanja, s navodom, nepoznat jezik, `caption` 301                                               | prihvat; prihvat; `CODE_CONTENT_INVALID`; `CODE_LANGUAGE_INVALID`; `CODE_CAPTION_INVALID`        |
| 54    | okvir: svih sedam vrsta, prazan, s naslovom, s okvirom, s tablicom, ponovljen ID unutar i izvan okvira, dva uzastopna okvira iste vrste                                               | prihvat; `BOX_CHILDREN_INVALID`; `NODE_ID_DUPLICATE`; prihvat                                    |
| 55    | `pageBreak` s bilo kojim dodatnim poljem                                                                                                                                              | `UNKNOWN_FIELD`                                                                                  |
| 56    | tablica: 1×1, 3000 i 3001 ćelija, nejednaki retci, prazan redak, ćelija s prijelomom retka, broj u ćeliji, zastavica kao `0` ili odsutna                                              | prihvat; `TABLE_ROWS_INVALID`; `TABLE_CELL_INVALID`; `BLOCK_FLAG_INVALID`                        |
| 57    | spajanje: preklapanje, izvan tablice, `1×1`, nepoređano, tekst u pokrivenoj ćeliji; boje: pokrivena ćelija, ponovljena, `headerFill` uz `header: false`                               | `TABLE_MERGE_INVALID`; `TABLE_FILL_INVALID`                                                      |
| 58    | slika: bez privitka, samo `attachmentId`, hash velikim slovima, `crop` bez privitka, `crop` sa svim nulama, 46 %, `widthPercent` 19, 101 i `60.5`, `align` `centre`                   | prihvat; `IMAGE_ATTACHMENT_INVALID`; `IMAGE_CROP_INVALID`; `IMAGE_LAYOUT_INVALID`                |
| 59    | naslovnica: svako polje na granici i preko nje, razmak na rubu, nepoznat ključ                                                                                                        | prihvat; `COVER_FIELD_INVALID`; `UNKNOWN_FIELD`                                                  |
| 60    | v4 revizija nula; zlatni vektori v4                                                                                                                                                   | JCS i SHA-256 jednaki zapisanima                                                                 |
| 61    | korak v4: zamjena tablice s izmijenjenom ćelijom i `nodeId` starog bloka; s drugim `nodeId`; s drugom vrstom; bez hasha                                                               | prihvat; `not_canonical`; `missing_field`                                                        |
| 62    | korak v4: `addMark` i `removeMark` s `paste` ili `imported`; uklanjanje zalijepljenog teksta s hashom                                                                                 | `invalid_mark`; prihvat                                                                          |
| 63    | korak v4: omatanje u okvir, skidanje okvira, promjena vrste okvira i jezika koda kao `replaceAround`; `coverSet` sa i bez starog hasha                                                | prihvat; `missing_field` ili `invalid_removed_hash`                                              |
| 64    | format v4 nad v3 radom i obrnuto                                                                                                                                                      | odbijeno, ništa upisano                                                                          |
| 65    | potrošači iz odjeljka 11 na v4 dokumentu sa svim blokovima, atomima i oznakama                                                                                                        | ishod iz tablice, bez iznimke                                                                    |

Uz to fast-check svojstva (a) do (g) iz ugovora v2 vrijede za validator i parser v4, uz generator koji umeće i briše blokove, atome i oznake v4. Generatori i vektori koriste samo sintetičke podatke: izmišljene gradove i tekstove, „Izvor 1”, adrese `https://primjer.invalid/…`, hash od nula i UUID-e oblika `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`. Nema stvarnih radova, osoba, slika ni podataka.

## Za klijenta (UI-10A, WEB-10*)

- Editor v4 imenuje čvorove i oznake kao `type` u ovom ugovoru, s atributima iz odjeljka 9, i pretvara prototipne oblike u kanonske:
  - `prikaz` s `kind: 'tablica'` → `table`: `head` → `header`, `zebra` → `stripes`, `land` → `landscape`, `fill` → `headerFill` (ključ u boju, odjeljak 5.1), `cf {'r,c': boja}` → `cellFills`, `sp {'r,c': [redaka, stupaca]}` → `merges`; zastavice uvijek zapisane;
  - `prikaz` s `kind: 'slika'` → `image`: `img` se prvo šalje kao privitak, a u dokument idu `attachmentId` i `attachmentSha256`; `opt.w` → `widthPercent` (cijeli broj), `al` `l|c|r` → `left|center|right`; izrez → `crop` bez nove slike; `nw`, `nh` se ne šalju;
  - `formula` i `fxi` → `formula` i `inlineFormula`; `codeBlock` s `language` i `cap` → `codeBlock` s `language` i `caption`; `tbox` → `box` (vrste iz odjeljka 4.3); `pagebreak` → `pageBreak`;
  - `hl` → `highlight` (ključ u boju, odjeljak 3.2); `lang` s `xx` → `und`; `link` s adresom kakvu editor već dopunjuje (`https://`); `paste` → `pasteId` (novi UUID v4 po lijepljenju) i `sourceId`, bez `orig` i `ok`; `imported`;
  - `vg` → `variantGroup` (UUID v4 umjesto prototipnog `uid('v')`); `xref` s `kind` i `target` → `crossReference` s `targetId` bloka (bez `pid` i `rid`);
  - `S.cover` → `cover` samo sa `study`, `place` i `date`.
- Klijent prije spremanja: obrezuje tekst polja koja traže uredan tekst, prijelom retka u formuli i ćeliji pretvara u razmak, izostavlja neobavezno polje koje bi bilo prazno, a formulu s praznim zapisom ne umeće.
- Dok rad nije v4 (odjeljak 10), klijent šalje dokument i korake verzije revizije nula rada, a v4 čvorove i oznake ne šalje.
- Brojevi, tekst poveznica, naslovnica, oblik stranice i napomena „tekst je kasnije mijenjan” računaju se pri prikazu (odjeljak 8).

## Poznate granice

- Granice duljina i veličina (ćelija 1000, 3000 ćelija, naslov i izvor 500, formula 4000 i 1000, naslov ispisa 300, naslovnica 200/100/50) i obrezivanje do 45 % su izbor ugovora i prototipa. Nisu izmjerene na stvarnim radovima.
- Ćelija tablice je običan tekst: nema oznaka, navoda ni fusnota u tablici. To traži novu verziju sheme.
- Okvir sadrži samo odlomke, kao u prototipu; popis ili formula u okviru traže novu verziju sheme.
- Numerirani popis nema početni broj ni razinu: uvijek počinje od 1 i nije ugniježđen (odjeljak 2.2).
- `lang` provjerava samo oblik oznake jezika, ne postoji li jezik.
- Oznaka `aitext` nije u v4 (val 12).

## Otvorena pitanja

- **P1 (`rq`).** Nepromijenjeno iz ugovora v3.
- **P2 (marker).** Prototip kaže „Marker je Vaše označavanje. Mentor ga ne vidi i ne ide u izvoz.” Plan stavlja `hl` u shemu v4, pa je marker u hashiranom dokumentu i u prikazu uživo i reprodukciji (PRODUCT §5, pravila 5 i 7). Smije li nastavnički prikaz i izvoz izostaviti marker, ili marker treba živjeti izvan dokumenta, odlučuje vlasnik prije PR-a koji marker crta nastavniku. Do tada validator marker prihvaća, a nijedan nastavnički put ga ne izostavlja tiho.
- **P3 (`ok` uz lijepljenje).** Prototipno obrazloženje potvrde lijepljenja nije u dokumentu (odjeljak 3.1). Gdje živi i tko ga vidi, odlučuje orkestrator ili vlasnik prije PR-a koji ga gradi.
- **P4 (numerirani popis).** ZATVORENO: Daniel „Popis da” (Ductus#2058, c.7171436489); blok `orderedItem`, odjeljak 2.2.

## Što bi ovaj ugovor moglo oboriti na reviewu?

- Okvir kao jedino gniježđenje (odjeljak 4.3) i utjecaj na potrošače koji danas pretpostavljaju plosnate blokove.
- Slika kao privitak s hashem u dokumentu (odjeljak 5.2): ovisi o tablici privitaka koja još ne postoji.
- Zabrana `addMark` i `removeMark` za `paste` i `imported` (odjeljak 9, točka 6) kao provedba B-7.
- Izostavljanje imena studenta i mentora iz naslovnice (odjeljak 7) i marker u dokumentu (P2).
