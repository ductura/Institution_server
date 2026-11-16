# server/roles

Područje iz [karte servera](../../docs/server-map.md). Mapa nema rute ni bazu. Ima pet vrsta računa i tablicu prava v2 kao podatak (S-1J.1-a); vrste su u bazi od S-1J.1-b, a imenovanje i opoziv mrežnog inženjera u bazi od S-1J-c (`identity.appoint_network_engineer`, `identity.revoke_network_engineer`), a imenovanje admina od admina od S-1J-c2 (`institution.admin_appoint_admin`); rute dolaze kasnije.

## Što radi

Uloge u ustanovi. Studenta i nastavnika dodjeljuje samo administrator ustanove (c.6869502575). Feature područje: logika rute ili posla bit će u `service`.

Tablica prava (`permissions.ts`) je jedini izvor u kodu; ista tablica je u [docs/account-permissions.md](../../docs/account-permissions.md) i test ih uspoređuje. Opseg u ćeliji je gornja granica: sama uloga ne daje pristup sadržaju rada (C-23).

## Tko ga zove

Samo `http`.

## Koje podatke dira

Članstva i uloge u glavnoj bazi. Gdje je koja od pet vrsta računa piše u [docs/account-permissions.md](../../docs/account-permissions.md#vrste-računa-u-bazi); `server/roles/account-kinds-db.test.ts` provjerava da svaka vrsta ima redak u pgTAP matrici `db/main/tests/130-account-kinds.sql`, a `server/roles/account-kinds-matrix-db.test.ts` da matrica vrsta računa × radnja `db/main/tests/135-account-kinds-matrix.sql` ima redak za svaku vrstu i radnju, s ishodom u skladu s `scopeOf`.

## Što izvozi

- `ROLES_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `ROLES_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `RolesService`: tip servisa bez članova (`service.ts`);
- `ACCOUNT_KINDS`, `AccountKind`, `LOGIN_ROWS`, `loginOf`, `isAccountKind`: pet vrsta računa i način prijave (`account-kinds.ts`);
- `ACTIONS`, `SCOPES`, `PERMISSION_ROWS` (retci tablice), `scopeOf` (jedini put do ćelije) i tipovi `PermissionRow`, `KindCells`, `CellFor`: tablica prava v2; `CONTENT_ACTIONS`, `OTHER_ACTIONS`, `DELETION_ACTIONS` (svaka radnja je u točno jednom popisu) i `CONTENT_SCOPES` za pravila C-23 i brisanja (`permissions.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts` i `database`, i to kroz njihov `index.ts`. `database` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
