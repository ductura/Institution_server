# scripts/release

Priprema i provjera paketa za objavu na GitHub Packages (U10-a, DAN-742; [plan](../../docs/PLAN.md) §5 U10 i §7 „Izdanja”). Objavu iz Actionsa radi `.github/workflows/publish.yml` (U10-b); skripte ove mape same ništa ne objavljuju.

- `manifest.ts`: što je svaki paket (`@ductura/contracts`, `@ductura/test-fakes`): ulazi, podatkovne datoteke, objavljene ovisnosti i **točan popis datoteka** tarballa.
- `stage.ts`: `stagePackage` prevodi ulaze `tsc`-om (JS i `.d.ts`, `rewriteRelativeImportExtensions`) u `dist/release/<paket>/`, kopira podatkovne datoteke i piše objavni `package.json` (bez `private`, `publishConfig.registry` GitHub Packages, `repository` ductura/server). `manifestErrors` odbija manifest koji nije za objavu: jedna stroga TypeBox shema cijelog manifesta (nijedno drugo polje; `publishConfig` je samo registar), zatim ime, `/pglite`, ciljevi `exports` i ovisnosti.
- `pack.ts`: `npm pack --dry-run --json`; jedna TypeBox shema (`PackOutputSchema`) provjerava cijeli izlaz prije upotrebe.
- `secrets.ts`: `scanSecrets` odbija privatne ključeve, tokene i URL baze s lozinkom.
- `check.ts`: `pnpm release:check` priprema oba paketa i pada ako tarball nije točno popis, manifest nije ispravan, postoji nešto nalik tajni ili se `test-fakes` učita uz `NODE_ENV=production`. `pnpm release:stage` samo priprema.

- `tag.ts`: `pnpm release:tag` u `publish.yml` provjerava oznaku: ime točno `<contracts|test-fakes>-vX.Y.Z`, `GITHUB_REF` je ta oznaka, verzija je `version` paketa u repou, za `contracts` glavna je glavna `API_VERSION`, a commit je predak `origin/main`. Tek tada piše `package=` u `$GITHUB_OUTPUT`.
- `tarball.ts`: `pnpm release:tarball <contracts|test-fakes>...` priprema i stvarno pakira paket u `dist/release/tarball/`, raspakira te bajtove (samo obične datoteke pod `package/`) i nad njima pokreće cijeli `checkStaged`, pa ispisuje sha256.

Objava (`publish.yml`, na oznaku):

- `verify` (samo `contents: read`): testovi, `release:tag`, `release:check`, `release:tarball`, artefakt s tarballom i njegov sha256.
- `publish` (`environment: packages`, jedini s `packages: write`): ne radi checkout i ne pokreće kod repoa; provjeri sha256 preuzetog tarballa i objavi taj `.tgz` s `npm publish --ignore-scripts`. Token je samo `GITHUB_TOKEN`, u tom jednom koraku.
- `verify` provjerava oznaku odmah nakon `pnpm install`, prije testova; `readTarball` čita tarball strogo (checksum i ustar oznaka svakog zaglavlja, samo obične datoteke pod `package/`, iza kraja samo nule), a sha256 se računa nad istim bajtovima koje je provjerio `checkStaged`.
- **Poznata granica (napadački prolaz, H3):** okruženje `packages` i ruleset oznaka ne vežu `packages: write`. Workflow se čita iz commita oznake, a pisac s pravom pisanja u repo može gurnuti granu s drugim workflowom koji traži `packages: write` bez okruženja. Zatvaranje te rupe nije u ovom PR-u: treba token koji postoji samo kao tajna okruženja `packages` (npr. GitHub App) i ukidanje naslijeđenog pristupa repoa u postavkama paketa, ili izričito prihvaćanje rizika. To je vlasnička odluka.
- Postojeća verzija se ne prepisuje: registar odbija objavu, posao pada. Nova verzija je PR koji podiže `version` u `packages/<paket>/package.json`.
- U `ci.yml` korak „Probna objava” na svakom PR-u i pushu radi isto bez slanja: `release:check`, `release:tarball contracts test-fakes` i `npm publish --dry-run`, bez tokena.

Redoslijed prve objave (POTVRDA UGOVORA w742e t. 6): **najprije postavke**, koje uz Danielovo odobrenje postavlja orkestrator: okruženje `packages` s obveznim odobrenjem (bez njega GitHub okruženje stvori samo, bez odobrenja), ruleset za oznake `contracts-v*` i `test-fakes-v*` (stvaraju samo održavatelji, bez brisanja i premještanja) te pristup paketima. **Tek zatim oznaka** (`contracts-v1.0.0`, `test-fakes-v0.1.0`), koju odobrava Daniel. Pisac ne stvara oznake i ništa ne objavljuje.

Pravila:

- U repou su oba paketa `private`; objavljuje se samo pripremljena kopija.
- `/pglite` se ne objavljuje (POTVRDA UGOVORA w742a t. 3): objavni korijen `test-fakes` je `packages/test-fakes/release.ts`, korijen bez PGlite-a, i `@electric-sql/pglite` nije objavljena ovisnost.
- `@ductura/contracts` nema ovisnosti; nikad ne ovisi o `@ductura/test-fakes`, `oidc-provider` ni `@electric-sql/pglite`. Glavna verzija mu je glavna verzija `API_VERSION`.
- Datoteka koja nije u `manifest.ts` ne objavljuje se; nova datoteka u paketu traži izmjenu popisa u istom PR-u.
- Provjera uz popis gleda i datoteke na disku, uvoze objavljenog JS-a (relativni samo na datoteke s popisa, paketi samo deklarirani) i da `test-fakes` u produkciji odbija baš čuvar.
- `oidc/server.js` zadržava pokretanje izravno (`node …/oidc/server.js`), kao u U9: i tada vrijedi čuvar `NODE_ENV`, a nepostavljen `NODE_ENV` je dopušten po dizajnu U9 (D-09).

Testovi: `release.test.ts` (validator izlaza, popis, tajne, manifest), `release.integration.test.ts` (prava priprema i `npm pack`, s negativnim slučajevima: višak, manjak, ključ, `private`, korijen bez čuvara), `tag.test.ts` (oznaka), `tarball.integration.test.ts` (pravi tarball i njegovi negativni slučajevi), `workflow.test.ts` (invarijanta 5 nad `publish.yml` i korak u `ci.yml`), `production.test.ts` (`test-fakes` nije produkcijska ovisnost).
