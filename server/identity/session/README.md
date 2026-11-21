# server/identity/session

Istek neaktivne sesije (SRV-1401, DAN-296, plan M1.6), dio područja [`identity`](../README.md) iz [karte servera](../../../docs/server-map.md).

## Što radi

`idle.ts`: `createIdleTracker` i `idleLimitMinutes`. Opis pravila (prag ustanove, zadano 30 minuta, monotoni sat, ključ kao hash tokena, granica od dva sata u bazi) je u README-u područja.

## Tko ga zove

`http` kroz `server/identity/index.ts` (`server/http/security/`, `guardIdleSessions`).

## Koje podatke dira

Ništa trajno; samo memorija procesa.

## Što izvozi

`index.ts`, isti popis kao `server/identity/index.ts`.

## Što ne smije uvoziti

Kao područje `identity`: samo `domain` i `node:`.
