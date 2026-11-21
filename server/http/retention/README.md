# HTTP za probni prolaz čuvanja

`GET /api/v1/institution/retention` (SRV-1304, plan M10.2 i M10.7) daje administratoru ustanove iz sesije katalog klasa podataka za čuvanje (`server/domain/retention`): po klasi ključ poruke, rok u danima ili `null` dok D-30 nije odlučen, način (`execute` ili `dry-run`; rok `null` je uvijek `dry-run`), broj kandidata za brisanje i vrijeme zadnjeg izvršenog prolaza (`null` dok se prolazi ne bilježe).

Brojeve daje `app.retention_candidates` za ustanovu iz sesije; funkcija samo čita i ništa ne briše. Nastavnik, student i administrator druge ustanove dobivaju 403 (`ZD403` iz baze), poziv bez žive sesije 401, upit u adresi 422, a zahtjev s druge stranice (`Sec-Fetch-Site`) 403. Hashevi i potvrde predaje zasebna su klasa koja se ne briše i ne broji (`candidates: null`).
