# server/roles

Područje iz [karte servera](../../docs/server-map.md). Mapa nema rute ni bazu. Ima pet vrsta računa i tablicu prava v2 kao podatak (S-1J.1-a); provjere uz bazu i rute dolaze u S-1J.1-b i S-1J-c.

## Što radi

Uloge u ustanovi. Studenta i nastavnika dodjeljuje samo administrator ustanove (c.6869502575). Feature područje: logika rute ili posla bit će u `service`.

Tablica prava (`permissions.ts`) je jedini izvor u kodu; ista tablica je u [docs/account-permissions.md](../../docs/account-permissions.md) i test ih uspoređuje. Opseg u ćeliji je gornja granica: sama uloga ne daje pristup sadržaju rada (C-23).

## Tko ga zove

Samo `http`.

## Koje podatke dira

Članstva i uloge u glavnoj bazi.

## Što izvozi

- `ROLES_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `ROLES_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `RolesService`: tip servisa bez članova (`service.ts`);
- `ACCOUNT_KINDS`, `AccountKind`, `LOGIN_ROWS`, `loginOf`, `isAccountKind`: pet vrsta računa i način prijave (`account-kinds.ts`);
- `ACTIONS`, `SCOPES`, `PERMISSION_ROWS` (retci tablice), `scopeOf` (jedini put do ćelije) i tipovi `PermissionRow`, `KindCells`, `CellFor`: tablica prava v2; `CONTENT_ACTIONS`, `OTHER_ACTIONS`, `DELETION_ACTIONS` (svaka radnja je u točno jednom popisu) i `CONTENT_SCOPES` za pravila C-23 i brisanja (`permissions.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts` i `database`, i to kroz njihov `index.ts`. `database` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
