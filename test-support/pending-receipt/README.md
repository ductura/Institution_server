# test-support/pending-receipt

Zajednički fixturei testova potpisa pending potvrde (DAN-820, 820c): izmišljeni payload potvrde v2 (`PAYLOAD`), njegov JCS tekst (`TEXT`) i redak spremišta (`ROW`). Preneseno iz Ductus `src/application/evidence/sign-pending-receipt.test.ts` na `333e163`, da se isti podaci ne kopiraju u testove svakog dijela (`server/evidence/pending-receipt-text.test.ts`, dalje 820c-2 … 820c-4). Sve vrijednosti su izmišljene. Samo za testove; produkcijski kod ovo ne uvozi.
