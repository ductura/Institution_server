# scripts/release

Priprema i provjera paketa za objavu na GitHub Packages (U10-a, DAN-742; [plan](../../docs/PLAN.md) §5 U10 i §7 „Izdanja”). Objavu iz Actionsa radi `.github/workflows/publish.yml` (U10-b); skripte ove mape same ništa ne objavljuju.

- `manifest.ts`: što je svaki paket (`@ductura/contracts`, `@ductura/test-fakes`): ulazi, podatkovne datoteke, objavljene ovisnosti i **točan popis datoteka** tarballa.
- `stage.ts`: `stagePackage` prevodi ulaze `tsc`-om (JS i `.d.ts`, `rewriteRelativeImportExtensions`) u `dist/release/<paket>/`, kopira podatkovne datoteke i piše objavni `package.json` (bez `private`, `publishConfig.registry` GitHub Packages, `repository` ductura/server). `manifestErrors` odbija manifest koji nije za objavu: jedna stroga TypeBox shema cijelog manifesta (nijedno drugo polje; `publishConfig` je samo registar), zatim ime, `/pglite`, ciljevi `exports` i ovisnosti.
- `pack.ts`: `npm pack --dry-run --json`; jedna TypeBox shema (`PackOutputSchema`) provjerava cijeli izlaz prije upotrebe.
- `secrets.ts`: `scanSecrets` odbija privatne ključeve, tokene i URL baze s lozinkom.
- `check.ts`: `pnpm release:check` priprema oba paketa i pada ako tarball nije točno popis, manifest nije ispravan, postoji nešto nalik tajni ili se `test-fakes` učita uz `NODE_ENV=production`. `pnpm release:stage` samo priprema.

- `tag.ts`: `pnpm release:tag` u `publish.yml` provjerava oznaku: ime točno `<contracts|test-fakes>-vX.Y.Z`, `GITHUB_REF` je ta oznaka, verzija je `version` paketa u repou, za `contracts` glavna nije niža od glavne `API_VERSION` (koji mora biti `X.Y.Z`), a commit je predak `origin/main`. Tek tada piše `package=` u `$GITHUB_OUTPUT`.
- `tarball.ts`: `pnpm release:tarball <contracts|test-fakes>...` priprema i stvarno pakira paket u `dist/release/tarball/`, raspakira te bajtove (samo obične datoteke pod `package/`) i nad njima pokreće cijeli `checkStaged`, pa ispisuje sha256.

Automatska razina izdanja (DAN-804, POTVRDA UGOVORA w804a):

