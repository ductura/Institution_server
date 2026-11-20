# server/http/work-sources

Izvori rada preko HTTP-a (SRV-7C, Ductus#2028, val 7 „Citati i izvori”). Ugovor je `server/contracts/routes/student-sources.ts`, tablica i RPC-ovi su SRV-7B (`institution.work_source`, `work_sources`, `save_work_source`, `delete_work_source`).

## Što radi

`createWorkSourceRoutesFor({ withActor })` daje tri rute za studenta:

- `GET /api/v1/student/assignments/{assignmentId}/sources`: popis izvora vlastitog rada, najstariji prvi. Sadrži i izvore koje je nastavnik preporučio ili zahtijevao (`requirement`: čitanje preporučenih i obveznih izvora zadatka).
- `PUT /api/v1/student/assignments/{assignmentId}/sources/{sourceId}`: dodaje izvor ili mijenja vlastiti (isti `sourceId`, koji klijent bira i koji mora biti jednak `record.id`). Tijelo je `{record, doi?, isbn?, undated?}`.
- `DELETE /api/v1/student/assignments/{assignmentId}/sources/{sourceId}`: uklanja vlastiti izvor, 204.

Sesija sama određuje studenta. Odbijanje pristupa (rad ili zadatak koji ne postoji, tuđi rad, nastavnikov izvor) je jedan odgovor, 404, kao u bazi (ZD403). `ZD401` je 401, `ZD422` (u tome i 500 izvora) je 422, ostalo 503. Samo uspješan zapis (PUT 200, DELETE 204) broji aktivnost sesije.

## Provjera zapisa

Oblik zapisa izvora (`record`) provjerava se prije baze protiv `WorkSourceRecord` iz ugovora: zatvoreni objekti, četiri vrste, polja i granice iz sheme dokumenta v2 §2. Unaprijed prevedeni validator ulaza ide samo jednu razinu duboko, pa je `record` u ugovoru otvoren objekt, a dubinu provjerava ovaj rukovatelj. Baza provjerava manji dio istog (`work_source_record_valid`).

Poznata granica: puna provjera sheme dokumenta (`validateSources`, uključujući kalendarski ispravan datum pristupa i zabranjene znakove) živi u `server/domain/document`, koje `http` ne smije uvoziti (`docs/server-map.md` §2). Sloj `server/institution` je može preuzeti; to je zasebni korak, a do tada vrijedi shema iz ugovora.

## Testovi

`work-sources.integration.test.ts`: pravi HTTP, lažni `withActor`; prolaz, odbijanja prije SQL-a, preslikavanje ZD401/ZD403/ZD422 i redak koji nije izvor.
