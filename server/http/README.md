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
- `createDatabases` daje registar baza nad `server/database`. Ništa ne otvara, jer se veza otvara pri prvoj upotrebi. `close()` zatvara otvorene bazene pri gašenju; svaka nova baza u registru zatvara se i ondje.
- `shutdown.ts` (S-1B-c, DAN-778; prijenos Ductusa `src/server/shutdown.ts`): svaki zahtjev uzima ulaznicu koordinatora. Prvi SIGTERM ili SIGINT redom: prestaje primati veze i zatvara prazne keep-alive veze; zahtjev koji stigne nakon signala dobiva 503 `{"error":"unavailable"}` uz `Connection: close`; čeka započete zahtjeve; zatim kuke redom (`FLUSH_LOGS`, pa baze); izlaz 0. Drugi signal ne pokreće ništa novo. Jedan rok od signala (`SHUTDOWN_GRACE_MS`, zadano 8000 ms) pokriva sve: nakon njega izlaz 1 i redak `shutdown.deadline` s fazom; kuka koja baci daje izlaz 1 i `shutdown.hook_failed`. U zapisu su samo imena, nikad poruka greške ni zahtjev.

Slojeve (koraci 2–7 toka zahtjeva) puni S-1B-b.

## Tko ga zove

Samo ulazna točka `server/server.ts` i `test-server`.

## Koje podatke dira

Zaglavlja i tijelo zahtjeva, samo u memoriji. Ništa ne sprema.

## Što izvozi

- `startServer`, `Layer`, `Running`, `StartOptions` (`start.ts`);
- `createShutdownCoordinator`, `installShutdown`, `FLUSH_LOGS`, `SHUTDOWN_GRACE_MS`, `ShutdownCoordinator`, `ShutdownHook` (`shutdown.ts`);
- `createRouter`, `Route`, `Handler`, `Router` (`router.ts`);
- `HEALTH_ROUTE` (`health.ts`);
- `AREA_NAMES`, `AreaWithRoutes`, `routesOf` (`areas.ts`);
- `createDatabases`, `Databases` (`databases.ts`).

## Što ne smije uvoziti

Smije uvoziti područja iz svojeg retka [karte servera, §2](../../docs/server-map.md#2-dopušteni-uvozi), i to kroz njihov `index.ts`. Ne uvozi `test-server`, `domain` ni lažne zamjene.
