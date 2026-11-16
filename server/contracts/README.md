# server/contracts

Ugovor API-ja `/api/v1` (karta: [docs/server-map.md](../../docs/server-map.md)).

## Što radi

Sheme svih ruta u TypeBoxu: validacija ulaza, inventar ruta, OpenAPI (`openapi/v1.json`), vektori uspjeha i greške, provjera nekompatibilnih promjena i lažni server iz vektora.

## Tko ga zove

`roles`, `legal`, `backup`, `deletion`, `downloads` i `http`; klijenti preko generiranog paketa i lažnog servera.

## Koje podatke dira

Ništa; samo sheme.

## Što izvozi

`ROUTES` (sve rute s ugovorom), `INVENTORY`, `SERVER_SOURCES`, `CONTRACT_ONLY` i `checkInventory`, sheme iz `schema/`, `checkVectors`, `breakingChanges`, `API_VERSION`, `FALLBACK`, `INTERNAL` i `SHARED_ERRORS` i pomoćne funkcije za ID rada (`isWorkId`, `workIdFromPath`). Točan popis je u `index.ts`.

## Što ne smije uvoziti

Ništa iz drugih područja; od knjižnica samo `@sinclair/typebox` ([karta servera, §2](../../docs/server-map.md#2-dopušteni-uvozi)).

## Zajednička greška `internal` (DAN-776)

`INTERNAL` je odgovor bilo koje rute kad rukovatelj padne prije prvog bajta: 500 i tijelo problema `{"error":"internal","code":"internal","messageKey":"errors.internal","status":500,"requestId":"…"}` (S-1L.3, DAN-789). Osim `requestId`, koji server sam napravi, nikad ne nosi poruku, ime, stog ni drugi podatak iz servera. Nalazi se u `SHARED_ERRORS`. Generirani klijent ga prepoznaje na svakoj ruti, ali samo kad ga tijelo navodi. Lažni server ga vraća uz `x-ductura-fake-vector: internal` (vektor u `platform.health.get.json`). `TOO_MANY_REQUESTS` (`429 too_many_requests`, `errors.tooManyRequests`, zaglavlje `Retry-After`) je drugi dijeljeni odgovor: ograničenje broja zahtjeva prije svake rute (S-1C.3, DAN-814). Guard nekompatibilnih promjena ne dopušta novi status pod postojećom rutom ni novo polje u `info` (Ductus#1836 c.6896639138), pa `openapi/v1.json` dijeljene greške objavljuje u `info.description`, po redak za svaku sa statusom, kodom, ključem i zaglavljima (`SHARED_ERROR_HEADERS`); `openapi.test.ts` traži da su sve tamo. Poznata granica: pod rutama ih v1 ne navodi.

## Rute koje se rađaju na serveru i rute bez handlera (DAN-803)

- `SERVER_SOURCES` (`inventory.ts`) su rute kojima Ductus podatak daje izvan `route.ts`, npr. popis radova studenta (`src/components/student/my-assignments-read.ts`). Ključ je `route.ts` koji bi ruta imala, a `checkInventory` ih prihvaća kao datoteke inventara. `INVENTORY` ostaje kopija 38 Ductusovih datoteka.
- `CONTRACT_ONLY` je stanje „ugovoreno, nije implementirano”: ruta ima ugovor i vektore, a klijenti rade nad lažnim serverom. Popis smije samo padati. `tests/contracts/contract-only.test.ts` drži zamrznut popis 27 ruta DAN-803. Pada ako je na popisu ruta izvan tog popisa, ruta bez ugovora ili ruta montirana u nekom području, te ako ruta DAN-803 s ugovorom i bez handlera nije na popisu (Ductus#1836 c.6905207008, potvrda c.6905290513).
