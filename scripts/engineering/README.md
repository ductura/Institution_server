# scripts/engineering

Alati razvojnog gatea. Pravila su u Ductus `docs/ENGINEERING_SYSTEM.md` §5 („Automatski risk floor”).

- `risk-floor.ts`: najniži `Risk` koji PR smije prijaviti prema putanjama koje mijenja (`minimumRisk`) i provjera redaka `Agent:`, `Risk:` i `Task:` u opisu PR-a (`evaluateMetadata`). Prijenos je Ductus `scripts/engineering/pr-metadata-core.mjs`.
- `floor.ts`: najniži `Risk` otvorenog PR-a iz njegovih datoteka (REST) i SHA heada za koji je izračunan, za workflow `.github/workflows/engineering-gate.yml`, koji oboje predaje zajedničkoj provjeri verdikata u `ductura/.github` (ulazi `minimum-risk` i `floor-sha`, S-0.10-b). Kod bilo koje greške ili heada koji se pomaknuo tijekom čitanja daje `critical`; nepoznat head daje prazan SHA, pa provjera ostaje `pending`. Testovi su u `floor.test.ts`.
- `index.ts`: javno sučelje mape.

Testovi su u `server/risk-floor.test.ts`. Svaka putanja s popisa `CRITICAL_PATHS` mora imati redak u `.github/CODEOWNERS`, a test to provjerava.

Mapa ne uvozi ništa iz `server/` ni iz `test-support/`. Cijela mapa ima floor `critical`.
