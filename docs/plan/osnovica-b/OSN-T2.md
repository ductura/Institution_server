# OSN-T2 osnovica-testovi-dokazi-rute

Zapisnik osnovice (ductura/.github#56, kategorija B, kritično): sedam testova s
grane `origin/migracija/kopija-ductus-testovi-server` kojih nema u bazi
`origin/migracija/kopija-ductus-backend` pod istim imenom. Provjereno na bazi
`7eb72bf`. Za svaki test nađen je kod koji testira i ekvivalent u drugom
rasporedu (Ductus `next/server` i `POST` iz `app/api` zamijenjeni su
`server/http`, SQL iz rute je u `server/database`). Kod se nije mijenjao, a
testovi se nisu brisali ni slabili. Provjera naslova i tvrdnji je ručna usporedba
izvornika i ekvivalenta, ne strojna.

| Ductusov test                                           | Ekvivalent ovdje                                                                                                                                                                                                                                                                                                             | Ishod                                                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `server/evidence/commit-envelope.fuzz.property.test.ts` | `server/http/evidence-commit-envelope-fuzz.property.test.ts` (`parseCommitEnvelope` u `server/http/evidence-commit.ts`)                                                                                                                                                                                                      | nije preneseno: već postoji; svi naslovi izvornika postoje, uz jedan dodatni slučaj                                            |
| `server/evidence/commit-route.test.ts`                  | `server/http/evidence-commit.test.ts` (zatvoreno preslikavanje 4.13 t. 4, granica D-96), `evidence-commit.integration.test.ts` (svi vektori, sesija prije tijela, granica, zatvorena omotnica, ishodi servisa, zastavica protokola 2), `evidence-request*.test.ts` (zaštite prije tijela), `server/evidence/service.test.ts` | nije preneseno: već postoji ekvivalent u drugom rasporedu; vidi napomenu o razlikama niže                                      |
| `server/evidence/ingest-deps.test.ts`                   | `server/http/evidence-deps.test.ts` („one per process”, `server.ts` ih pravi jednom)                                                                                                                                                                                                                                         | nije preneseno: već postoji                                                                                                    |
| `server/evidence/open-route.test.ts`                    | `server/http/evidence-open.integration.test.ts` (uključujući odjeljak „Ductus open-route: the route over the real opener”) i `server/database/open-work.ts` testovi                                                                                                                                                          | nije preneseno: već postoji; test već navodi izvornik                                                                          |
| `server/evidence/receipt-signer.test.ts`                | `server/http/evidence-deps.test.ts` („the signer”: isti NODE_ENV redovi, T5 i T9)                                                                                                                                                                                                                                            | nije preneseno: već postoji, isti redovi (undefined, "", "staging", "Development", "test ")                                    |
| `server/evidence/replay-route.test.ts`                  | `server/http/evidence-replay.integration.test.ts` (A, B, C, E i svi vektori; DAN-537 glave), `server/evidence/replay.test.ts` i `tests/db/ductus/replay-route.integration.test.ts` (`record_changed`, 404 umjesto 409)                                                                                                       | nije preneseno: već postoji                                                                                                    |
| `tests/unit/problem-report-routes.test.ts`              | `tests/db/problem-report-migration.test.ts` (migracija i domena), `tests/contracts/problem-report-domain.test.ts`, `server/domain/support/problem-report.test.ts` (rubovi granica, „maps back to itself”)                                                                                                                    | nije preneseno: već postoji; provjere stranica `app/` nije preneseno: ovaj repo nema stranica (već zapisano u zaglavlju testa) |

## Razlike koje treba pogledati review (nisu rupe u pokrivenosti)

- `commit-route`, zapisnik (#155 t. 31): Ductusova ruta primala je `log(...)` s
  ishodom, fazom i kodom. Ovdje ruta ne prima zapisnik, nego `reportServerError`,
  a test „a throw is 503 repository; the record has the class only” provjerava da
  poruka ni token ne dospijevaju u zapis. Test s „kanarincem” kroz sve četiri
  omotnice (documentId, clientTransactionId, dokument, segment) u ovom obliku ne
  postoji; nije preneseno: razlog je različita arhitektura zapisa, a pisanje
  novog testa bez zadatka bio bi pisanje iz nule.
- `commit-route`, 202 pod protokolom 2: odgovor 202 s `Retry-After: 2`
  provjeravaju vektori (`server/contracts/evidence.test.ts`) i
  `evidence-commit.integration.test.ts` (E8). Redovi „pending reda koji nije
  potvrda ovog zahtjeva je 503” i potpisivanje u retku bez zastavice nisu
  jedan na jedan: u ovom rasporedu to je odluka servisa/baze
  (`server/evidence/service.test.ts`, `server/database/commit-evidence.test.ts`).
  Nije preneseno: nema istovjetnog HTTP-razine testa, a kod se bez zadatka ne
  piše iz nule.
- `commit-route`, matrica 12 vrijednosti `Ductus-Protocol` × zastavica: ovdje
  `evidence-deps.test.ts` pokriva 16 vrijednosti zastavice, a
  `evidence-commit.integration.test.ts` (E8) protokol 1 i 2; zaglavlje s
  razmacima i popisom („1, 2”, „2,1”) nema zasebnih redaka. Nije preneseno: isti
  razlog.

## Provjera

`pnpm exec vitest run --project unit` nad 7 datoteka ekvivalenata i
`pnpm exec vitest run` nad četiri `server/http/*.integration.test.ts`: svi
prolaze (248 + 231 testova). Baza (PGlite/Postgres `database` i `integration-pg`
projekti) i Docker nisu pokrenuti.
