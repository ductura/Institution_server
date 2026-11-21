# server/identity

Područje iz [karte servera](../../docs/server-map.md) (SRV-1401, DAN-296, plan M1.6). Za sada ima samo mapu `session/`: istek neaktivne sesije.

## Što radi

`session/` (`idle.ts`): `createIdleTracker({ now?, minutesFor?, capacity? })` pamti zadnji prihvaćeni zahtjev svake sesije i kaže je li sesija neaktivna dulje od praga ustanove. Prag je cijeli broj minuta od 15 do 120 (granice postavke `network.session_idle_minutes`, D-298), a bez postavke, uz grešku čitanja ili vrijednost izvan granica vrijedi 30 minuta (`DEFAULT_SESSION_IDLE_MINUTES`). Točno prag je već istek, kao u bazi. Istekla sesija ostaje istekla: novi zahtjev ni veći prag je ne oživljavaju. Sesija koju tracker još nije vidio je aktivna, a njezino mirovanje počinje prvim prihvaćenim zahtjevom.

Ključ je SHA-256 tokena (base64url), nikad sam token. Sat je monotoni (`performance.now()`), pa sat sustava vraćen unatrag ne oživljava sesiju. Zapisi su u memoriji jednog web procesa, kao izazovi WebAuthna ([karta](../../docs/server-map.md)). Zapis neaktivan dva sata uvijek ispada, jer tada sesiju odbija i baza (`app.current_actor()`); preko `IDLE_TRACKER_CAPACITY` (100 000) prvi ispadaju najdulje neaktivni.

Baza i dalje drži vlastitu gornju granicu od dva sata (migracija `20261101200000_session_idle.sql`); tracker sesiju samo skraćuje. Odgovor 401 `session_idle_expired` daje `server/http/security/` (`guardIdleSessions`).

## Tko ga zove

Samo `http`.

## Koje podatke dira

Ništa trajno: hash tokena i vrijeme zadnjeg zahtjeva u memoriji procesa.

## Što izvozi

`index.ts`: `createIdleTracker`, `idleLimitMinutes`, `DEFAULT_SESSION_IDLE_MINUTES`, `SESSION_IDLE_MIN_MINUTES`, `SESSION_IDLE_MAX_MINUTES`, `IDLE_TRACKER_CAPACITY` i tipove `IdleTracker`, `IdleMinutesFor`, `IdleVerdict`.

## Što ne smije uvoziti

Smije uvoziti samo `domain` (kroz njegov `index.ts`) i `node:`. Ne uvozi `http`, `session`, `database` ni `test-server`. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
