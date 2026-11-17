# server/support

Područje iz [karte servera](../../docs/server-map.md) (DAN-851-2b). Zasad je prazan kostur: tip servisa bez članova, bez logike, porta i rute. Nema `routes.ts`.

## Što radi

Prijava problema iz aplikacije (S-M-2, prijenos Ductus `support/problem-report`). Feature područje: servis prijave problema dolazi s DAN-851-2c2, a ruta `POST /api/v1/support/problem-report` bit će u `server/http` (DAN-851-2d), kao kod `profile`. Pravila tijela su u domeni, [`server/domain/support`](../domain/support/README.md).

## Tko ga zove

Samo `http`.

## Koje podatke dira

`identity.problem_report` u glavnoj bazi, samo kroz RPC `identity.submit_problem_report()`. Zasad ništa: port baze dolazi s DAN-851-2c1.

## Što izvozi

Tip `SupportService` (`service.ts`), zasad bez članova.

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain` i `database`, i to kroz njihov `index.ts`. `database` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts`, `session` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
