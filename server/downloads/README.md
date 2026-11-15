# server/downloads

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

Preuzimanja: izvozi i instalacijski paketi aplikacija. Feature područje: logika rute ili posla bit će u `service`.

## Tko ga zove

Samo `http`.

## Koje podatke dira

Objekti u pohrani; zapis preuzimanja u glavnoj bazi.

## Što izvozi

- `DOWNLOADS_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `DOWNLOADS_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `DownloadsService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts`, `database` i `external/storage`, i to kroz njihov `index.ts`. `database` i `external/storage` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
