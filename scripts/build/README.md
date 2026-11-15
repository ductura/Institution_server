# scripts/build

Izgradnja servera (S-1B-a, DAN-775).

- `server.ts`: `buildServer(root, outfile)` esbuildom pakira jedinu ulaznu točku `server/server.ts` u jednu datoteku `dist/server.js`, s ugrađenim ovisnostima (`pg-native` ostaje vani). `pnpm build` je poziva, a `pnpm start` pokreće `node dist/server.js`.
- `index.ts`: javno sučelje mape.

`node scripts/build/server.ts [izlazna-datoteka]` gradi u drugu datoteku; `scripts/build/server.integration.test.ts` tako pokreće skriptu kao proces, i izravno i kroz putanju sa simboličkom vezom. Integracijski test `server/server.integration.test.ts` gradi istom funkcijom u privremenu mapu i pokreće pravi proces.
