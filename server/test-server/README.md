# server/test-server

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

Server sastavljen s lažnim zamjenama (lažni AAI OIDC iz `@ductura/test-fakes`, PGlite, lažna baza zapisa) za testove servera i klijenata.

## Tko ga zove

Samo testovi. Nitko u `server/` ne uvozi `test-server`.

## Koje podatke dira

Samo izmišljeni podaci.

## Što izvozi

- `TEST_SERVER_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `TEST_SERVER_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `TestServerService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `http` i `settings`. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
