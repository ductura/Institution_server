# server/external/srce-auth

Područje iz [karte servera](../../../docs/server-map.md). OIDC klijent prema AAI@EduHr (Srce). Cijela mapa ima floor `critical`.

Preneseno iz Ductusa `src/server/auth` (`d52a92c3`, S-0.18, DAN-731) bez promjene logike; promijenjeni su samo uvozi i `interface` u `type` (pravilo 4 u [docs/CODE_STYLE.md](../../../docs/CODE_STYLE.md)). U S-1E-a (DAN-808) `LogoutTokenError` nosi `code` kao deklarirano polje umjesto parametra konstruktora, jer `server.ts` u testovima radi pod Nodeovim uklanjanjem tipova; ponašanje je isto.

## Što radi

- Studenti se prijavljuju isključivo kroz AAI@EduHr (D-09). Lažni OIDC pružatelj (`packages/test-fakes/oidc/`) smije se odabrati samo uz `NODE_ENV` `development` ili `test`; svaka druga vrijednost, i nepostavljena, znači produkciju i `loadAuthConfig` baca grešku.
- Jedina iznimka je staging (STG-PRIJAVA, odluka vlasnika 23. 11. 2026., Ductus#2055): produkcijska gradnja prihvaća lažnog pružatelja samo uz `DUCTURA_DEPLOYMENT=staging` i `APP_ORIGIN` koji je goli https origin izvan produkcijske domene `ductura.org` (ni apex ni poddomena; `server/settings/deployment.ts`). Tada `OIDC_REDIRECT_URI` i adresa nakon odjave moraju biti na tom originu, a izdavatelj izvan produkcijske domene; ostala produkcijska pravila (https, javni host, bez nesigurnih zahtjeva) i dalje vrijede. Svaka druga kombinacija odbija se kao i prije. Za `aai-eduhr` se ništa ne mijenja. Testovi: `staging.test.ts`.
- `config.ts`: `loadAuthConfig`, `expectedOrigin`, `AuthConfigError` i `isNonProductionBuild`, koji od DAN-938-1 dolazi iz `server/settings` i ovdje se samo ponovno izvozi. Greške imenuju varijablu, nikad njezinu vrijednost.
- `oidc.ts`: `createOidcClient` (openid-client 6.8.8), provjere prijave (`state`, `nonce`, PKCE), ograničen `fetch`, `accountIssuer`, `isProviderUnavailable`.
- `claims.ts`: `identityFromClaims`, atributi `hrEdu*` u identitet prijave.
- `logout-token.ts`, `logout-keys.ts`: provjera tokena odjave (Back-Channel Logout 1.0) i spremište ključeva pružatelja.
- `logout-verifier.ts`: `createLogoutVerifier`, port provjere tokena odjave koji sastavljač predaje ruti u `session` (`docs/server-map.md` §2); vraća rezultat (`invalid` ili `unavailable`) umjesto bacanja.

Testovi su uz kod; ispitni pružatelj u memoriji je u [test-support/test-idp](../../../test-support/test-idp/index.ts).

## Tko ga zove

`http`: tok prijave `server/http/auth-flow.ts` i sastavljač ruta prijave `server/http/auth.ts` (S-1E-a, DAN-808), koji stvara klijent na prvom zahtjevu prijave. `session` uvozi samo tipove. Odjava dolazi u S-1D-d.

## Koje podatke dira

Ništa trajno. Tokeni i atributi pružatelja postoje samo tijekom prijave; u zapisima su samo faza i kod greške.

## Što izvozi

`index.ts` je javno sučelje: funkcije i tipovi iz `config.ts`, `oidc.ts`, `claims.ts`, `logout-token.ts`, `logout-keys.ts` i `logout-verifier.ts` navedeni gore.

## Što ne smije uvoziti

Uvozi samo `openid-client` i `node:`; prema [karti servera, §2](../../../docs/server-map.md#2-dopušteni-uvozi) smije još `settings`, `log` i `metrics`. Ne uvozi druge adaptere iz `external/` ni feature područja.
