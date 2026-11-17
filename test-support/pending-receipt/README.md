# test-support/pending-receipt

Zajednički fixturei testova potpisa pending potvrde (DAN-820, 820c), preneseni iz Ductus `src/application/evidence/sign-pending-receipt.test.ts` na `333e163`, da se isti podaci ne kopiraju u testove svakog dijela:

- `fixtures.ts`: izmišljeni payload potvrde v2 (`PAYLOAD`), njegov JCS tekst (`TEXT`), redak spremišta (`ROW`) i ključ potvrde (`testKey`, 820c-3);
- `signing.ts` (820c-4b): potpisnik koji vraća `Result` kao port `ReceiptSigner` (`testSigner`) i spremište u memoriji koje oponaša `app.worker_attach_receipt_signature` (`memoryStore`);
- `index.ts`: jedini ulaz za druge mape.

Sve vrijednosti su izmišljene. Samo za testove; produkcijski kod ovo ne uvozi.
