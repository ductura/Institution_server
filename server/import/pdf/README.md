# server/import/pdf

Čitač PDF-a za uvoz (SRV-1804, M8.3), po ugovoru [import-contract](../../../docs/adr/import-contract.md) §4 i §8 (klasa D). Isti put i ista dozvola kao DOCX (rute `work.imports.post` i `work.imports.confirm.post`).

- `active-content.ts`: prvi prolaz po sirovim bajtovima (imena s `#xx` dekodiranim): `/Encrypt` daje `PDF_ENCRYPTED`; `/JavaScript`, `/JS`, `/Launch`, ugrađene datoteke, XFA, RichMedia i `OpenAction` s akcijom daju `PDF_ACTIVE_CONTENT`.
- `read-pdf.ts`: PDF.js bez izvršavanja (`isEvalSupported` isključen, bez XFA, bez dohvata) čita samo tekstni sloj; PDF.js još jednom traži JavaScript, privitke i akcije u komprimiranim objektima. Više od `maxPdfPages` stranica je `PDF_TOO_MANY_PAGES`, neispravna struktura ili istek vremena `PDF_INVALID`, a skenirani PDF bez ikakvog teksta `PDF_NO_TEXT_LAYER` (HTTP 422 `pdf_no_text_layer`). Autor, datum i ostali metapodaci se ne čitaju.
- `prepare.ts`: manifest s tri hasha, bez ključa `traces` (M9), i normalizirani naziv datoteke izvan svakog hasha (D-292).

Testovi grade izmišljene PDF-ove u memoriji (`fixtures.test-support.ts`); u repou nema binarnih datoteka.

## Nit i vremenska granica (SRV-1804B, import-contract D4)

- `worker.ts`: `readPdfInWorker` čita datoteku u radnoj niti (`resourceLimits`: memorija i stog) s granicom od `PDF_READ_TIMEOUT_MS`. Istek, pad niti ili prekoračenje memorije daju `PDF_INVALID`, a nit se uvijek završi s `terminate()`. Iz datoteke se izvozi samo ta funkcija (lint `scripts/lint-rules/dynamic-load.ts`, točna putanja); `import.meta.url` stoji samo u dva `new URL`: TS izvor `worker-thread.ts` i izgrađeni `pdf-import-worker.js`.
- `worker-thread.ts`: ulaz niti; čita bajtove i granice iz `workerData`, zove `readPdf` i šalje jedan rezultat. Ne izvozi ništa.
- Izgradnja (`scripts/build/server.ts`) daje `dist/server.js` i `dist/pdf-import-worker.js`; slika ima po jedan točan `COPY` za svaku (`infra/web/Dockerfile`). PDF.js u nitu dobiva svoj `WorkerMessageHandler` izravno (`globalThis.pdfjsWorker` u `read-pdf.ts`), jer paket nema `pdf.worker.mjs` pored sebe.
