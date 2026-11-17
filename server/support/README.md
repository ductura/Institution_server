# server/support

Područje iz [karte servera](../../docs/server-map.md) (DAN-851-2b). Servis prijave problema (DAN-851-2c2) prenosi odlučujući dio Ductus `handleProblemReport` (`src/server/support/problem-report-route.ts` na `81833ca`), od dekodiranja tijela do RPC-a, bez promjene logike. Nema `routes.ts`.

## Što radi

Prijava problema iz aplikacije (S-M-2, prijenos Ductus `support/problem-report`). Feature područje: servis je u `service.ts`, a ruta `POST /api/v1/support/problem-report` je u `server/http` (`support-problem-report.ts`, DAN-851-2d1) i montira je `server/server.ts` (DAN-851-2d2a), kao kod `profile`. Servis portu predaje samo tijelo koje je valjan UTF-8 i kanonski JSON (`canonicalizeJcs`) i koje prihvaća `parseProblemReport`, i to točno vrijednost parsera. Veličinu, rok, `Content-Type`, porijeklo i oblik tokena provjerava ruta. Pravila tijela su u domeni, [`server/domain/support`](../domain/support/README.md).

## Tko ga zove

Samo `http`.

## Koje podatke dira

`identity.problem_report` u glavnoj bazi, samo kroz RPC `identity.submit_problem_report()` (port `ProblemReportStore` iz `server/database`, DAN-851-2c1). Tko prijavljuje i za koju ustanovu dolazi iz sesije, nikad iz tijela.

## Što izvozi

- `createSupportService({ store })` i tip `SupportService` (`service.ts`): `submitProblemReport(token, bytes)` vraća `Result<string>` s referencom (docs/CODE_STYLE.md §8). Servis nikad ne baca na ulazu i ništa ne zapisuje.
- `PROBLEM_REPORT_INVALID_JSON` (UTF-8 ili JSON ne prolazi; Ductus 400 `invalid_json`) i `PROBLEM_REPORT_INVALID_BODY` (tijelo nije kanonsko, `canonicalizeJcs` baca ili ga domena odbije; Ductus 422 `invalid_input`), popisane u `SUPPORT_ERRORS`; tekst je u `locales/hr.json` pod `problemReport`. Ostale greške dolaze iz porta (`PROBLEM_REPORT_*`) nepromijenjene; ruta (2d1) i `PROBLEM_REPORT_INVALID` porta (ZD422) i `PROBLEM_REPORT_INVALID_BODY` šalje kao 422 `invalid_input`.

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain` i `database`, i to kroz njihov `index.ts`. `database` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts`, `session` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
