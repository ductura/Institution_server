# scripts/build

Izgradnja servera (S-1B-a, DAN-775).

- `server.ts`: `buildServer(root, outfile)` esbuildom pakira jedinu ulaznu točku `server/server.ts` u jednu datoteku `dist/server.js`, s ugrađenim ovisnostima (`pg-native` ostaje vani). `pnpm build` je poziva, a `pnpm start` pokreće `node --disallow-code-generation-from-strings dist/server.js`.
- `node-flags.ts`: `SERVER_NODE_FLAGS`, Node opcije s kojima radi svaki proces servera (DAN-772), i `START_SCRIPT`, naredba skripte `start`. S `--disallow-code-generation-from-strings` `eval`, `Function` i konstruktor bilo koje funkcije bacaju `EvalError` umjesto da izvrše string kao kod; to zatvara ono što lint pravilo `local/no-dynamic-load` (DAN-770) ne vidi statički. `node-flags.test.ts` provjerava skriptu `start` i da svaki test koji pokreće proces servera prosljeđuje te opcije, a `server/code-generation.integration.test.ts` ponašanje u pravom procesu.
- `index.ts`: javno sučelje mape.

`node scripts/build/server.ts [izlazna-datoteka]` gradi u drugu datoteku; `scripts/build/server.integration.test.ts` tako pokreće skriptu kao proces, i izravno i kroz putanju sa simboličkom vezom. Integracijski test `server/server.integration.test.ts` gradi istom funkcijom u privremenu mapu i pokreće pravi proces.
