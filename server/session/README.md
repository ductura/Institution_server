# server/session

Sesija nakon prijave AAI@EduHr, karta: [docs/server-map.md](../../docs/server-map.md). Cijela mapa ima floor `critical`.

Preneseno iz Ductusa `src/server/auth` (`d52a92c3`, S-0.18, DAN-731) bez promjene logike; promijenjeni su samo uvozi, `interface` u `type` i ono što je vezalo kod uz Next.js:

- `session-token.ts`: token sesije (32 nasumična bajta), njegov SHA-256 i opcije kolačića `__Host-`.
- `principal.ts`: `sessionPrincipal`, `sessionTag`, `principalScope`; identitet uvijek iz baze (`app.current_actor()`), nikad iz zahtjeva.
- `ended-mark.ts`: `liveSessionToken`, kolačić sesije koju je ovaj preglednik završio ne vrijedi.
- `return-to.ts`: `safeReturnTo`, povratna putanja uvijek ostaje na ovom originu.
- `activity.ts`: `recordActivity`, `pageActivity`, `counted`. U Ductusu su zadane vrijednosti bile Next `after()` i `withActor` iz `src/server/db`; ovdje ih predaje pozivatelj (sastavljač u S-1E-a), pa mapa ne uvozi `next/*` ni adapter baze.
- `backchannel.ts`: `backchannelLogout`, obrada tokena odjave koji šalje pružatelj (DAN-474).
- `login-cookie.ts` (S-1E-a, DAN-808): `previousSessionToken` i `sessionSetCookie`, kolačić sesije pri prijavi; tok prijave u `server/http` ga ne imenuje sam (`ended-mark-coverage.test.ts`).
- `cookie.ts`: `sessionTokenFromCookie`, token sesije iz zaglavlja `Cookie` (Node, bez Next.js; DAN-805). Točno jedan par `__Host-ductus_session` s točno 43 znaka base64url; vrijednost se ne dekodira ni ne skraćuje, a dva kolačića sesije ne daju token (podmetanje kolačića). Oznake odjave ne čita.
- `live-session.ts`: `checkSession`, sesijski korak ruta evidencije (DAN-805): oblik tokena i, s `live`, živa sesija kroz `sessionPrincipal`; ishod je prolaz, `unauthenticated` ili `context` (baza nije odgovorila).
- `state.ts` (S-1D-a, DAN-827): stanja sesije `in_progress`, `active`, `interrupted` i `ended` (`SESSION_STATES`) i zatvoreni popisi razloga (`INTERRUPTED_REASONS`, `ENDED_REASONS`). Stanje izvodi baza, `identity.session_state(uuid)` iz postojećih stupaca `identity.session` (migracija `20261116180000_session_state.sql`, pgTAP `db/main/tests/135-session-state.sql`): odlučuje najraniji od `closed_at`, `expires_at` i `last_seen_at` + 2 h. Istek mirovanja i promjena ustanove daju `interrupted` s razlogom. Čitaju samo administrator i imenovani mrežni inženjer ustanove sesije. `in_progress` (prijava započeta, sesija još nije izdana) je definiran, ali se ne izvodi: stanje prijave je u kolačiću, a redak sesije postoji tek nakon izdavanja. `parseSessionState` čita redak funkcije; sve izvan popisa je `SESSION_STATE_INVALID` (`errors.internal`).
- `index.ts`: javno sučelje mape; tipove portova `WithActor`, `ActorTransaction` i `BackchannelLogout` prosljeđuje kao `import type` iz `server/database/index.ts`.

Mapa uvozi `external/srce-auth` (kroz njegov `index.ts`) i `node:`; prema karti smije još `settings`, `log`, `metrics`, `domain` i `database` (samo tipovi portova). Ne stvara adaptere.
