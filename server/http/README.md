# server/http

Područje iz [karte servera](../../docs/server-map.md). Jedini sastavljač: HTTP poslužitelj, slojevi prije routera (S-1B-b, DAN-777), router i registar baza (S-1B-a, DAN-775).

## Što radi

- `startServer` pokreće `node:http` poslužitelj i propušta zahtjev kroz slojeve (`createPipeline`), zatim kroz router. Vraća stvarni port i `close()`. Greška pri slušanju (npr. `EADDRINUSE`) odbija obećanje s kodom greške.
- `createRouter` traži rutu po metodi i putanji iz ugovora (`server/contracts`), s točnim podudaranjem i bez upita. Odbijanja imaju oblik ugovora:
  - nepoznata putanja: 404 `{"error":"not_found"}` (`FALLBACK`);
  - druga metoda: 405 `{"error":"method_not_allowed"}` uz `Allow`;
  - iznimka u rukovatelju: 500 `{"error":"internal"}`, a zapisuje se samo ime greške.
- `HEALTH_ROUTE` je `GET /api/v1/health`, s tijelom točno `{"status":"ok"}` i `Cache-Control: no-store`. Ne čita bazu, sesiju ni okolinu (prijenos Ductusa `app/api/health/route.ts`).
- `routesOf` daje rute imenovanih područja (`areas.ts`).
- `createDatabases` daje registar baza nad `server/database`. Ništa ne otvara, jer se veza otvara pri prvoj upotrebi.

- `PIPELINE_STEPS` je jedini popis koraka 2–7 toka zahtjeva (`docs/server-map.md` §3), zamrznut i provjeren testom nad tablicom. `createPipeline` prima jedan sloj po imenu koraka, ne niz, pa se redoslijed ne može zadati ni promijeniti; suvišan, nedostajući ili ne-funkcijski korak baca pri pokretanju. Sloj koji odbije, baci ili vrati išta osim `"next"` zaustavlja zahtjev prije aplikacije (500 `{"error":"internal"}` ako sloj nije sam odgovorio).
- `createLayers` daje slojeve: koraci 2–5 (IP, IP prava, ograničenje, zapis prometa) prazni su do vala 5; korak 6 su sigurnosna zaglavlja (`security-headers.ts`, prijenos Ductusa); korak 7 je zaštita porijekla (`mutation-request.ts`, prijenos Ductusa).
- Zaštita porijekla: osim `GET`, `HEAD` i `OPTIONS` svaka metoda mijenja stanje i traži točno jedno zaglavlje `Origin` jednako `APP_ORIGIN` te `Sec-Fetch-Site` koji nedostaje ili je točno jednom `same-origin`. Inače 403 `{"error":"origin_missing" | "origin_mismatch" | "cross_site"}` (kodovi ugovora). Bez `APP_ORIGIN` svaka takva metoda dobiva 403. Tijelo zahtjeva se ne čita.
- `refuse` je jedini način na koji sloj odbija: tijelo ugovora i sigurnosna zaglavlja, i za korake prije koraka 6.

- `readBodyWithLimit` (DAN-777, dio a2; prijenos Ductusa) čita tijelo mijenjajuće rute kao sirove bajtove do tvrde granice, prije bilo kakvog parsiranja; ništa ne dekodira. Deklarirani `Content-Length` iznad granice odbija se bez čitanja (413), neispravan je 400, tijelo bez deklarirane duljine prekida se na prvom komadu preko granice (413), prekinuto tijelo je `body_stream_error` (400), a rok `timeoutMs` daje 408. Pri odbijanju čitanje staje, a `refuse()` zatvara vezu, pa se ostatak ne čita. `declaredLengthRefusal` je isto pravilo samo iz zaglavlja, za rutu koja radi nešto prije tijela.

Gašenje donosi S-1B-c.

## Tko ga zove

Samo ulazna točka `server/server.ts` i `test-server`.

## Koje podatke dira

Zaglavlja i tijelo zahtjeva, samo u memoriji. Ništa ne sprema.

## Što izvozi

- `startServer`, `Running`, `StartOptions` (`start.ts`);
- `createLayers`, `createPipeline`, `PIPELINE_STEPS`, `App`, `Layer`, `Layers`, `Step` (`pipeline.ts`);
- `createRouter`, `Route`, `Handler`, `Router` (`router.ts`);
- `readBodyWithLimit`, `declaredLengthRefusal`, `LimitedBodyResult` (`mutation-request.ts`);
- `HEALTH_ROUTE` (`health.ts`);
- `AREA_NAMES`, `AreaWithRoutes`, `routesOf` (`areas.ts`);
- `createDatabases`, `Databases` (`databases.ts`).

## Što ne smije uvoziti

Smije uvoziti područja iz svojeg retka [karte servera, §2](../../docs/server-map.md#2-dopušteni-uvozi), i to kroz njihov `index.ts`. Ne uvozi `test-server`, `domain` ni lažne zamjene.
