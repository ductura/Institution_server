# scripts/engineering

Alati razvojnog gatea. Pravila su u Ductus `docs/ENGINEERING_SYSTEM.md` §5 („Automatski risk floor”).

- `risk-floor.ts`: najniži `Risk` koji PR smije prijaviti prema putanjama koje mijenja (`minimumRisk`) i provjera redaka `Agent:`, `Risk:` i `Task:` u opisu PR-a (`evaluateMetadata`). Prijenos je Ductus `scripts/engineering/pr-metadata-core.mjs`.
- `floor.ts`: najniži `Risk` otvorenog PR-a iz njegovih datoteka i SHA heada za koji je izračunan. Datoteke čita iz usporedbe nepromjenjivih SHA-ova baze i heada (REST `compare/{base}...{head}`), ne iz promjenjivog popisa PR-a, za workflow `.github/workflows/engineering-gate.yml`, koji oboje predaje zajedničkoj provjeri verdikata u `ductura/.github` (ulazi `minimum-risk` i `floor-sha`, S-0.10-b). Kod bilo koje greške, PR-a koji nije u zadanu granu, popisa koji je možda odrezan (300 ili više datoteka, ili broj različit od `changed_files`) te baze ili heada koji se pomaknuo tijekom čitanja daje `critical`; nepoznat head daje prazan SHA, pa provjera ostaje `pending`. Testovi su u `floor.test.ts`.
- `bot-labels.ts`: čitanje `.github/labels.yml`, zapisa labela repoa (`parseLabels`: popis zapisa s imenom, bojom i opisom, bez drugih i naslijeđenih ključeva; BOM, direktive, eksplicitne oznake, aliasi, merge ključevi i drugi dokument su nevaljan YAML) (S-0.11, DAN-724-1a-i). Testovi su u `bot-labels.test.ts`.
- `index.ts`: javno sučelje mape.

Testovi za `risk-floor.ts` su u `server/risk-floor.test.ts`. Svaka putanja s popisa `CRITICAL_PATHS` mora imati redak u `.github/CODEOWNERS`, a test to provjerava.

Mapa ne uvozi ništa iz `server/` ni iz `test-support/`. Cijela mapa ima floor `critical`.
