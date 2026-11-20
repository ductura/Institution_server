# WEB-9E `povijest-predajni-paket` (val 9, traka W-B)

Risk: medium. Sučelje potvrde i povijesti; javna provjera ne smije postati način prijave (D-09).

## 1. Izvor

- PLAN-MIGRACIJE.md, „Val 9” (PD-1 svih 11 dijelova, E-11 s PDF-om i QR-om, „Predajni paket (naziv i tekst koda prema ✓ B-3)”, ✓ C-6 `/provjera`).
- Prototip: `INVENTAR-student.md` E-11, PD-1, PO-18, PO-20, PO-21; `INVENTAR-editor.md` §3.3 „Predajni paket” (`paket`) i „Povijest rada” (`history`).
- Putanje: `src/components/editor/history/`, `src/components/editor/submission-package/`, `src/components/student/receipt/` (postojeća potvrda je u `src/components/predaja/ReceiptPanel`).

## 2. Ugovor rute

- Postoje: `student.submission.get` (`ceka` | `potvrdeno` s potpisanom potvrdom), `student.receipt-pdf.get` `GET /api/v1/student/assignments/{assignmentId}/submission/pdf`, `teacher.receipt-pdf.get`, `work.versions.get` (točke za Povijest rada), `projection.process-summary.post`; greške 401, 403, 404, 503.
- Ne postoji: `public.verification.post` (`/provjera`, bez prijave, uska SECURITY DEFINER funkcija, C-6) i izvor koda iz Predajnog paketa. PRIJEDLOG novih ruta uvodi prvo serverski PR; QR na PDF-u gradi poslužitelj.

## 3. Kriteriji prihvata

- [ ] Potvrda E-11 prikazuje stanja puno, ceka, nakon roka, praznine, prazno, učitavanje i grešku; „Potvrda je izdana” tek uz potpisanu potvrdu.
- [ ] Otisak u skupinama po četiri znaka; „Kopiraj otisak” kopira 64 znaka bez razmaka.
- [ ] „Preuzmi zapis (PDF s QR kodom)” poziva `student.receipt-pdf.get`; 404 daje poruku, ne praznu stranicu.
- [ ] Povijest rada prikazuje točke iz popisa verzija, bez teksta i veličine promjene (§5 pravilo 7); vraćanje stare točke nije dio ovog zadatka.
- [ ] Predajni paket: redci ✓/! bez blokiranja žutih stavki; tekst koda ne tvrdi nastanak rada, samo da se predani tekst nije mijenjao od predaje.
- [ ] Skener zabranjenih izraza zelen, tekstovi u `messages.hr`, testovi s lažnim poslužiteljem.

## 4. Ovisnosti

- Spojeno: SRV-9A (#458), PDF potvrde (SRV-9C, #455). Čeka serverski PR za `/provjera`; do tada dio „Provjera potvrde” ostaje iza oznake „još nije dostupno”, bez izmišljene rute.

## 5. Otvorena odluka: ODLUKA ORKESTRATORA

Konačni naziv i izvor koda: B-3 prihvaća prijedlog „Kod potvrđuje da se predani tekst nije mijenjao od predaje.” i naziv bez „autorska”, ali točan naziv nije zapisan, a nije jasno dolazi li kod (`DUC-XXXX-XXXX-XXXX`) s poslužitelja ili se izvodi iz otiska predaje.
