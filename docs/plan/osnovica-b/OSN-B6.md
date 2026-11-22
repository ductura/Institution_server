# OSN-B6 osnovica-testovi-ostalo

Zapisnik osnovice faze 1, kategorija B (ductura/.github#56): Ductusov test proizvodnog koda nema kopiju u Ducturi.

- `src/domain/institution-config/no-default-institution.test.ts`: nije preneseno: u ovom repou nema `registry.ts` kao jedinog čitatelja konfiguracije ustanova (čitaju je `server/database/institution-config/loader.ts`, `server/settings/institutions-file.ts`, `server/server.ts` i asistentske datoteke), a proizvodni kod izričito imenuje slug `"fpzg"` (npr. `CITATION_STYLES` u `server/database/institution-config/schema.ts`, `server/domain/settings/catalogue.ts`, ugovori). Test bi pao zbog drukčije arhitekture, ne zbog greške koda; prijenos bi tražio novu arhitekturnu odluku, a zadatak zabranjuje pisanje iz nule.
- `src/domain/rules/package.property.test.ts`: nije preneseno: ne postoji `server/domain/rules/` ni `parseRulePackage`/`RULE_PACKAGE_FORMAT`. Najbliže je `server/domain/settings/text-check-rules.ts` (izbor provjera teksta), koji ne parsira paket pravila; u njegovu zaglavlju stoji da je sadržaj paketa pravila službeni paket vlasnika koji još ne postoji.
