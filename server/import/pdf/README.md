# server/import/pdf

Čitač PDF-a za uvoz (SRV-1804, M8.3), po ugovoru [import-contract](../../../docs/adr/import-contract.md) §4 i planu napada (klasa D, granica L2).

- `scan.ts`: strukturni pregled prije čitanja teksta (`pdf-lib`, i objekti unutar object streamova). Šifriran PDF (i samo `/Encrypt` u traileru) daje `PDF_ENCRYPTED`. Svaki objekt pregledava se jednom, u ravnoj petlji bez rekurzije. Skripta, `Launch`, ugrađena datoteka, XFA, multimedija i svaki okidač `/AA` daju `PDF_ACTIVE_CONTENT`. Dopuštene su samo akcije `GoTo`, `URI` i `Named`, a odredište pod `/OpenAction` nije akcija. Imena se uspoređuju nakon dekodiranja `#xx`.
- `read-pdf.ts`: cijelo čitanje stalnim redom: veličina, format (`%PDF-`), pregled, broj stranica (`PDF_TOO_MANY_PAGES`), tekstni sloj kroz PDF.js (bez skripti, fontova i XFA-a), granica sadržaja odsječka (`CONTENT_TOO_LARGE`). Retci blizu jedan drugome čine odlomak; razmak veći od 1,5 veličine slova i nova stranica počinju novi. PDF bez teksta (sken) daje `PDF_NO_TEXT_LAYER`. Svaka greška PDF.js-a je `PDF_INVALID`, a njezina poruka ne izlazi iz čitača.
- `prepare.ts`: manifest s tri hasha (provjeren čitačem ugovora), `fileFormat: "pdf"` i bez ključa `traces`.

PDF.js se uvozi statički (`pdfjs-dist`); svoj worker učitava sam, a rad workera u paketu poslužitelja provjerava SRV-1804B. Granica vremena workera (D4) dolazi s rutom (SRV-1804B).

Testovi grade izmišljene PDF-ove u memoriji (`pdf-lib` ili ručno pisane objekte); u repou nema binarnih datoteka.
