# OSN-B3 osnovica-testovi-privatnost

Zapisnik osnovice faze 1 (ductura/.github#56), kategorija B: Ductusov test proizvodnog koda nema kopiju u Ducturi. Postupak: za svaki test tražen ekvivalent u ovom repou; bez ekvivalenta kod se ne piše iz nule.

Provjera na `origin/migracija/kopija-ductus-backend`: u repou nema `docs/privacy/06-klase-podataka.md` ni `docs/contracts/export-recipient-v1.md`; `docs/privacy/08-inventar-tokova-podataka.md` postoji, ali je preslika Ductusova dokumenta i navodi Ductusove putanje (`app/api/**`, `src/server/**`, `src/domain/**`, `db/migrations/`) kojih ovdje nema; migracije su u `db/main/migrations/`. Katalog `server/domain/retention/catalog.ts` samo upućuje na Ductusov dokument 06, ne zamjenjuje ga.

| Ductusov test                                          | Rezultat                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/privacy/data-class-inventory.test.ts`      | nije preneseno: test čita `docs/privacy/06-klase-podataka.md` (popis od 31 klase) i svaku tablicu iz migracija; dokumenta 06 u ovom repou nema, pa nema što provjeravati, a pisanje dokumenta iz nule nije dopušteno ni u putanjama zadatka                      |
| `src/domain/privacy/data-flow-inventory.test.ts`       | nije preneseno: dokument 08 postoji, ali cilja Ductusove putanje i API rute (`app/api/**/route.ts`) koje ovdje ne postoje, a traži i dokument 06; prilagodba bi značila prepisivanje inventara ili slabljenje tvrdnji (da putanje postoje), što nalog zabranjuje |
| `src/domain/privacy/export-recipient-contract.test.ts` | nije preneseno: ugovor `docs/contracts/export-recipient-v1.md` ne postoji u ovom repou (u `docs/contracts/` su samo declaration, document-schema i provenance-share), a test traži i dokument 06                                                                 |

Preduvjet za sva tri: dokumenti 06 i export-recipient-v1 te inventar 08 prilagođen putanjama `server/…` i `db/main/…`. To je zaseban zadatak (docs izvan trake `server/domain/privacy/`).
