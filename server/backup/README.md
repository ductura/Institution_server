# server/backup

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

Kopije baze i pohrane te mjesečna proba povrata (ARCHITECTURE §9). Feature područje: logika rute ili posla bit će u `service`.

## Tko ga zove

`http` (status za administratora) i planirani posao. Planirani posao je pozadinski proces s vlastitim sastavljačem; dok ga nema, područje zove samo `http`.

## Koje podatke dira

Kopije glavne baze i replika bucketa.

## Što izvozi

- `BACKUP_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `BACKUP_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `BackupService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts`, `database`, `external/storage` i `external/keys`, i to kroz njihov `index.ts`. `database`, `external/storage` i `external/keys` uvozi samo s `import type` (tip porta); adapter mu predaje sastavljač (danas `http`). Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
