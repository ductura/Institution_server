# SRV-9E `usporedba-verzija` (val 9, traka S-A)

Risk: high. Čita evidenciju i tuđi rad, pa vrijede PRODUCT §5 pravila 5, 7 i 17. Pisac ne nagađa odluku niže.

## 1. Izvor
- PLAN-MIGRACIJE.md, „Val 9” (N-11 usporedba, ✓ C-10 „nastavnik uspoređuje bilo koje dvije verzije”) i Danielov odgovor C-10 u `ODGOVORI-DANIEL-2026-11-19.md`.
- Prototip: `INVENTAR-nastavnik.md` §3.11 (N-11: Dodano n / Uklonjeno m riječi, ins/del s „dodano:” i „uklonjeno:”); `INVENTAR-editor.md` §3.5 mentor3 „Usporedi predaje” (`m3hist`).
- Kod: `work.versions.get` (SRV-9A, #458), `evidence.replay.post`, rekonstrukcija iz evidencije (`server/evidence/`).

## 2. Ugovor rute (PRIJEDLOG; uvodi ga prvo serverski PR, uz inventory, version i vectors)
- id `work.compare.get`, `GET /api/v1/works/{documentId}/compare?from={revision}&to={revision}`, pristup `owner_or_course_teacher`.
- 200: `{from:{revision,kind}, to:{revision,kind}, blocks:[{op:"same|added|removed|changed", words:[{op:"same|added|removed", text}]}], counts:{addedWords,removedWords}, truncated}`. Bez veličine promjene u postocima, boja ni ocjene.
- Greške: 401 `unauthorized`, 404 `not_found` (tuđi, nepoznat, neispravan id i nedopuštena revizija), 422 `invalid_input` (`from` = `to`, neispravan broj), 503 `unavailable`.
- Nastavnikovo čitanje piše dnevnik pristupa kao `work.versions.get`.

## 3. Kriteriji prihvata
- [ ] Rekonstrukcija obiju revizija ide kroz replayer koji provjerava `removedSha256` (B-12); nepodudaranje daje 404, ne djelomičan odgovor.
- [ ] Razlika po odlomcima, pa po riječima samo u izmijenjenom odlomku; iznad granice veličine `truncated: true`, bez rušenja.
- [ ] Odgovor ne sadrži međustanja, obrisani i napisani tekst, postotke ni oznake podrijetla (§5 pravila 2, 7, 8).
- [ ] Vektori uspjeha i grešaka, ponovno generiran ugovor i lažni poslužitelj; test dnevnika pristupa za nastavnika.
- [ ] Negativni testovi: tuđi rad, student drugog kolegija, revizija iznad predane.

## 4. Ovisnosti
- Spojeno: SRV-9A `work.versions.get` (#458). Ne treba drugi SRV; WEB-9B čeka ovaj ugovor.

## 5. Otvorena odluka: ODLUKA ORKESTRATORA (vlasnik ako se mijenja pravilo 7)
Nesklad izvora ostaje otvoren: plan ✓ C-10 kaže „bilo koje dvije verzije”, a PRODUCT §5 pravilo 7 dopušta samo razliku između dviju poslanih verzija. Spremljena točka (`checkpoint`) nije poslana verzija, a runde „poslano na pregled” nemaju zapis u bazi.
- A) `from` i `to` samo poslane verzije (predaja, kasnije runda); sve ostalo 404. Ne mijenja pravilo 7.
- B) i spremljene točke: traži izmjenu pravila 7 koju odlučuje vlasnik.
Dok odluke nema, pisac gradi samo `server/evidence/compare/` (rekonstrukcija i razlika) i ne montira rutu.
