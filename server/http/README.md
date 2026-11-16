# server/http

Područje iz [karte servera](../../docs/server-map.md). Jedini sastavljač: HTTP poslužitelj, slojevi prije routera (S-1B-b, DAN-777), router i registar baza (S-1B-a, DAN-775).

## Što radi

- `startServer` pokreće `node:http` poslužitelj i propušta zahtjev kroz slojeve (`createPipeline`), zatim kroz router. Vraća stvarni port i `close()`. Greška pri slušanju (npr. `EADDRINUSE`) odbija obećanje s kodom greške.
- `createRouter` traži rutu po metodi i putanji iz ugovora (`server/contracts`), s točnim podudaranjem i bez upita. Odbijanja imaju oblik ugovora:
  - nepoznata putanja: 404 `{"error":"not_found"}` (`FALLBACK`);
  - druga metoda: 405 `{"error":"method_not_allowed"}` uz `Allow`;
  - iznimka u rukovatelju: 500 `{"error":"internal"}` (`INTERNAL` iz ugovora, DAN-776), a zapisuje se samo događaj `server_error` (niže).
  - Sve odgovore 500 šalje `answerInternal` (`security-headers.ts`). Prije prvog bajta briše sva zaglavlja, trailere i statusnu liniju koje je postavio rukovatelj ili sloj, ponovno postavlja sigurnosna zaglavlja i zatvara vezu. Nakon početka odgovora prekida samo nedovršen odgovor, a dovršeni pušta do kraja. Nikad ne baca iznimku.
  - `sendJson` (`json.ts`) serijalizira tijelo prije `writeHead`, pa tijelo koje se ne može serijalizirati daje 500 `internal`, a ne prekinutu vezu.
