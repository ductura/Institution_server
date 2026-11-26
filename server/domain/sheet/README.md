# server/domain/sheet

Tablični dokument vrste `spreadsheet` (val 14, SRV-V14-SHEET-MODEL). Samo čiste funkcije bez I/O-a; uvozi `../json`, `../forensics` i `../document/forbidden.ts`.

- **Model** (`model/schema.ts`): `SheetDocument` v1 `{schemaVersion: 1, kind: "spreadsheet", sheets}`, do 5 listova, list do 200 redaka i 26 stupaca. Ćelija je tekst, broj ili formula; prazna ćelija je odsutna iz `cells`. Ćelija s formulom ima `value: null`: rezultat se ne pohranjuje kao istina, server ga ponovno računa. Pomoćnici za A1 reference (`parseCellRef`, `formatCellRef`, `columnLabel`).
- **Provjera** (`validate.ts`): `validateSheetDocument` ništa ne popravlja, odbija nepoznata polja i vraća kopiju samo poznatih polja. Do 3000 ispunjenih ćelija u cijelom dokumentu, tekst ćelije do 1000 točaka koda (dopušteni su novi redak i tabulator), formula do 500 točaka koda i počinje s `=` (sintaksu provjerava računalo formula, ne ovdje), naziv lista do 31 točke koda bez `: \ / ? * [ ]`, naziv jedinstven bez obzira na veličinu slova.
- **Sažetak i jednakost** (`validate.ts`): `sheetJcsBytes` i `sheetDigest` (JCS, SHA-256 heksadecimalno), `sheetDocumentsEqual`, `filledCellCount`.
- **Vektori** (`golden-vectors.json`): izvedeni izvan koda (Python), isti bajt-za-bajt kopira WEB-V14-SHEET-CORE. Test je `sheet.test.ts`.

Nema rute, tablice ni ugovora. Ništa ovdje ne ocjenjuje, ne rangira i ne sankcionira.

## Koraci (SRV-V14-SHEET-EVIDENCE)

`model/steps.ts` (format `ductus-sheet-steps-v1`, `parseSheetSteps`), `step-hash.ts` (`sheetTextSha256`, `sheetCellSha256`, `sheetCellsSha256`) i `edit-step.ts` (primjena koraka i revizija 0). Koraci: `cellSet` (tekst, broj ili formula), `cellClear`, `rowInsert`, `rowRemove`, `columnInsert`, `columnRemove`, `sheetRename`; ne pritisnute tipke. Zatvoren skup ključeva, nepoznat korak se odbija. Zamjena i uklanjanje nose SHA-256 onoga što zamjenjuju (`replacedSha256`, `removedSha256`). Rezultat svakog koraka provjerava `validateSheetDocument`. Umetanje i brisanje retka ili stupca pomiče samo ćelije; tekst formula se ne prepisuje (editor to zapisuje vlastitim `cellSet` korakom). Revizija 0: jedan prazan list „List1”, 100 redaka, 10 stupaca. Vektori: `edit-step-vectors.json` (izvedeni izvan koda). Grananje po vrsti pri commitu i replayu je u `server/evidence/sheet/`.

## Mapa `model/` (SRV-V14-PARSERI-BEZ-NODE)

`model/` drži tip dokumenta i čitač koraka bez ijednog Node modula (bez `node:crypto` i `Buffer`), jer ih provjera segmenta evidencije (`server/domain/forensics/evidence-segment-v2.ts`) uvozi kroz `model/index.ts` i ista provjera radi u pregledniku i na poslužitelju (granica 8, #638). Sve što računa SHA-256 (`step-hash.ts`, `sheetDigest` u `validate.ts`) ostaje izvan `model/`. `index.ts` izvozi isto kao prije.
