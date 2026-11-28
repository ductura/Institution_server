# Uvoz PDF-a

Čitač provjerava PDF objekte, uključujući objekte iz komprimiranih tokova, pa pomoću PDF.js čita tekstni sloj. Svaki prepoznati redak postaje odlomak u dokumentu v2. Prazan tekstni sloj vraća `pdf_no_text_layer`. Uvoz podržava samo datoteke s tekstnim slojem.

Čitač vraća i tragove u obliku kao DOCX, `{traceKind, count}` (ADR [import-manifest-v2](../../../docs/adr/import-manifest-v2.md) §2 i §4 t. 4). Broje se samo komentari: anotacije stranice podtipa `Text` i `FreeText` bez ključa `/IRT`. Ista anotacija na više stranica broji se jednom. `Popup`, odgovori i označavanja (`Highlight`, `StrikeOut` i slična) se ne broje, a `deletion` i `insertion` PDF nema. Sadržaj, autor i datum anotacije ne čitaju se i ne ulaze u tekst. Granice: najviše 500 anotacija po stranici, 5000 ukupno i dubina stabla stranica 32. Prijelaz broja anotacija daje `CONTENT_TOO_LARGE`, a preduboko stablo `PDF_INVALID`. Tragovi još ne ulaze u manifest jer v1 uz `pdf` zabranjuje `traces`; to čeka ugovor `ductus-import-manifest-v2` (korak 1).

Manifest `ductus-import-manifest-v1` veže SHA-256 primljenih bajtova i kanonskog dokumenta. Kanonski manifest ima vlastiti SHA-256 za potvrdu uvoza. Naziv datoteke pohranjuje se zasebno.

Postojeća ruta pokreće čitač u zasebnoj niti nakon provjere dopuštenja. Nit ima vremensko ograničenje od 10 sekundi i ograničenje V8 memorije. Poslužitelj dopušta najviše dva istodobna PDF čitanja.
