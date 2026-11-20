# WEB-10C `editor-core-v4` (val 10, traka W-C)

Risk: critical. Mijenja kanonski JCS i replay; svaki čvor ide prvo kroz ugovor, a klijent ne šalje v4 dok rad nije v4.

## 1. Izvor
- PLAN-MIGRACIJE.md, „Val 10” i „Shema dokumenta: nesklad i gdje se rješava”; ✓ C-1 (po valovima), ✓ B-7 (oznaka lijepljenja ostaje, uz napomenu da je tekst kasnije mijenjan).
- Ugovor: `docs/contracts/document-schema-v4.md` (SRV-10A, spojen u #443), „Za klijenta (UI-10A, WEB-10*)”: prikaz tablice i slike, formula, blok koda, okvir, prijelom, `highlight`, `lang`, `link`, `paste`, `imported`, `variantGroup`, `crossReference`, `cover`.
- Prototip: `INVENTAR-editor.md` §2.3 (features.js), §2.6 (rich, more2, pages) i §3.6.
- Putanje: `packages/editor-core/`, `src/lib/document/` (potonje u web repou još ne postoji; pisac ga stvara samo ako ga zadatak traži).

## 2. Ugovor
- Nema nove rute. Klijent gradi čvorove i oznake kao `type` iz ugovora v4, s preslikavanjem iz prototipnih oblika (tablica „Za klijenta”), i šalje ih kroz postojeće `evidence.*` i `live.document.put`.
- Slike: privitak prvo, u dokument idu `attachmentId` i `attachmentSha256`; tablica privitaka i rutu uvodi zaseban serverski PR (nije dio SRV-10A).

## 3. Kriteriji prihvata
- [ ] Svaki čvor iz ugovora ima Tiptap proširenje i test okruglog puta: editor → kanonski v4 JSON → editor, bajt-jednak za JCS.
- [ ] Zlatni vektori v4 (`golden-vectors-v4.json`) prolaze u klijentu i u serveru; nepoznato polje se odbija.
- [ ] Brojevi samo cijeli, neobavezna prazna polja izostavljena, formula s praznim zapisom se ne umeće.
- [ ] Dok rad nije v4 (ugovor §10), klijent šalje v3 i ne nudi v4 alate.
- [ ] Postojeći testovi v1 do v3 nepromijenjeni i zeleni; testovi s izmišljenim tekstom (nikad stvarni rad, uključujući `samples/diplomski.json`).

## 4. Ovisnosti
- SRV-10A ugovor spojen. Validator i shema v4 (PR-ovi 2 i 3), potrošači (4), korak `ductus-edit-steps-v4` (5) i replay (6) moraju biti spojeni prije slanja v4 poslužitelju; korak baze (ugovor §10) još nema zadatak.

## 5. Otvorena odluka: ODLUKA ORKESTRATORA
Ugovor v4 drži otvorena pitanja: P2 marker (smije li nastavnik i izvoz izostaviti `highlight`), P3 (gdje živi obrazloženje potvrde lijepljenja), P4 (blok `orderedItem`). Ne grade se dok se ne odluče.
