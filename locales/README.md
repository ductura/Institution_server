# locales

Hrvatski tekstovi poruka. Kod vraća samo ključ (`messageKey`, `docs/CODE_STYLE.md` §8), a tekst je ovdje.

- `hr.json`: ugniježđeni ključevi, npr. `gate.risk_below_floor`. Danas sadrži poruke razvojnog gatea (`scripts/engineering/risk-floor.ts`) i porta potpisa. Test `server/risk-floor.test.ts` provjerava da svaki ključ greške gatea ima tekst.
- `signing.*`: greške porta potpisa (`server/external/keys/signing-errors.ts`). Test `server/external/keys/signing-errors.test.ts` provjerava da svaki `messageKey` porta ima tekst.

Tekstovi sučelja moraju poštovati rječnik zabranjenih izraza (Ductus `docs/PRODUCT.md` §5).
