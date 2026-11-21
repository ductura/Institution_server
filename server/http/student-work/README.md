# Rad studenta (HTTP)

SRV-1412 (plan M2.1 do M2.3), tanki HTTP adapter nad `server/database/student-work`.

- `POST /api/v1/assignments/{assignmentId}/start` (`student-work.start.post`): započinje studentov rad ili vraća već započeti; odgovor je `{ workId, rulesVersion, language }`. Dvostruki start vraća isti `workId`. Zadatak tuđeg kolegija, nepostojeći i neispravan id su isti 404 (C-23); nepotvrđena obavijest ili zadatak koji još nije otvoren su 409 i ništa se ne zapisuje.
- `GET /api/v1/student/works` (`student-work.works.get`): studentovi započeti radovi, bez ijednog polja nastavnika i bez drugih osoba.

Provjeru Origina za POST radi zajednički sloj (`mutation-request.ts`); zahtjev s drugog sitea za GET je 403 kao kod ostalih studentskih čitanja.
