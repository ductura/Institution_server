# server/http/security

Sigurnosna zaglavlja i istek neaktivne sesije na svakom odgovoru `/api/v1` (SRV-1401, DAN-296, plan M1.6). Dio područja `http` iz [karte servera](../../../docs/server-map.md).

## Što radi

- `headers.ts`: vrijednosti `CONTENT_SECURITY_POLICY` (bez `unsafe-inline` i `unsafe-eval`; API ne vraća oznake, pa se ništa ne učitava), `PERMISSIONS_POLICY` (kamera, mikrofon i lokacija isključeni, uz ostale osjetljive mogućnosti) i `STRICT_TRANSPORT_SECURITY` (dvije godine). `enforceSecurityHeaders(response, mode)` omata `writeHead` tog odgovora, kroz koji prolazi svako pisanje zaglavlja (i `end`, `write`, `flushHeaders`): vrijednost tih triju zaglavlja koju je postavio rukovatelj, u `setHeader` ili u argumentu `writeHead`, odbacuje se i postavlja se serverova. U lokalnom načinu (`{ local: true }`) HSTS se uklanja. `startServer` to radi prvo za svaki zahtjev, pa zaglavlja imaju i uspješni odgovori, i odbijanja slojeva, routera i rute, i 503 dok se server gasi. Bez načina vrijedi `PRODUCTION_SECURITY` (HSTS uključen).
- `idle-guard.ts`: `guardIdleSessions(routes, tracker)` omata rute kojima treba sesija (`access` nije `anyone` ni `identity_provider`, i nije odjava, `IDLE_EXEMPT_ROUTE_IDS`). S kolačićem žive sesije pita tracker iz `server/identity`; istekla sesija dobiva 401 `session_idle_expired` (`SESSION_IDLE_EXPIRED` iz ugovora, zajednička greška) prije rukovatelja, uz zatvaranje veze, pa se tijelo ne čita. Odgovor ispod 400 produljuje sesiju; odbijen zahtjev je ne produljuje, pa token koji baza odbija nema zapis. Odjava nije provjerena, kako bi istekla sesija i dalje mogla završiti u bazi i obrisati kolačić.

Ostala sigurnosna zaglavlja (`X-Frame-Options`, `Referrer-Policy`, `X-Content-Type-Options`, `Cache-Control`) i dalje postavlja korak 6 cjevovoda (`security-headers.ts`), a ruta ih smije promijeniti.

## Tko ga zove

`server/http/start.ts` (`startServer`, opcije `security` i `idle`), a način rada predaje `server/server.ts`: lokalno je `NODE_ENV` `development` ili `test` (`isNonProductionBuild`). `security-header-values.ts` čita vrijednosti.

## Koje podatke dira

Samo zaglavlja odgovora i kolačić sesije zahtjeva (u memoriji, ništa ne sprema).

## Što izvozi

`index.ts`: vrijednosti i imena zaglavlja, `ENFORCED_HEADER_NAMES`, `enforcedHeaders`, `enforceSecurityHeaders`, `PRODUCTION_SECURITY`, tip `SecurityMode`, `guardIdleSessions`, `needsIdleCheck` i `IDLE_EXEMPT_ROUTE_IDS`.

## Što ne smije uvoziti

`headers.ts` ne uvozi ništa iz `server/http`, jer ga `security-header-values.ts` čita dok se `http` učitava. `idle-guard.ts` uvozi `contracts`, `identity` i `session` kroz njihov `index.ts`, a iz `http` samo `refuse` i tipove, koje koristi tek pri pozivu. `no-route-policy.test.ts` provjerava da nijedna druga produkcijska datoteka pod `server/` ne imenuje CSP, Permissions-Policy ni HSTS u nizu znakova.
