# OSN-B4 osnovica-testovi-http-sigurnost

Zapisnik osnovice faze 1 (ductura/.github#56, kategorija B): Ductusov test proizvodnog koda nema (punu) kopiju u Ducturi. Provjereno na `origin/migracija/kopija-ductus-backend` (`362b3a2`). Proizvodni kod se nije mijenjao: preneseni testovi prolaze na postojećem kodu. Ništa nije obrisano ni oslabljeno; jedna postojeća tvrdnja je pooštrena (CSP iz uzorka u točnu vrijednost).

Raspored je drukčiji nego u Ductusu. Ductus je Next.js: `content-security-policy.ts` gradi politiku stranica (nonce, hash skripte teme, `form-action` prema izdavatelju) za middleware, a `security-headers.ts` postavlja „pod” omatanjem `ServerResponse.prototype.writeHead`. Ovdje je poslužitelj samo `/api/v1`: politika API odgovora je `CONTENT_SECURITY_POLICY` u `server/http/security/headers.ts`, zaglavlja postavlja sloj `securityHeadersLayer` i `refuse()` (`server/http/security-headers.ts`), a ekvivalent omotača `writeHead` je `enforceSecurityHeaders` (po odgovoru, ne na prototipu). Stranice su u WEB repou (`ductura/Institution_front_web_chrome`).

## `src/server/http/security-headers.test.ts` → `server/http/security-headers.integration.test.ts`

Postojeća djelomična kopija dopunjena je; ime ima sufiks `.integration` jer test otvara stvarni `node:http` poslužitelj (docs/CODE_STYLE.md §7).

| Ductusov slučaj                                                                                                     | Ishod                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vrijednosti kao u konfiguraciji i politika koja ništa ne dopušta                                                    | preneseno; CSP je sada točna vrijednost (prije uzorak `^default-src 'none';.*frame-ancestors 'none'$`)                                                           |
| redci `implicit end()`, `writeHead(status)`, `writeHead(status, object)`, `flushHeaders()`                          | već preneseno; isti redci idu i kroz `enforceSecurityHeaders`                                                                                                    |
| redak `writeHead(status, message, object)`                                                                          | preneseno (sloj i omotač)                                                                                                                                        |
| redak `writeHead(status, raw array)`                                                                                | preneseno (sloj i omotač)                                                                                                                                        |
| redak „a header set by the route stays”                                                                             | preneseno kao redak i u testu „keeps a header the route set before the layer” (sada i CSP, svaki header točno jednom)                                            |
| „does nothing once the headers are sent” (204 ostaje, Nodeova greška `writeHead`, ne greška `setHeader` iz omotača) | preneseno na `enforceSecurityHeaders`; za sloj već postoji (sloj nakon poslanog zaglavlja ne baca)                                                               |
| „wraps writeHead once when installed twice”                                                                         | preneseno na `enforceSecurityHeaders`: drugi poziv ne omata ponovno, prvi način (HSTS) ostaje, svako zaglavlje jednom; povratne vrijednosti `boolean` ovdje nema |
| „a response without the floor has none of these headers”                                                            | već preneseno za sloj; dodano i za omotač                                                                                                                        |
| dodatno: `writeHead(status, array of pairs)` i sva tri prisilna imena u `writeHead(status, message, object)`        | novi redci za omotač (`withoutEnforced` grana za parove i za poruku)                                                                                             |

## `src/server/http/content-security-policy.test.ts` → `server/http/security/headers.test.ts`

| Ductusov slučaj                                                                | Ishod                                                                                                                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| „API Content-Security-Policy”: točna vrijednost                                | preneseno (`CONTENT_SECURITY_POLICY`), uz provjeru da je ista u oba načina rada (`enforcedHeaders`) i bez `unsafe`                        |
| page CSP: točna politika builda bez `unsafe`                                   | nije preneseno: poslužitelj ne renderira stranice i nema politiku stranica; ekvivalent je u WEB repou                                     |
| page CSP: `unsafe-eval` i `unsafe-inline` samo pod `next dev`                  | nije preneseno: ovdje nema `next dev` ni politike stranica                                                                                |
| page CSP: `form-action 'self'` bez izdavatelja (A6)                            | nije preneseno: API politika ima fiksni `form-action 'self'`; `form-action` prema izdavatelju treba samo stranici s obrascem odjave (WEB) |
| odbija neispravan nonce (5 slučajeva)                                          | nije preneseno: poslužitelj ne izdaje nonce                                                                                               |
| odbija neispravan hash (3 slučaja)                                             | nije preneseno: poslužitelj nema inline skripti ni hasha                                                                                  |
| THEME_SCRIPT dopuštena po hashu stvarnog teksta                                | nije preneseno: `THEME_SCRIPT` (`src/components/shell/theme.ts`) je u WEB repou                                                           |
| `issuerOriginOf`: null za nedostajući, prazan, ne-URL, javascript:, data:, ftp | nije preneseno: funkcije nema; ishodište izdavatelja treba samo politici stranica                                                         |
| `issuerOriginOf`: samo ishodište, bez putanje i vjerodajnica                   | nije preneseno: isti razlog                                                                                                               |
| nonce: 128 bita, nov pri svakom pozivu (A7)                                    | nije preneseno: poslužitelj ne izdaje nonce                                                                                               |

Preduvjet za neprenesene slučajeve: politika stranica u WEB repou (`packages/app/src/host/`). Je li ondje ekvivalent i test, nije provjereno u ovom zadatku (oblak u SRV traci ne mijenja WEB).
