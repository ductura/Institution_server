# server/external/srce-auth

OIDC klijent prema AAI@EduHr (Srce), karta: [docs/server-map.md](../../../docs/server-map.md). Studenti se prijavljuju isključivo kroz AAI@EduHr (D-09); lažni OIDC pružatelj (`packages/test-fakes/oidc/`) smije se odabrati samo uz `NODE_ENV` `development` ili `test`, a svaka druga vrijednost (i nepostavljena) znači produkciju i `loadAuthConfig` baca grešku. Cijela mapa ima floor `critical`.

Preneseno iz Ductusa `src/server/auth` (`d52a92c3`, S-0.18, DAN-731) bez promjene logike; promijenjeni su samo uvozi i `interface` u `type` (pravilo 4 u [docs/CODE_STYLE.md](../../../docs/CODE_STYLE.md)).

- `config.ts`: `loadAuthConfig`, `expectedOrigin`, `isNonProductionBuild`, `AuthConfigError`. Greške imenuju varijablu, nikad njezinu vrijednost.
- `oidc.ts`: `createOidcClient` (openid-client 6.8.8), provjere prijave (`state`, `nonce`, PKCE), ograničen `fetch`, `accountIssuer`, `isProviderUnavailable`.
- `claims.ts`: `identityFromClaims`, atributi `hrEdu*` u identitet prijave.
- `logout-token.ts`, `logout-keys.ts`: provjera tokena odjave (Back-Channel Logout 1.0) i spremište ključeva pružatelja.
- `logout-verifier.ts`: `createLogoutVerifier`, port provjere tokena odjave koji sastavljač predaje ruti u `session` (`docs/server-map.md` §2); vraća rezultat (`invalid` ili `unavailable`) umjesto bacanja.
- `index.ts`: javno sučelje mape.

Testovi su uz kod; ispitni pružatelj u memoriji je u [test-support/test-idp](../../../test-support/test-idp/index.ts). Mapa uvozi samo `openid-client` i `node:`; prema karti smije još `settings`, `log` i `metrics`. Tok prijave (`flow.ts`), sastavljač (`deps.ts`) i rute dolaze u S-1E-a i S-1D-d.
