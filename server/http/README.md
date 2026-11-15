# server/http

Područje iz [karte servera](../../docs/server-map.md). Jedini sastavljač: HTTP poslužitelj, slojevi prije routera, router i registar baza (S-1B-a, DAN-775).

## Što radi

- `startServer` pokreće `node:http` poslužitelj, redom propušta zahtjev kroz slojeve, zatim kroz router. Vraća stvarni port i `close()`. Greška pri slušanju (npr. `EADDRINUSE`) odbija obećanje s kodom greške.
- `createRouter` traži rutu po metodi i putanji iz ugovora (`server/contracts`), s točnim podudaranjem i bez upita. Odbijanja imaju oblik ugovora:
  - nepoznata putanja: 404 `{"error":"not_found"}` (`FALLBACK`);
  - druga metoda: 405 `{"error":"method_not_allowed"}` uz `Allow`;
  - iznimka u rukovatelju: 500 `{"error":"internal"}`, a zapisuje se samo ime greške.
- `HEALTH_ROUTE` je `GET /api/v1/health`, s tijelom točno `{"status":"ok"}` i `Cache-Control: no-store`. Ne čita bazu, sesiju ni okolinu (prijenos Ductusa `app/api/health/route.ts`).
- `routesOf` daje rute imenovanih područja (`areas.ts`).
- `createDatabases` daje registar baza nad `server/database`. Ništa ne otvara, jer se veza otvara pri prvoj upotrebi.

Slojeve (koraci 2–7 toka zahtjeva) puni S-1B-b, a gašenje S-1B-c.

## Tko ga zove

Samo ulazna točka `server/server.ts` i `test-server`.

## Koje podatke dira

Zaglavlja i tijelo zahtjeva, samo u memoriji. Ništa ne sprema.

## Što izvozi

- `startServer`, `Layer`, `Running`, `StartOptions` (`start.ts`);
- `createRouter`, `Route`, `Handler`, `Router` (`router.ts`);
- `HEALTH_ROUTE` (`health.ts`);
- `AREA_NAMES`, `AreaWithRoutes`, `routesOf` (`areas.ts`);
- `createDatabases`, `Databases` (`databases.ts`).

## Što ne smije uvoziti

Smije uvoziti područja iz svojeg retka [karte servera, §2](../../docs/server-map.md#2-dopušteni-uvozi), i to kroz njihov `index.ts`. Ne uvozi `test-server`, `domain` ni lažne zamjene.
