# server/http/suggestions

Postavlja četiri rute prijedloga izmjene teksta nastavnika (SRV-ED42-PRIJEDLOZI, PITANJE ED-42; D-34, C-9, D-266 t. 1), sve `POST`, pa ID rada nikad nije u adresi:

- `POST /api/v1/suggestions/list` (`collaboration.suggestions-list.post`): prijedlozi rada, isti za studenta vlasnika i nastavnike;
- `POST /api/v1/suggestions` (`collaboration.suggestions.post`): nastavnik rada predlaže tekst za sidreni citat stanja uživo;
- `POST /api/v1/suggestions/accept` (`collaboration.suggestion-accept.post`): student vlasnik prihvaća; odgovor nosi točne JCS bajtove za njegov `live.document.put` i zabilježenu promjenu s izvorom `teacher-suggestion`;
- `POST /api/v1/suggestions/reject` (`collaboration.suggestion-reject.post`): student vlasnik odbija.

Rukovatelj provjerava kolačić, vrstu sadržaja, tijelo i oblik ugovora; tko smije i stanje prijedloga odlučuje baza kroz `server/database/suggestions`. Tuđi, nepostojeći i neispravan rad je 404, nastavnik ne može odlučiti (403), druga odluka i promijenjeno stanje su 409. Prijedlog sam ne mijenja rad ni njegovu evidenciju.
