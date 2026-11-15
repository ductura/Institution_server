# server/deletion

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

Brisanje po klasi podataka i roku čuvanja, uključujući verzije objekata. Feature područje: logika rute ili posla bit će u `service`.

## Tko ga zove

`http` i planirani posao. Planirani posao je pozadinski proces s vlastitim sastavljačem; dok ga nema, područje zove samo `http`.

## Koje podatke dira

Glavna baza (kroz RPC) i objekti u pohrani.

## Što izvozi

- `DELETION_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `DELETION_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `DeletionService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts`, `database`, `external/storage` i `external/email`, i to kroz njihov `index.ts`. `database`, `external/storage` i `external/email` uvozi samo s `import type` (tip porta); adapter mu predaje sastavljač (danas `http`). Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
