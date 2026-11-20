# server/http/work-sources

Izvori rada preko HTTP-a (SRV-7C, Ductus#2028, val 7 „Citati i izvori”). Ugovor je `server/contracts/routes/student-sources.ts`, tablica i RPC-ovi su SRV-7B (`institution.work_source`, `work_sources`, `save_work_source`, `delete_work_source`).

## Što radi

`createWorkSourceRoutesFor({ withActor })` daje tri rute za studenta:

- `GET /api/v1/student/assignments/{assignmentId}/sources`: popis izvora vlastitog rada, najstariji prvi. Sadrži i izvore koje je nastavnik preporučio ili zahtijevao (`requirement`: čitanje preporučenih i obveznih izvora zadatka).
- `PUT /api/v1/student/assignments/{assignmentId}/sources/{sourceId}`: dodaje izvor ili mijenja vlastiti (isti `sourceId`, koji klijent bira i koji mora biti jednak `record.id`). Tijelo je `{record, doi?, isbn?, undated?}`.
- `DELETE /api/v1/student/assignments/{assignmentId}/sources/{sourceId}`: uklanja vlastiti izvor, 204.

Sesija sama određuje studenta. Za nepostojeći ili tuđi rad i za pokušaj izmjene ili uklanjanja nastavnikova izvora API vraća 404. Nevaljana sesija daje 401. Nevaljan zahtjev za spremanje ili prekoračenje granice od 500 izvora daje 422. Neočekivana pogreška daje 503. Samo uspješan zapis (PUT 200, DELETE 204) broji aktivnost sesije.

## Provjera zapisa

Rukovatelj provjerava `record` prema `WorkSourceRecord` iz ugovora i uspoređuje njegov ID s putanjom. Adapter `createWorkSources` iz SRV-7B provodi punu provjeru sheme dokumenta (`validateSources`) i kontrolne znamenke ISBN-a prije poziva RPC-a. DOI mora biti zapisan malim slovima, a ISBN bez razdjelnika.

## Testovi

Test `work-sources.integration.test.ts` otvara HTTP poslužitelj sa stvarnim adapterom SRV-7B i simuliranim `withActor`. Pokriva dodavanje, izmjenu, ponovno čitanje i uklanjanje, obje oznake izvora nastavnika, odbijanja prije poziva RPC-a, pogreške pristupa i neočekivani odgovor baze.
