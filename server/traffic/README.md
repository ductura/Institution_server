# server/traffic

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

IP prava, ograničenje broja zahtjeva i zapis prometa: koraci 3 do 5 toka zahtjeva iz karte. Ograničenje broji zahtjeve po IP-u i po hashu sirovog kolačića sesije; sesiju ne razrješava.

## Tko ga zove

Samo `http`.

## Koje podatke dira

Brojači ograničenja u memoriji. Zapis prometa i sigurnosne događaje piše preko `log` u bazu zapisa, bez tijela zahtjeva, kolačića, tokena i upita iz URL-a.

## Što izvozi

- `TRAFFIC_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `TRAFFIC_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `TrafficService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log` i `metrics`, i to kroz njihov `index.ts`. Ne uvozi `http`, `database`, `external/*` ni feature područja. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
