# Uvoz PDF-a

Čitač provjerava PDF objekte, uključujući objekte iz komprimiranih tokova, pa pomoću PDF.js čita tekstni sloj. Svaki prepoznati redak postaje odlomak u dokumentu v2. Prazan tekstni sloj vraća `pdf_no_text_layer`. Uvoz podržava samo datoteke s tekstnim slojem.

Manifest `ductus-import-manifest-v1` veže SHA-256 primljenih bajtova i kanonskog dokumenta. Kanonski manifest ima vlastiti SHA-256 za potvrdu uvoza. Naziv datoteke pohranjuje se zasebno.

Postojeća ruta pokreće čitač u zasebnoj niti nakon provjere dopuštenja. Nit ima vremensko ograničenje od 10 sekundi i ograničenje V8 memorije. Poslužitelj dopušta najviše dva istodobna PDF čitanja.
