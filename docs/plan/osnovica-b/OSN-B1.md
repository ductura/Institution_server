# OSN-B1 osnovica-testovi-dokazi-predaja

Zapisnik osnovice faze 1 (ductura/.github#56, kategorija B): provjera ima li svaki
od tri Ductusova testa dokaza i predaje kopiju u ovom repou. Ductus baza: d52a92c3.
Svaki redak je jedan Ductusov test; svi su već preneseni, pa nije bilo koda za pisanje.

| Ductusov test                                                                                 | Ekvivalent ovdje                                                                                | Stanje                                                                                        |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/server/evidence/evidence-commit-request.test.ts` (8 testova)                             | `server/evidence/service.test.ts` (`createEvidenceService`, kôd u `server/evidence/service.ts`) | preneseno: svih 8 naslova postoji, 80 tvrdnji prema 48 u izvorniku; dodani v2/v3/v4 slučajevi |
| `src/application/evidence/replay-reader.test.ts` (18 testova)                                 | `server/evidence/replay.test.ts` (`readReplayPage`, kôd u `server/evidence/replay.ts`)          | preneseno: svi naslovi postoje, iste tvrdnje, 68 prema 60                                     |
| `src/application/ports/evidence-object-key.test.ts` (ključ)                                   | `server/domain/evidence/object-key.test.ts`                                                     | preneseno, uz provjere `isEvidencePackageId` i `isSha256Hex`                                  |
| `src/application/ports/evidence-object-key.test.ts` (memorijska pohrana, `bindPayloadReader`) | `server/external/storage/in-memory-evidence-payload-store.test.ts`                              | preneseno: sva tri testa (P5, B2)                                                             |

Provjera: `pnpm exec vitest run --project unit` nad četiri navedene datoteke,
4 datoteke, 115 testova, svi prolaze. Tvrdnje nisu oslabljene i ništa nije
preskočeno ni obrisano. Kôd i testovi izvan ovog zapisnika nisu mijenjani.
