# server/domain/sync

Osam stanja sinkronizacije koja korisnik vidi, iz Ductusa `src/domain/sync/states.ts` na `220b5db` (prijenos DAN-851-2a2): `SYNC_STATES` (zamrznut) i tip `SyncState`. Nema devetog stanja ni implicitnog „spremljeno”.

Prenesen je samo popis stanja, jer ga prijava problema ([`support`](../support/README.md)) koristi kao zatvorenu klasu. Reduktor stanja (prijelazi i događaji) ostaje u Ductusu dok se ne prenese u istu datoteku.

Ne uvozi ništa.
