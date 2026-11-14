# server/log

Područje zapisa (karta: [docs/server-map.md](../../docs/server-map.md)). Jedan strukturirani zapis web procesa i workera: svaki poziv piše točno jedan JSON redak `{ time, level, event, fields }`, a svaki dio retka prije toga prolazi kroz `redact`. Zapis nikad ne baca grešku pozivatelju.

- `redact.ts`: `redact(value)` uklanja tajne, tokene, osobne podatke i sadržaj radova iz vrijednosti bilo kojeg oblika (ključevi, tekst, URL-ovi, greške); `redactString`, `stripUrl`, `isSensitiveKey`.
- `logger.ts`: `createLogger(sink, now)`, `logEvent`, `codesLog` i `consoleSink` (stderr za upozorenja i greške, stdout za ostalo).
- `invented.fixture.ts`: izmišljene vrijednosti za testove (kanarinac `kanarinac`, domene `.test`), nikad stvarni podaci.
- `index.ts`: javno sučelje mape.

Preneseno iz Ductusa `src/server/log/` (`d52a92c3`, S-0.17, DAN-730) bez promjene logike. Testovi: `redact.test.ts`, `canary.test.ts` i `redact.property.test.ts` (Ductus `tests/property/log-redact.property.test.ts`). Tri slučaja Ductus `canary.test.ts` čekaju kod kroz koji pišu: dokaze (`server/evidence`, S-M-\*) i ulaznu točku (S-1B-a); popis je u komentaru testa.

Mapa ne uvozi ništa iz drugih područja.
