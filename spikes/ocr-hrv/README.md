# OCR hrv i tekstni sloj PDF-a

SRV-1808, M8.7-S. Lokalni spike koji na izmišljenim hrvatskim uputama i popisu literature mjeri koliko točno Tesseract.js (model `hrv`, brzi i standardni) i tekstni sloj PDF.js čitaju dijakritike (č, ć, đ, š, ž) i datume, koliko traju i koliko paketa donose. M8.7 (PDF izvori u bilježnici) gradi se tek prema ovom ishodu. Sav tekst, sve osobe i adrese su izmišljeni (`corpus.ts`, adrese na `.invalid`); u repou nema binarnih datoteka, PDF-ovi i rasteri grade se u memoriji. [Plan migracije](../../docs/plan/PLAN-MIGRACIJE.md)

## Ishod

**Spike je prošao, uz granicu niže.** Tekstni sloj PDF.js vraća tekst točno (svi dijakritici i datumi, oko 9 ms po stranici), pa OCR treba samo kad PDF nema tekstni sloj (PDF iz skenera: `getTextContent` vraća 0 stavki, to je signal). Na čistom rasteru od 150 do 300 dpi oba modela čitaju sve dijakritike i sve datume; pogreške znakova su ispod 1,1 %. Na 100 dpi s pokvarenim skenom padaju datumi (do 2/5 pronađenih) i jedan dijakritik. **Preporuka za M8.7:** prvo tekstni sloj, OCR samo bez njega, na 200 dpi, s brzim modelom; standardni model ne daje mjerljivo bolji ishod uz 3,4 puta veći model i oko 1,3 puta dulje vrijeme, osim na pokvarenom skenu od 200 dpi (v. niže). Datume iz OCR-a treba tretirati kao nepouzdane dok ih korisnik ne potvrdi.

**Granica zaključka.** Jedan font (DejaVu Serif), dvije stranice, kompjutorski generirani „skenovi” (PDF.js raster uz zakret i šum), jedno mjerenje po retku. Nema stvarnih skenova, rukopisa, tablica, dvostupčanog sloga ni drugih fontova, pa rezultat pokazuje donju granicu težine, ne očekivanu točnost na pravim izvorima. Prije oslanjanja treba ponoviti na stvarnim (izmišljenim ili licenciranim) skenovima.

## Postav

| Dio                   | Vrijednost                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCR                   | `tesseract.js` 6.0.1, jezgra `tesseract.js-core` 6.1.2 (WASM), jedan worker, `hrv`                                                                            |
| Tekstni sloj i raster | `pdfjs-dist` 5.4.624 (legacy build), crtanje preko `@napi-rs/canvas` 0.1.100                                                                                  |
| Izmišljeni PDF        | `pdfkit` 0.17.2, font DejaVu Serif (`dejavu-fonts-ttf` 2.37.3)                                                                                                |
| Modeli                | `hrv.traineddata` iz `tessdata_fast` (4,1 MB) i `tessdata` (standardni, 13,8 MB), pinani SHA-256 u `models.ts`; dohvaća ih jednom `pnpm models`, nisu u repou |
| Lockfile              | `pnpm-lock.yaml` u ovom direktoriju; prazan `pnpm-workspace.yaml` drži spike izvan korijenskog workspacea                                                     |

**Bez CDN-a u radu.** `ocr.ts` daje putanju jezgre i jezika s diska (`corePath`, `langPath`, `cacheMethod: "none"`), a PDF.js ne treba radnika izvana. Cijeli `benchmark.ts` i testovi prolaze u mrežnom prostoru bez mreže (`unshare -n -r node benchmark.ts`). Jedini mrežni korak je `pnpm models`, i on provjerava digest.

## Mjerenja

Linux 6.18 x64, 4 jezgre, Node v24, 21. 11. 2026. CER je udio pogrešnih znakova (Levenshtein, razmaci i prijelomi redaka izjednačeni). Dijakritici: udio referentnih č ć đ š ž (i velikih) pročitanih točno u poravnanju (u zagradi koliko ih je). Datumi: koliko od referentnih datuma (`15. 12. 2026.`, `12. siječnja 2027.`) se pojavi doslovno. Vrijeme je jedno mjerenje po stranici (ne računa pokretanje workera). Cijeli niz je u `results.json`.

„Upute” (24 dijakritika, 5 datuma) i „literatura” (42 dijakritika, 2 datuma):

