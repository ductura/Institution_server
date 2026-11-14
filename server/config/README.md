# server/config

Provjera okoline pri pokretanju (karta: [docs/server-map.md](../../docs/server-map.md)). `environmentProblems(env)` vraća probleme okoline samo imenom varijable, nikad vrijednošću; prazan popis znači da se proces smije pokrenuti. Jedina obvezna varijabla je `APP_DATABASE_URL`, prijava web procesa (`server/database`): mora biti `postgres:` ili `postgresql:` URL s hostom. Varijable prijave (`AUTH_DATABASE_URL`) namjerno se ne traže, pa se proizvodna gradnja s lažnim pružateljem i dalje pokreće i odbija prijavu (D-09).

- `environment.ts`: `environmentProblems`.
- `index.ts`: javno sučelje mape.

Preneseno iz Ductusa `src/server/env.ts` (`d52a92c3`, S-0.17, DAN-730) bez promjene logike; testovi u `environment.test.ts`. Dva slučaja Ductus `env.test.ts` provjeravaju `instrumentation.ts`, ulaznu točku Next.js-a, i dolaze s ulaznom točkom ovog repoa (S-1B-a).

Mapa ne uvozi ništa iz drugih područja.
