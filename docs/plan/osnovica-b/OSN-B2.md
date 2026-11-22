# OSN-B2 osnovica-testovi-provenijencija

Zadatak: prenijeti Ductusove testove provenijencije i uvoza (zapisnik osnovice
faze 1, ductura/.github#56, kategorija B). Putanje `server/domain/provenance/`
ne postoje; ekvivalenti su `server/import/docx/` (čitač ZIP-a i XML-a) i
`server/contracts/import/` (manifest v1). Spike `spikes/docx-provenance` nije
proizvodni kod i ne dira se.

| Ductusov test                                         | Ishod                                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docx-reader.test.ts` razredi Z2-Z13 (ZIP)            | preneseno: `server/import/docx/zip-xml-rows.test.ts` (kodovi složeni u zatvoreni skup `ImportReadRejectCode`)                                                                                 |
| `docx-reader.test.ts` razredi X1-X8 (XML)             | preneseno: `zip-xml-rows.test.ts`; vizitorski i „samo imena” testovi zamijenjeni ekvivalentima nad stablom `readXml`                                                                          |
| `docx-reader.test.ts` Z1 (tip ulaza, `maxInputBytes`) | nije preneseno: ulaz se ograničuje u `readDocx` (FILE_TOO_LARGE), pokriven u `read-docx.test.ts`                                                                                              |
| `docx-reader.test.ts` L1 (`resolveDocxLimits`)        | nije preneseno: ekvivalent `resolveImportReadLimits` ima vlastite testove u `server/contracts/import/limits.test.ts`                                                                          |
| `docx-reader.test.ts` „no network” (provjera izvora)  | nije preneseno: arhitekturni lint repoa već zabranjuje uvoze izvan granica                                                                                                                    |
| `docx-reader.test.ts` Z13 korpus                      | nije preneseno: korpus se u ovom repou koristi u `zip-xml.property.test.ts`                                                                                                                   |
| `docx-reader.property.test.ts`                        | preneseno: `server/import/docx/zip-xml.property.test.ts`                                                                                                                                      |
| `zip-hardening.test.ts` H1-H9                         | preneseno: `server/import/docx/zip-hardening.test.ts`; test „runtime bez provjere kraja deflate toka” nije preneseno: čitač ne koristi DecompressionStream, kraj toka provjerava sam (H5, H6) |
| `manifest-v1.test.ts`                                 | nije preneseno: `server/contracts/import/manifest.test.ts` već ima iste retke (M1-M16), isti golden vektori (bajt-identični)                                                                  |
| `manifest-v1.property.test.ts`                        | nije preneseno: već postoji `manifest.property.test.ts` s istim svojstvima                                                                                                                    |

## Stvarne greške nađene prenesenim testovima (popravljene)

`server/import/docx/zip.ts`: više/skriveni zapisi kraja, ZIP64 lokator, komentar
unosa, extra polja (Unicode Path/Comment, ZIP64), nepoklapanje zastavica i
verzije lokalnog i središnjeg zaglavlja, bajtovi skriveni između unosa,
deskriptor podataka, bajtovi nakon kraja deflate toka, ime bez UTF-8 zastavice
i s BOM-om, NFC duplikati, kopija pohranjenog dijela (Buffer je dijelio memoriju).
`server/import/docx/xml.ts`: znak izvan XML Char, `--` u komentaru, normalizacija
vrijednosti atributa, kvadratno kopiranje dugog imenskog prostora.
