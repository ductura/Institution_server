# server/profile

Područje iz [karte servera](../../docs/server-map.md) (DAN-851-1b). Servis jezika sučelja (DAN-851-1c2) prenosi odlučujući dio Ductus `src/server/profile/interface-locale-route.ts` na `51a062e`, od dekodiranja tijela do RPC-a, bez promjene logike. Nema `routes.ts`.

## Što radi

Postavke računa: jezik sučelja (S-M-1, prijenos Ductus `profile/interface-locale`). Feature područje: servis jezika sučelja je u `service.ts`, a ruta dolazi s DAN-851-1d u `server/http`, kao kod `evidence`. Servis portu predaje samo tijelo koje je valjan UTF-8 i kanonski JSON (`canonicalizeJcs`) s točno jednim valjanim `locale`; veličinu, rok i Content-Length tijela provjerava ruta. Pravila tijela su u domeni, [`server/domain/profile`](../domain/profile/README.md).

## Tko ga zove

Samo `http`.

## Koje podatke dira

`identity.user_preference` u glavnoj bazi, samo kroz RPC `identity.interface_locale()` i `identity.set_interface_locale()`. Tko je pozivatelj dolazi iz sesije, nikad iz tijela.

## Što izvozi

- `createProfileService({ store })` i tip `ProfileService` (`service.ts`): `readInterfaceLocale(token)` vraća ishod porta nepromijenjen; `saveInterfaceLocale(token, bytes)` vraća `Result<InterfaceLocale>` (docs/CODE_STYLE.md §8). Servis nikad ne baca na ulazu i ništa ne zapisuje.
- `INTERFACE_LOCALE_INVALID_JSON` (UTF-8 ili JSON ne prolazi) i `INTERFACE_LOCALE_INVALID_BODY` (tijelo nije kanonsko, `canonicalizeJcs` baca ili ga domena odbije), popisane u `PROFILE_ERRORS`; tekst je u `locales/hr.json` pod `interfaceLocale`. Ostale greške dolaze iz porta (`server/database`, `INTERFACE_LOCALE_*`) nepromijenjene.

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain` i `database`, i to kroz njihov `index.ts`. `database` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts`, `session` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
