# server/contracts

Ugovor API-ja `/api/v1` (karta: [docs/server-map.md](../../docs/server-map.md)).

## Što radi

Sheme svih ruta u TypeBoxu: validacija ulaza, inventar ruta, OpenAPI (`openapi/v1.json`), vektori uspjeha i greške, provjera nekompatibilnih promjena i lažni server iz vektora.

## Tko ga zove

`roles`, `legal`, `backup`, `deletion`, `downloads` i `http`; klijenti preko generiranog paketa i lažnog servera.

## Koje podatke dira

Ništa; samo sheme.

## Što izvozi

`ROUTES` (sve rute s ugovorom), `INVENTORY` i `checkInventory`, sheme iz `schema/`, `checkVectors`, `breakingChanges`, `API_VERSION`, `FALLBACK` i pomoćne funkcije za ID rada (`isWorkId`, `workIdFromPath`). Točan popis je u `index.ts`.

## Što ne smije uvoziti

Ništa iz drugih područja; od knjižnica samo `@sinclair/typebox` ([karta servera, §2](../../docs/server-map.md#2-dopušteni-uvozi)).
