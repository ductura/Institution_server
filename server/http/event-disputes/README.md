# server/http/event-disputes

Postavlja dvije rute osporavanja i dopuna događaja procesnog sažetka (SRV-1315, Ductus#2052; plan M7.8, R-08) nad SRV-1314:

- `GET /api/v1/works/{documentId}/event-disputes` vraća `200 {disputes: [{disputeId, kind, eventId, text, createdAt}]}` vlasniku rada i čitateljima rada (nastavnik kolegija, nastavnik seminarske grupe, mentor);
- `POST` na isti put prima `{kind: "amendment" | "dispute", eventId, text}` i vraća `201 {disputeId, createdAt}`, samo vlasniku rada.

Kolačić određuje sesiju (401); POST prolazi sloj `mutation-request` (origin, Sec-Fetch-Site, tijelo do 4 KiB). Čitatelj rada koji nije vlasnik na POST dobiva 403; tuđi, nepostojeći ili neispravan rad je isti 404 (C-23). Neispravan unos je 422. Zapis se samo dodaje i stoji uz događaj: procesni sažetak i potvrda ostaju nepromijenjeni (prikaz uz događaj radi klijent). Podaci idu samo kroz `server/database/event-disputes`.