- `level.ts`: `releaseLevel` uspoređuje paket pripremljen na zadnjem tagu s pripremljenim na HEAD-u. Ishod je `none`, `patch`, `minor`, `major` ili `blocked`. Pravila:
  - isti bajtovi (osim `version`) daju `none`;
  - `.d.ts` se uspoređuje po TypeScript AST-u, bez komentara i rasporeda: samo nova izvezena deklaracija (novo ime) je minor; uklonjeno, promijenjeno i **svaki novi član postojećeg tipa** (i opcionalni) je major. To je tvrdi rez iz naloga orkestratora na #92: novi član suzi `keyof`, `Required`, `implements`, nasljeđivanje, presjek i index signature;
  - `exports` iz `package.json`: dodan je minor, uklonjen ili promijenjen major;
  - ostali bajtovi daju patch;
  - za `contracts` `breakingChanges` nad `openapi/v1.json` daje major, a rast minora ili patcha `info.version` daje minor ili patch. Novi član **na vrhu** generirane tablice ruta (samo `type Operations` i `declare const ROUTE_TABLE` na vrhu datoteke: nova ruta) je minor samo ako je dokument narastao minorom, a `scripts/generate-contracts.ts` nije mijenjan; novo polje unutar postojeće rute (i opcionalno) je major (QA #92).
  - Datoteke se uspoređuju kao sirovi bajtovi; dekodira se samo ono što se parsira (`.d.ts`, JSON), strogo kao UTF-8 i s BOM-om.
  - Kad ijedna stara `.d.ts` paketa tipizira prostor imena modula (`typeof import(…)`, `import * as`, `export * as`, `import x = require(…)`), nijedno novo izvezeno ime nije minor, jer tom tipu dodaje člana.
  - za `test-fakes` (DAN-974-4a), kad se promijeni bilo koja `.js` datoteka paketa, klasifikator uspoređuje rute koje objavljeni lažni server stvarno izvozi. `stagedRoutes` (`staged-routes.ts`) piše pripremljeni paket u privremenu mapu izvan repoa i uvozi `server/contracts/generated/fake-server/index.js` u zasebnom procesu `node`: smije čitati samo tu mapu, okolina mu je samo `PATH`, ima timeout i `SIGKILL`. Snimka je `ROUTE_TABLE` odmah nakon uvoza, a funkcije koje čita uzete su prije uvoza modula. Snimka ide vlastitim kanalom (opisnik 3), a ne kroz `stdout`, pa dijagnostika modula nije snimka. Svaki redak mora biti objekt. Pravila:
    - uklonjena ili promijenjena ruta je major, a nova minor;
    - svaka promjena javnog `packages/test-fakes/fake-server/index.js` je major;
    - ono što nije podatak je `blocked`: getter, nenabrojivo svojstvo, funkcija, simbol, `undefined`, `NaN`, `-0`, niz s rupom, Proxy, instanca klase. `blocked` je i modul koji baca, nema `ROUTE_TABLE` ili ne završi, lažni server na jednoj strani i nedostatak čitača.
    - Granice: promjena napravljena nakon uvoza (`setTimeout`, poziv potrošača) ili iz drugog modula ostaje patch, a redoslijed ruta se ne uspoređuje. Model prijetnje je slučajna promjena, ne napad.
  - Nova deklaracija čije se ime pojavljuje kao identifikator (AST) u ijednoj staroj `.d.ts` datoteci paketa (i globalna imena poput `Date`) je major, jer ga može zasjeniti.
  - Što se ne može pouzdano odrediti (neparsabilan `.d.ts`, nečitljiv dokument) je `blocked`, nikad patch.
- **Prihvaćena granica (ugovor t. 4):** nova ruta u `contracts` je minor iako širi `OperationId` (`keyof Operations`); potrošač s `Record<OperationId, …>` ili iscrpnim `switch` mora dodati granu. To je značenje nove rute u API-ju v1.
- **Opće pravilo:** kad klasifikator ne može dokazati da promjena nije lomljiva, rezultat je `major` (vlasnička odluka) ili `blocked`, nikad niža razina.
- `nextVersion`: minor ili patch od zadnjeg taga, nikad ispod `version` iz `package.json`. Viši major u `package.json` znači da major čeka vlasnički tag, pa se ništa ne označava.
- `auto.ts`: `pnpm release:level`. Stari paket priprema **kodom taga** (`git worktree`, `pnpm install`, `check.ts --stage-only`), a novi kodom HEAD-a. U `$GITHUB_OUTPUT` piše `releases` (tagove za stvaranje) i `stopped` (`<paket>:major|blocked`). Svaki pad (git, instalacija, priprema) je `blocked`. Sam ne stvara tag.

Objava (`publish.yml`, na oznaku):

- `verify` (samo `contents: read`): testovi, `release:tag`, `release:check`, `release:tarball`, artefakt s tarballom i njegov sha256.
- `publish` (`environment: packages`, jedini s `packages: write`): ne radi checkout i ne pokreće kod repoa; provjeri sha256 preuzetog tarballa i objavi taj `.tgz` s `npm publish --ignore-scripts`. Token je samo `GITHUB_TOKEN`, u tom jednom koraku.
- `release` (DAN-966; `environment: packages`, samo `contents: write`): ne radi checkout i ne pokreće kod repoa; ista provjera sha256, pa isti `.tgz` priloži javnom GitHub Releaseu oznake (`gh release create --verify-tag` s datotekom ili `gh release upload` bez `--clobber`). Oznaka je iz `$GITHUB_REF`, ne iz izraza, i mora imenovati provjerenu datoteku. Čeka samo `verify`, pa pad objave na GitHub Packages ne zaustavlja prilaganje. Postojeći asset se ne prepisuje (DAN-966-2a): ponovno pokretanje preuzme asset istog imena u svježu privremenu mapu i usporedi sha256; isti prolazi bez prilaganja, drugačiji ruši posao prije ikakvog prilaganja. Neuspio `gh release view` vodi u `create`, koji na postojećem izdanju pada, pa nikad u `upload`.
- `verify` provjerava oznaku odmah nakon `pnpm install`, prije testova; `readTarball` čita tarball strogo (checksum i ustar oznaka svakog zaglavlja, samo obične datoteke pod `package/`, iza kraja samo nule), a sha256 se računa nad istim bajtovima koje je provjerio `checkStaged`.
- **Poznata granica (napadački prolaz, H3):** okruženje `packages` i ruleset oznaka ne vežu `packages: write`. Workflow se čita iz commita oznake, a pisac s pravom pisanja u repo može gurnuti granu s drugim workflowom koji traži `packages: write` bez okruženja. Zatvaranje te rupe nije u ovom PR-u: treba token koji postoji samo kao tajna okruženja `packages` (npr. GitHub App) i ukidanje naslijeđenog pristupa repoa u postavkama paketa, ili izričito prihvaćanje rizika. To je vlasnička odluka.
- Postojeća verzija se ne prepisuje: registar odbija objavu, posao pada.
- **Verzija je u tagu (DAN-804, put (b)).** `version` u `packages/<paket>/package.json` je dno svog majora: `release:tag` traži isti major i tag koji nije niži od njega, a objavljena verzija je verzija taga (`RELEASE_VERSION` u koraku tarballa, samo za jedan paket). Novi major je vlasnički PR koji podiže `version` na `X.0.0` i vlasnički tag.
- `publish.yml` prima i `workflow_dispatch` bez inputa (svjesna promjena invarijante 5a iz DAN-742), samo za ručno pokretanje na tagu. Automatika ga ne koristi (DAN-866): tag koji `release.yml` gurne ključem za objavu sam pokreće `publish.yml` jednom. Dispatch na grani pada na `release:tag`.

Automatsko izdanje (`release.yml`, na push u `main`, runovi jedan za drugim):

- `level` (samo `contents: read`): `pnpm release:level`.
- `tag` (`permissions: {}`, bez `GITHUB_TOKEN` i bez checkouta, samo `git` i `ssh`; DAN-866): najprije provjeri `SHA`, `REPO` i cijeli `releases` (jedan ili oba paketa, točno jedan razmak), pa tek onda učita ključ iz tajne `RELEASE_DEPLOY_KEY` u `ssh-agent` tog koraka (nikad u datoteku, ispis ni okolinu `git`-a i `ssh`-a; agent i privremenu mapu briše `trap`). Ključ hosta github.com je fiksiran (`StrictHostKeyChecking=yes`). Samo ako je commit još vrh `main`-a (`git ls-remote`; inače kasniji run pokriva i njega) dohvati taj commit i gurne sve tagove jednim `git push --atomic` bez sile: postojeći tag se ne pomiče i tada ne nastaje nijedan. Gurnuti tag sam pokreće `publish.yml`, točno jednom.
- `report` (`contents: read`, `pull-requests: write`): za `major` ili `blocked` stavi fiksni komentar na spojeni PR s poveznicom na run, pa padne.
- Preduvjeti su postavke, ne kod: ruleset oznaka (27328592) mora pustiti ključ za objavu (deploy ključ s pisanjem, privatni dio u tajni `RELEASE_DEPLOY_KEY`), a okruženje `packages` i dalje traži odobrenje.
- **Poznata granica:** `level` izvodi klasifikator (`level.ts`, `auto.ts`, `stage.ts`, `breaking.ts`) s HEAD-a. PR koji mijenja paket može promijeniti i klasifikator, pa njega čuva review gate (`.github/**` je critical, a `scripts/release/**` i `server/contracts/**` su standard), ne ovaj workflow.
- U `ci.yml` korak „Probna objava” na svakom PR-u i pushu radi isto bez slanja: `release:check`, `release:tarball contracts test-fakes` i `npm publish --dry-run`, bez tokena.

Redoslijed prve objave (POTVRDA UGOVORA w742e t. 6): **najprije postavke**, koje uz Danielovo odobrenje postavlja orkestrator: okruženje `packages` s obveznim odobrenjem (bez njega GitHub okruženje stvori samo, bez odobrenja), ruleset za oznake `contracts-v*` i `test-fakes-v*` (stvaraju samo održavatelji, bez brisanja i premještanja) te pristup paketima. **Tek zatim oznaka** (`contracts-v1.0.0`, `test-fakes-v0.1.0`), koju odobrava Daniel. Pisac ne stvara oznake i ništa ne objavljuje.

Pravila:

- U repou su oba paketa `private`; objavljuje se samo pripremljena kopija.
- `/pglite` se ne objavljuje (POTVRDA UGOVORA w742a t. 3): objavni korijen `test-fakes` je `packages/test-fakes/release.ts`, korijen bez PGlite-a, i `@electric-sql/pglite` nije objavljena ovisnost.
- `@ductura/contracts` nema ovisnosti; nikad ne ovisi o `@ductura/test-fakes`, `oidc-provider` ni `@electric-sql/pglite`. Glavna verzija mu nije niža od glavne verzije `API_VERSION` (DAN-869): verzija paketa prati lomljive promjene TypeScript tipova, a `API_VERSION` žičani protokol, pa major paketa (npr. 2.0.0) ne mijenja `API_VERSION` (ostaje 1) ni rute (`/api/v1`).
- Datoteka koja nije u `manifest.ts` ne objavljuje se; nova datoteka u paketu traži izmjenu popisa u istom PR-u.
- Provjera uz popis gleda i datoteke na disku, uvoze objavljenog JS-a (relativni samo na datoteke s popisa, paketi samo deklarirani) i da `test-fakes` u produkciji odbija baš čuvar.
- `oidc/server.js` zadržava pokretanje izravno (`node …/oidc/server.js`), kao u U9: i tada vrijedi čuvar `NODE_ENV`, a nepostavljen `NODE_ENV` je dopušten po dizajnu U9 (D-09).

Testovi: `level.test.ts` (razina: minor, patch, major, blocked i lažni minor), `staged-routes.integration.test.ts` (rute iz pravog generiranog lažnog servera u pravom procesu `node`), `auto.test.ts` (plan i pad pripreme starog paketa), `release.test.ts` (validator izlaza, popis, tajne, manifest), `release.integration.test.ts` (prava priprema i `npm pack`, s negativnim slučajevima: višak, manjak, ključ, `private`, korijen bez čuvara), `tag.test.ts` (oznaka i verzija iz taga, major `contracts` iznad `API_VERSION` i stvarne verzije repoa), `tag.property.test.ts` (major `contracts` prolazi točno kad nije niži od glavne `API_VERSION`), `release-workflow.test.ts` (`release.yml`; korak `tag` izvodi se pravim `git`-om nad lokalnim bare repoom, uz stubove `ssh`, `ssh-agent` i `ssh-add`), `tarball.integration.test.ts` (pravi tarball i njegovi negativni slučajevi), `workflow.test.ts` (invarijanta 5 nad `publish.yml` i korak u `ci.yml`), `production.test.ts` (`test-fakes` nije produkcijska ovisnost).
