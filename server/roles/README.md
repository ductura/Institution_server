# server/roles

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

Uloge u ustanovi. Studenta i nastavnika dodjeljuje samo administrator ustanove (c.6869502575). Feature područje: logika rute ili posla bit će u `service`.

## Tko ga zove

Samo `http`.

## Koje podatke dira

Članstva i uloge u glavnoj bazi, samo kroz RPC.

## Što izvozi

- `ROLES_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `ROLES_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `RolesService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts` i `database`, i to kroz njihov `index.ts`. `database` i `external/*` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `test-server` ni druga feature područja: s njima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