- `error-catalog.ts` (S-1M-c, DAN-802) je katalog grešaka za preloader: `ERROR_CATALOG` ima `{ status, code, messageKey }` za 400, 401, 403, 404, 408, 429, 500, 502, 503, 504 i `session_expired` (401). Status koji server odgovara nosi ugovornu grešku tog statusa i njezin ključ `errors.*`, isti kao `messageKey` problem tijela; 429, 502, 504 i `session_expired` server danas ne šalje, pa su im tekstovi u `clientErrors.*`. Svaki ključ ima tekst u `hr` i `en`. `catalogErrorFor(status)` daje stavku statusa, inače 400 za drugi 4xx i 500 za sve ostalo; `session_expired` se dohvaća samo po kodu (`catalogErrorOf`). Kad ugovor dobije 429 (S-1C.3) ili `session_expired` (S-1D-d), test traži da stavka prijeđe na ugovornu grešku.
- Neuhvaćena greška (rukovatelj, sloj ili cijeli zahtjev) daje 500 `internal` (`answerInternal`) i jedan JSON redak na stderr: `{"event":"server_error","where":"route"|"layer"|"request","errorClass","requestId","route"?}` (`reportServerError`). `errorClass` je iz zatvorenog popisa (`type_error`, `range_error`, `reference_error`, `syntax_error`, `other`), `route` je samo id rute iz ugovora. Nikad poruka, stog, ime podklase, URL, zaglavlja ni tijelo. **Vezanje (S-1K.3-a):** kad servis zapisa postoji, `reportServerError` piše `error.unexpected` iz kataloga `server/log/events` s `area: "http"` i istim `errorClass` (popis je podskup, provjerava test); pozivatelji se ne mijenjaju (potvrda ugovora Ductus#1836 c.6904663277).
- `createHealthRoute({ health, serverVersion })` daje `GET /api/v1/health` (S-1M-a, DAN-795): uvijek 200, `Cache-Control: no-store` i tijelo točno `{"status":"ok","state","apiVersion","serverVersion","minClientVersion"}`. `state` je `degraded` kad glavna baza nije `ok`, kad provjera baci ili ne završi u `CHECK_DEADLINE_MS` (2,5 s); baze zapisa i pravnih tekstova ga ne mijenjaju. Jedna provjera odgovara svim zahtjevima 1 s. Nikad adresa, ime baze ni poruka greške; sesiju ne čita (prijenos Ductusa `app/api/health/route.ts`, proširen).
- `auth-flow.ts` (S-1E-a, DAN-808; doslovni prijenos dijela Ductus `src/server/auth/flow.ts` na `078c780`): `startLogin` i `finishLogin` kao funkcije `Request` → `Response`, `failurePage` (neutralna stranica, tekst iz `locales/` kroz jedinu iznimku uvoza u `scripts/lint-rules/area-boundary.ts`, `LOCALE_IMPORT_ALLOWED`) i `AuthDeps` (portovi `config`, `oidc`, `openSession`, `closeSession`). Tok je u `http`, jer jedino sastavljač smije uvoziti vrijednosti iz `external/srce-auth` (odluka Ductus#1836 c.6906402529). Kolačić sesije po imenu čita i postavlja `session` (`previousSessionToken`, `sessionSetCookie`). Odjava je S-1D-d.
- `evidenceSession` (DAN-805, uski rez VS-1, korak 1; prijenos dijela Ductusa `ingest-http.ts`) je sesijski korak ruta evidencije prije tijela: token iz zaglavlja `Cookie` i, s `live`, živa sesija u bazi. Ne čita tijelo, ne piše odgovor ni kolačić i ne mijenja redak sesije; vraća prolaz s tokenom ili odbijanje s tijelom i zaglavljima vektora (401 `{status:"unauthenticated"}`, 503 `{status:"unavailable",stage:"context"}` uz `retry-after: 5`). Uz `live` bazu ne pita kad `declaredLengthRefusal` već odbija duljinu; tada je prolaz `verified: false`. Pisač tijela `{status}` kroz router dolazi s rutom `open`.
- `createAuthRoutes(env)` (`auth.ts`, S-1E-a, DAN-808; zamjena za Ductus `deps.ts` i `app/api/auth/{login,callback}/route.ts`) daje `GET /api/v1/auth/login` i `GET /api/v1/auth/callback` iz ugovora. Ovisnosti (`loadAuthDeps`: `loadAuthConfig`, `createOidcClient`, `openSession` preko prijave `ductus_auth`, `closeSession` preko `withActor`) slaže tek na prvom zahtjevu prijave, pa server bez postavki prijave i dalje kreće i odgovara na zdravlje. Postavke koje se ne učitaju, među njima lažni pružatelj uz `NODE_ENV` koji nije `development` ni `test` (D-09), završavaju na neutralnoj stranici 503 koja ne imenuje varijablu. `NODE_ENV` čita iz okoline koju predaje `server.ts`. Zahtjev za tok gradi se od puta i upita na originu `OIDC_REDIRECT_URI` (nikad od `Host`) i nosi samo kolačiće.
- `sendHtmlProblem(response, spec, html, setCookies)` (`problem.ts`) je HTML stranica greške za navigaciju preglednika: samo za grešku rute s `body: "html"`, inače 500 `internal`. Zadržava sigurnosna zaglavlja, request id i samo zadane `Set-Cookie` (brisanje kolačića pokušaja) uz `no-store` i `no-referrer`; `Location` i kolačić rukovatelja ne prolaze.
- `routesOf` daje rute imenovanih područja (`areas.ts`).
- `createDatabases` daje registar baza nad `server/database`. Ništa ne otvara, jer se veza otvara pri prvoj upotrebi. `close()` zatvara otvorene bazene pri gašenju; svaka nova baza u registru zatvara se i ondje.
- `shutdown.ts` (S-1B-c, DAN-778; prijenos Ductusa `src/server/shutdown.ts`): svaki zahtjev uzima ulaznicu koordinatora. Prvi SIGTERM ili SIGINT redom: prestaje primati veze i zatvara prazne keep-alive veze; svaki zahtjev raščlanjen nakon signala dobiva 503 `{"error":"unavailable"}` uz `Retry-After: 1`, i na istoj vezi iza zahtjeva u tijeku (pipelining); `Connection: close` nosi samo zadnji odgovor na vezi, najviše 16 odbijanja po vezi, a odbijeni zahtjev s tijelom uvijek zatvara vezu (DAN-778 c3, ugovor Ductus#1836 c.6895155382); čeka započete zahtjeve i dugovane 503 (`hold()`); veza koja se zatvara čita se još najviše 1 s dok je klijent ne zatvori, da reset ne odreže već poslane bajtove; zatim kuke redom (`FLUSH_LOGS`, pa baze); izlaz 0. Drugi signal ne pokreće ništa novo. Jedan rok od signala (`SHUTDOWN_GRACE_MS`, zadano 8000 ms) pokriva sve: nakon njega izlaz 1 i redak `shutdown.deadline` s fazom; kuka koja baci daje izlaz 1 i `shutdown.hook_failed`. U zapisu su samo imena, nikad poruka greške ni zahtjev.
- `PIPELINE_STEPS` je jedini popis koraka 2–7 toka zahtjeva (`docs/server-map.md` §3), zamrznut i provjeren testom nad tablicom. `createPipeline` prima jedan sloj po imenu koraka, ne niz, pa se redoslijed ne može zadati ni promijeniti; suvišan, nedostajući ili ne-funkcijski korak baca pri pokretanju. Sloj koji odbije, baci ili vrati išta osim `"next"` zaustavlja zahtjev prije aplikacije (500 `{"error":"internal"}` ako sloj nije sam odgovorio).
- `createLayers` daje slojeve: korak 2 je IP klijenta (`clientIpLayer` iz `traffic`, S-1C.1; `X-Forwarded-For` samo od proxyja iz `trustedProxies`, bez njih nikad); koraci 3–5 (IP prava, ograničenje, zapis prometa) prazni su do vala 5; korak 6 su sigurnosna zaglavlja (`security-headers.ts`, prijenos Ductusa); korak 7 je zaštita porijekla (`mutation-request.ts`, prijenos Ductusa).
- Zaštita porijekla: osim `GET`, `HEAD` i `OPTIONS` svaka metoda mijenja stanje i traži točno jedno zaglavlje `Origin` jednako `APP_ORIGIN` te `Sec-Fetch-Site` koji nedostaje ili je točno jednom `same-origin`. Inače 403 s tijelom problema (`code` je `origin_missing`, `origin_mismatch` ili `cross_site`; kodovi ugovora). Bez `APP_ORIGIN` svaka takva metoda dobiva 403. Tijelo zahtjeva se ne čita.
- `refuse` je jedini način na koji sloj odbija: tijelo ugovora i sigurnosna zaglavlja, i za korake prije koraka 6.
- `readBodyWithLimit` (DAN-777, dio a2; prijenos Ductusa) čita tijelo mijenjajuće rute kao sirove bajtove do tvrde granice, prije bilo kakvog parsiranja; ništa ne dekodira. Deklarirani `Content-Length` iznad granice odbija se bez čitanja (413), neispravan je 400, tijelo bez deklarirane duljine prekida se na prvom komadu preko granice (413), prekinuto tijelo je `body_stream_error` (400), a rok `timeoutMs` daje 408. Svaki komad se kopira u jedan međuspremnik do granice, pa memorija ne raste s brojem komada. Drugi čitač istog zahtjeva dobiva `body_stream_error`. Pri odbijanju čitanje staje, a `refuse()` zatvara vezu. Pipeline čeka da odgovor dobije otvoren socket, pa zahtjev poslan iza odbijanja na istoj vezi (pipelining) ne ulazi ni u slojeve ni u aplikaciju. `declaredLengthRefusal` je isto pravilo samo iz zaglavlja, za rutu koja radi nešto prije tijela.

## Tko ga zove

Samo ulazna točka `server/server.ts` i `test-server`.

## Koje podatke dira

Zaglavlja i tijelo zahtjeva, samo u memoriji. Ništa ne sprema.

## Što izvozi

- `startServer`, `Running`, `StartOptions` (`start.ts`);
- `createLayers`, `createPipeline`, `PIPELINE_STEPS`, `App`, `Layer`, `Layers`, `Step` (`pipeline.ts`);
- `clientIpOf`, `parseTrustedProxies`, `TrustedProxies` (iz `traffic`, za ulaznu točku i `test-server`);
- `createShutdownCoordinator`, `installShutdown`, `FLUSH_LOGS`, `SHUTDOWN_GRACE_MS`, `ShutdownCoordinator`, `ShutdownHook` (`shutdown.ts`);
- `createRouter`, `Route`, `Handler`, `Router` (`router.ts`);
- `readBodyWithLimit`, `declaredLengthRefusal`, `LimitedBodyResult` (`mutation-request.ts`);
- `createHealthRoute` i `CHECK_DEADLINE_MS` (`health.ts`);
- `evidenceSession`, `EvidenceSession`, `EvidenceRefusal` (`evidence-session.ts`);
- `ERROR_CATALOG`, `catalogErrorFor`, `catalogErrorOf`, `SESSION_EXPIRED`, `reportServerError`, `SERVER_ERROR_CLASSES` i tipovi (`error-catalog.ts`);
- `AREA_NAMES`, `AreaWithRoutes`, `routesOf` (`areas.ts`);
- `createDatabases`, `Databases` (`databases.ts`);
- `startLogin`, `finishLogin`, `LOGIN_COOKIE_NAME`, `AuthDeps` (`auth-flow.ts`);
- `createAuthRoutes`, `loadAuthDeps` (`auth.ts`) i `sendHtmlProblem` (`problem.ts`).

## Što ne smije uvoziti

Smije uvoziti područja iz svojeg retka [karte servera, §2](../../docs/server-map.md#2-dopušteni-uvozi), i to kroz njihov `index.ts`. Ne uvozi `test-server`, `domain` ni lažne zamjene.
