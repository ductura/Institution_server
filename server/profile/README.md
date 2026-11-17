# server/profile

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (DAN-851-1b): ima samo tip servisa, bez logike i bez `routes.ts`.

## Što radi

Postavke računa: jezik sučelja (S-M-1, prijenos Ductus `profile/interface-locale`). Feature područje: servis jezika sučelja nad portom baze dolazi s DAN-851-1c, a ruta s DAN-851-1d u `server/http`, kao kod `evidence`. Pravila tijela su u domeni, [`server/domain/profile`](../domain/profile/README.md).

## Tko ga zove

Samo `http`.

## Koje podatke dira

`identity.user_preference` u glavnoj bazi, samo kroz RPC `identity.interface_locale()` i `identity.set_interface_locale()`. Tko je pozivatelj dolazi iz sesije, nikad iz tijela.

## Što izvozi

- `ProfileService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain` i `database`, i to kroz njihov `index.ts`. `database` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts`, `session` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
