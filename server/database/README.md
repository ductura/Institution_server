# server/database

Područje baze (karta: [docs/server-map.md](../../docs/server-map.md)). Jedino mjesto koje uvozi upravljački program baze (`pg`), kao Ductus `src/server/db/`; ESLint (`no-restricted-imports` i `database-boundary/no-restricted-dynamic-imports`) to provjerava za ostatak repoa, osim testova baze u `tests/db/`. Jedino je mjesto i pretvorbe imena stupaca iz `snake_case` u `camelCase` (docs/CODE_STYLE.md, pravilo 9). Cijela mapa ima floor `critical`.

- `with-actor.ts`: `createWithActor(pool)`. Svaki poziv je jedna transakcija `READ COMMITTED` u kojoj `app.session_token` (lokalno za transakciju) nosi token sesije; identitet nikad nije parametar. Prijava mora biti obični član `ductus_app` (zaključavanje konfiguracije, F-018), dopuštene su samo naredbe nad podacima, ugniježđeni poziv se odbija, a veza se prije povratka u bazen čisti s `DISCARD ALL`.
- `current-actor.ts`: `createActorReader(withActor)`, port `ActorReader` kojim `server/session` čita osobu, ustanovu i oznaku ustanove iz `app.current_actor()`. Retke pretvara u camelCase (`userId`, `institutionId`, `institutionSlug`), jedno čitanje je jedna naredba u jednoj transakciji; `actorReader` je primjerak nad aplikacijskim `withActor`.
- `open-session.ts`, `backchannel-logout.ts`: otvaranje sesije pri prijavi i zatvaranje sesija iz back-channel odjave, preko prijave u `ductus_auth`.
- `log-settings.ts`: prije prve transakcije provjerava da baza ne zapisuje parametre naredbi (token sesije je parametar).
- `plain-label-check.ts`: jednokratna provjera prije migracije `institution_plain_label_marks` (samo čita, imenuje redak, nikad pohranjeno ime): `DATABASE_URL=… node server/database/plain-label-check.ts`.
- `migration-lock.ts`: `connectLockClient(url, options)`, veza na kojoj [scripts/db/migrate-locked.ts](../../scripts/db/migrate-locked.ts) drži zaključavanje migracija (`pg_advisory_lock`, D-91 (3)); S-0.13.
- `index.ts`: javno sučelje: `withActor` (bazen nad `APP_DATABASE_URL`), `openSession` i `backchannelLogout` (mali bazen nad `AUTH_DATABASE_URL`), granice bazena (`APP_*`, `appPoolConfig`, `handleConnectionErrors`), `closePools()` koji pri gašenju zatvara otvorene bazene (poslije toga svaki pristup bazi odbija, S-1B-c) i tvornice nad bazenom pozivatelja za testove.

Preneseno iz Ductusa `src/server/db/` (`d52a92c3`, S-0.13 i S-0.17, DAN-726 i DAN-730) bez promjene logike. Testovi uz kod: `with-actor.test.ts`, `log-settings.test.ts`, `plain-label-check.test.ts`, `current-actor.test.ts` i `session-guc-scope.test.ts` (nijedna postavka sesije ne nadživi transakciju); s bazom u `tests/db/` (`with-actor`, `open-session`, `app-database`, `plain-label-check`). `job-queue.ts` (red poslova na pg-bossu) dolazi s workerom i `attempt-fence` (S-M-\*, VS-1b).

Mapa ne uvozi ništa iz drugih područja.
