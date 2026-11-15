# server/metrics

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

Brojači i trajanja za nadzor (zahtjevi, odbijanja, trajanje RPC-a).

## Tko ga zove

`database`, `external/srce-auth`, `external/storage`, `external/keys`, `external/email`, `traffic`, `session`, `roles`, `legal`, `backup`, `deletion`, `downloads` i `http`.

## Koje podatke dira

Metrika u memoriji i njezin izvoz za nadzor. Bez osobnih podataka i sadržaja radova.

## Što izvozi

- `METRICS_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `METRICS_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `MetricsService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, kroz njegov `index.ts`. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
