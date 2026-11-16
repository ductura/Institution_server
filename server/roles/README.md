# server/roles

Područje iz [karte servera](../../docs/server-map.md). Mapa nema rutu; do baze dolazi samo kroz port koji joj predaje `http`. Ima pet vrsta računa i tablicu prava v2 kao podatak (S-1J.1-a); vrste su u bazi od S-1J.1-b, a imenovanje i opoziv mrežnog inženjera u bazi od S-1J-c (`identity.appoint_network_engineer`, `identity.revoke_network_engineer`), a imenovanje admina od admina od S-1J-c2 (`institution.admin_appoint_admin`); rute dolaze kasnije.

## Što radi

Uloge u ustanovi. Studenta i nastavnika dodjeljuje samo administrator ustanove (c.6869502575). Feature područje: logika rute ili posla bit će u `service`.

Servis pisanja postavki po razinama (`settings-write.ts`, S-1J-g, DAN-826-1a; D-297, D-298): tijelo `settings.values.put` provjerava shemom ugovora i katalogom postavki (`server/domain/settings`) prije baze. Tijelo pogrešnog oblika je `SETTING_INVALID_BODY`, kolegij izvan razine `course` (ili razina `course` bez njega) `SETTING_COURSE_MISMATCH`, a ostalo su kodovi kataloga (`SETTING_UNKNOWN_KEY`, `SETTING_LEVEL_NOT_ALLOWED`, `SETTING_INVALID_VALUE`, `SETTING_INVALID_BOUND`); svi uz `errors.invalidInput`. Odbijeno pisanje nikad ne zove port. Tko smije pisati koju razinu i granice viših razina odlučuje baza (`settings.set_value`).

Tablica prava (`permissions.ts`) je jedini izvor u kodu; ista tablica je u [docs/account-permissions.md](../../docs/account-permissions.md) i test ih uspoređuje. Opseg u ćeliji je gornja granica: sama uloga ne daje pristup sadržaju rada (C-23).

## Tko ga zove

Samo `http`.

## Koje podatke dira

Članstva i uloge u glavnoj bazi; postavke po razinama samo kroz port `SettingsWriter` (`settings.set_value`). Gdje je koja od pet vrsta računa piše u [docs/account-permissions.md](../../docs/account-permissions.md#vrste-računa-u-bazi); `server/roles/account-kinds-db.test.ts` provjerava da svaka vrsta ima redak u pgTAP matrici `db/main/tests/130-account-kinds.sql`.

## Što izvozi

- `ROLES_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `ROLES_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `RolesService`: tip servisa bez članova (`service.ts`);
- `createSettingsService`, `SettingsService`: servis pisanja postavki nad portom `SettingsWriter` iz `database` (`settings-write.ts`);
- `ACCOUNT_KINDS`, `AccountKind`, `LOGIN_ROWS`, `loginOf`, `isAccountKind`: pet vrsta računa i način prijave (`account-kinds.ts`);
- `ACTIONS`, `SCOPES`, `PERMISSION_ROWS` (retci tablice), `scopeOf` (jedini put do ćelije) i tipovi `PermissionRow`, `KindCells`, `CellFor`: tablica prava v2; `CONTENT_ACTIONS`, `OTHER_ACTIONS`, `DELETION_ACTIONS` (svaka radnja je u točno jednom popisu) i `CONTENT_SCOPES` za pravila C-23 i brisanja (`permissions.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts` i `database`, i to kroz njihov `index.ts`. `database` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
