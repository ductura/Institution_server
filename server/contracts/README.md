# server/contracts

Ugovor API-ja `/api/v1` (karta: [docs/server-map.md](../../docs/server-map.md)).

## Što radi

Sheme svih ruta u TypeBoxu: validacija ulaza, inventar ruta, OpenAPI (`openapi/v1.json`), vektori uspjeha i greške, provjera nekompatibilnih promjena i lažni server iz vektora.

## Tko ga zove

`roles`, `legal`, `backup`, `deletion`, `downloads` i `http`; klijenti preko generiranog paketa i lažnog servera.

## Koje podatke dira

Ništa; samo sheme.

## Što izvozi

`ROUTES` (sve rute s ugovorom), `INVENTORY` i `checkInventory`, sheme iz `schema/`, `checkVectors`, `breakingChanges`, `API_VERSION`, `FALLBACK`, `INTERNAL` i `SHARED_ERRORS` i pomoćne funkcije za ID rada (`isWorkId`, `workIdFromPath`). Točan popis je u `index.ts`.

## Što ne smije uvoziti

Ništa iz drugih područja; od knjižnica samo `@sinclair/typebox` ([karta servera, §2](../../docs/server-map.md#2-dopušteni-uvozi)).

## Zajednička greška `internal` (DAN-776)

`INTERNAL` je odgovor bilo koje rute kad rukovatelj padne prije prvog bajta: 500 i tijelo problema `{"error":"internal","code":"internal","messageKey":"errors.internal","status":500,"requestId":"…"}` (S-1L.3, DAN-789). Osim `requestId`, koji server sam napravi, nikad ne nosi poruku, ime, stog ni drugi podatak iz servera. Nalazi se u `SHARED_ERRORS`. Generirani klijent ga prepoznaje na svakoj ruti, ali samo kad ga tijelo navodi. Lažni server ga vraća uz `x-ductura-fake-vector: internal` (vektor u `platform.health.get.json`). Poznata granica: `internal` nije u `openapi/v1.json` dok guard nekompatibilnih promjena ne dopusti novi zajednički odgovor (Ductus#1836 c.6896639138).
