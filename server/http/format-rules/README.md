# HTTP za pravila oblika (SRV-V17-FORMAT-RULES)

`createFormatRulesRoutesFor` montira jednu rutu; pravila se slažu iz postojećih čitanja, ništa se ne sprema (bez nove tablice i migracije).

- `GET /api/v1/student/assignments/{assignmentId}/format-rules`: `{wordMin, wordMax, minSources, requiredSections, citationStyle, font, size, spacing}`.
  - `wordMin`/`wordMax`: raspon riječi trenutačne verzije zadatka (`null` = otvoren kraj), iz čitača zahtjeva (SRV-22).
  - `requiredSections` i `citationStyle`: kostur zamrznut na zadatku (SRV-V17-TEMPLATE-ASSIGN); bez predloška `[]` i `fpzg`.
  - `minSources` je 0 (zadatak nema to polje); `font`, `size`, `spacing` su `null` dok paket Lekte nije dostupan (Q-11).
  - Tuđi zadatak, mentorski, nepoznat i neispravan id su isti 404 (C-23); upit je 422.

Test: `format-rules.integration.test.ts`.