| Izvor                           | CER upute | CER lit. |              Dijakritici | Datumi | ms po stranici |
| ------------------------------- | --------: | -------: | -----------------------: | -----: | -------------: |
| tekstni sloj PDF.js             |    0,00 % |   0,13 % |                    100 % |    7/7 |              9 |
| fast, 100 dpi                   |    0,12 % |   0,88 % |                    100 % |    7/7 |        567–839 |
| fast, 150 dpi                   |    0,12 % |   0,75 % |                    100 % |    7/7 |        775–903 |
| fast, 200 dpi                   |    0,12 % |   0,75 % |                    100 % |    7/7 |       937–1018 |
| fast, 300 dpi                   |    0,23 % |   0,75 % |                    100 % |    7/7 |      1541–1555 |
| fast, 200 dpi, skos 2°, šum     |    0,70 % |   1,13 % |                    100 % |    7/7 |      1141–1232 |
| fast, 100 dpi, skos 2°, šum     |    1,28 % |   2,13 % | 95,8 % (24) / 100 % (42) |    3/7 |        523–672 |
| standard, 100 dpi               |    0,23 % |   1,00 % | 95,8 % (24) / 100 % (42) |    7/7 |        633–895 |
| standard, 150 dpi               |    0,23 % |   0,75 % |                    100 % |    7/7 |      1100–1549 |
| standard, 200 dpi               |    0,23 % |   0,88 % |                    100 % |    7/7 |      1196–1331 |
| standard, 300 dpi               |    0,23 % |   1,00 % |                    100 % |    7/7 |      1742–2211 |
| standard, 200 dpi, skos 2°, šum |    0,12 % |   0,75 % |                    100 % |    7/7 |      1249–1394 |
| standard, 100 dpi, skos 2°, šum |    0,93 % |   1,75 % | 95,8 % (24) / 100 % (42) |    5/7 |        774–828 |

„skos 2°, šum” je deterministično pokvaren sken: zakret 2°, sivi papir, šum ±60 po kanalu (amplituda 120, seeded LCG).

| Veličina paketa (što se isporučuje)          |      Bajtova |
| -------------------------------------------- | -----------: |
| `tesseract.js` (izvor + worker)              |      171.884 |
| WASM jezgra SIMD LSTM (`.wasm.js`)           |    3.954.569 |
| PDF.js legacy (`pdf.mjs` + `pdf.worker.mjs`) |    3.116.046 |
| model `hrv` fast                             |    4.103.348 |
| model `hrv` standard                         |   13.797.409 |
| **Zbroj s fast modelom**                     | **~11,3 MB** |
| **Zbroj sa standard modelom**                | **~21,0 MB** |

Pokretanje workera s modelom: oko 0,2 do 0,3 s (fast i standard slični).

## Nalazi

- **Tekstni sloj je prvi izbor.** Točan je i otprilike 100 puta brži od OCR-a. Jedino odstupanje: prijelom retka iza crtice (`112– 130`) daje razmak; za bibliografije treba normalizirati razmak oko crtice prije usporedbe. Tekst treba normalizirati u NFC (`metrics.ts`) jer PDF-ovi znaju imati rastavljene dijakritike.
- **PDF bez tekstnog sloja** (skener) prepoznaje se po 0 stavki u `getTextContent`; test `image-only PDF has no text layer` to pokriva. Djelomičan tekstni sloj (samo neke stranice) nije ispitan.
- **Razlučivost važi više od modela.** Od 150 dpi nadalje nema dobitka (300 dpi je sporiji i ne točniji); na 100 dpi datumi prvi stradaju (razmaci u `15. 12. 2026.`), pa su na pokvarenom skenu od 100 dpi pronađeni samo 3/7 (fast) odnosno 5/7 (standard).
- **Standardni model nije bitno bolji** na čistom rasteru; bolji je na pokvarenom skenu od 200 dpi (CER 0,12 % prema 0,70 % u uputama). Taj jedan podatak ne dovodi do odluke; preporuka je fast model s 200 dpi, a standard samo ako stvarni skenovi pokažu istu razliku.
- **Pouzdanost** koju vraća Tesseract (90 do 95) ne razlikuje 100 % točne datume od pogrešnih; ne koristiti je kao prag za datume.
- **Pogreške znakova** su na „@” u adresi (`mentor@primjer.invalid` se čita bez znaka ili s pogrešnim znakom) i na razmacima u datumima; dijakritici su stabilni.

## Pretpostavke

- Standardni model je `tessdata` (legacy + LSTM, 13,8 MB), brzi je `tessdata_fast`; `tessdata_best` (11,2 MB) nije mjeren.
- Pokvareni sken je sintetski, na istom canvasu kao render, jer pretvaranje gotove PNG slike natrag u canvas u `@napi-rs/canvas` uzrokovalo je udvostručeni tekst u OCR-u (artefakt alata, ne modela); zato `degrade` živi u `pdf-read.ts`.
- Paketi nisu minificirani ni sažeti (gzip); stvarna veličina za preglednik bila bi manja.
- Mjerilo je jedan prolaz po retku; razlike manje od oko 0,2 % CER-a i 100 ms nisu značajne.

## Provjere

```sh
pnpm install
pnpm models        # jednom, s mrežom; provjerava digeste
pnpm test          # node --test; ne treba mrežu
pnpm report        # benchmark, piše results.json i tablicu na stdout
unshare -n -r node benchmark.ts   # isto bez mreže (dokaz: nema CDN-a)
```

Nije pokrenuto: CI posao za ovaj spike (nema `.github/workflows` retka; zajednička datoteka izvan putanja), ostatak korijenskih provjera nije dirnut jer spike ne dira `server/`.
