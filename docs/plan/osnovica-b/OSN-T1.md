# OSN-T1: testovi prijave s grane `migracija/kopija-ductus-testovi-server`

Šest testova iz `tests/unit/auth/` na toj grani u bazi već postoje pod drugim imenom, uz `server/http/`. Usporedba po testu; nedostajući slučajevi preneseni su (OSN-T1).

| Stari test                    | Ekvivalent u bazi                             | Stanje                                                                 |
| ----------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `aai-flow.test.ts` (12)       | `server/http/auth-aai-flow.test.ts` (12)      | već prenesen                                                           |
| `flow-branches.test.ts` (17)  | `server/http/auth-flow-branches.test.ts` (19) | već prenesen                                                           |
| `flow.test.ts` (22)           | `server/http/auth-flow.test.ts` (19)          | tri odjavna slučaja pokrivena u `auth-flow-logout.test.ts`             |
| `flow-logout.test.ts` (12)    | `server/http/auth-flow-logout.test.ts`        | preneseno: B1/E2, B2, B4, C1, C4, C6/E1, DAN-99, #18                   |
| `flow-logout-all.test.ts` (6) | `server/http/auth-flow-logout-all.test.ts`    | preneseno: slučaj 7, slučaj 2                                          |
| `routes.test.ts` (3)          | `server/http/auth-routes.test.ts`             | preneseno uz prilagodbu: popis ruta iz ugovora umjesto obilaska `app/` |

- Slučaj 5 / D2 (samo POST): pokriva `auth-logout(-all).integration.test.ts` (405).
- Test 503 stranice za lažnog pružatelja u produkcijskoj gradnji i 503/405 povratne odjave: nije preneseno kao zaseban test, jer ga već pokrivaju `auth.integration.test.ts` i `auth-backchannel.integration.test.ts`.
