# server/legal

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

Pravni tekstovi (uvjeti, obavijest o privatnosti), njihove verzije i prihvaćanja. Feature područje: logika rute ili posla bit će u `service`.

## Tko ga zove

Samo `http`.

## Koje podatke dira

Baza pravnih tekstova; prihvaćanja u glavnoj bazi.

## Što izvozi

- `LEGAL_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `LEGAL_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `LegalService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts`, `database` i `external/email`, i to kroz njihov `index.ts`. `database` i `external/email` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
