# server/database

Područje baze (karta: [docs/server-map.md](../../docs/server-map.md)). Jedino mjesto koje uvozi upravljački program baze (`pg`), kao Ductus `src/server/db/`. Cijela mapa ima floor `critical`.

Zasad sadrži samo:

- `migration-lock.ts`: `connectLockClient(url, options)`, veza na kojoj [scripts/db/migrate-locked.ts](../../scripts/db/migrate-locked.ts) drži zaključavanje migracija (`pg_advisory_lock`, D-91 (3)). Ponovno pokušava dok se poslužitelj pokreće, svaki pokušaj ima rok, a prekid (`AbortSignal`) zaustavlja i pokušaj na koji poslužitelj nikad ne odgovori. Prenesen iz Ductusa `src/server/db/migration-lock.ts` (`d52a92c3`, S-0.13, DAN-726) bez promjene logike.
- `index.ts`: javno sučelje mape.

Testovi su u `scripts/db/migrate-locked.test.ts` (s tihim TCP poslužiteljem, bez baze). `withActor`, `openSession` i ostatak sloja baze donosi S-0.17.

Mapa ne uvozi ništa iz drugih područja.
