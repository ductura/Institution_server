# scripts/release

Priprema i provjera paketa za objavu na GitHub Packages (U10-a, DAN-742; [plan](../../docs/PLAN.md) §5 U10 i §7 „Izdanja”). Objavu iz Actionsa donosi U10-b; ova mapa ništa ne objavljuje.

- `manifest.ts`: što je svaki paket (`@ductura/contracts`, `@ductura/test-fakes`): ulazi, podatkovne datoteke, objavljene ovisnosti i **točan popis datoteka** tarballa.
- `stage.ts`: `stagePackage` prevodi ulaze `tsc`-om (JS i `.d.ts`, `rewriteRelativeImportExtensions`) u `dist/release/<paket>/`, kopira podatkovne datoteke i piše objavni `package.json` (bez `private`, `publishConfig.registry` GitHub Packages, `repository` ductura/server). `manifestErrors` odbija manifest koji nije za objavu.
- `pack.ts`: `npm pack --dry-run --json`; jedna TypeBox shema (`PackOutputSchema`) provjerava cijeli izlaz prije upotrebe.
- `secrets.ts`: `scanSecrets` odbija privatne ključeve, tokene i URL baze s lozinkom.
- `check.ts`: `pnpm release:check` priprema oba paketa i pada ako tarball nije točno popis, manifest nije ispravan, postoji nešto nalik tajni ili se `test-fakes` učita uz `NODE_ENV=production`. `pnpm release:stage` samo priprema.

Pravila:

- U repou su oba paketa `private`; objavljuje se samo pripremljena kopija.
- `/pglite` se ne objavljuje (POTVRDA UGOVORA w742a t. 3): objavni korijen `test-fakes` je `packages/test-fakes/release.ts`, korijen bez PGlite-a, i `@electric-sql/pglite` nije objavljena ovisnost.
- `@ductura/contracts` nema ovisnosti; nikad ne ovisi o `@ductura/test-fakes`, `oidc-provider` ni `@electric-sql/pglite`. Glavna verzija mu je glavna verzija `API_VERSION`.
- Datoteka koja nije u `manifest.ts` ne objavljuje se; nova datoteka u paketu traži izmjenu popisa u istom PR-u.

Testovi: `release.test.ts` (validator izlaza, popis, tajne, manifest), `release.integration.test.ts` (prava priprema i `npm pack`, s negativnim slučajevima: višak, manjak, ključ, `private`, korijen bez čuvara).
