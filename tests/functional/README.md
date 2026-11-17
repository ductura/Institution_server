# tests/functional

Funkcionalni testovi nad izgrađenim serverom (`dist/server.js`) na lokalnom stogu VS-1 ([scripts/stack](../../scripts/stack/README.md)); mjesto u planu je redak „Funkcionalni” u [docs/PLAN.md](../../docs/PLAN.md). **Samo lokalno i u CI-ju** (D-09): stog pokreće lažni OIDC pružatelj.

## Što radi

- `own-not-other.ts` (S-1H.3, DAN-1003): „vlastiti rad da, tuđi ne”. Dva izmišljena studenta demo-fakulteta, A i B, kolege su na zadatku Z i svaki ima svoj rad; B je sam i u kolegiju Y, čiju obavijest je A potvrdio, pa A-u nedostaje samo članstvo. A na B-ovu radu (`evidence/commit` i `evidence/replay` nad B-ovim dokumentom, `evidence/open` na zadatak Y, sa `start: true` i bez njega) mora dobiti točno odgovor ugovora za rad koji ne postoji, 404 `{"status":"not_found"}`; svaki drugi odgovor ruši test (`notFoundProblem`).
  - A-ov `commit` je zahtjev koji bi B-u prošao. B zatim šalje isti zahtjev i dobiva 200 `committed` s revizijom 1, ne `duplicate`, pa je A-ov zahtjev bio ispravan i ništa nije zapisao. B čita svoj rad (`replay`, jedan segment), a A ga ni tada ne može pročitati.
  - B otvara svoj rad na Y prije A-ova `open` na Y, pa se `open` provjerava nad postojećim tuđim radom, ne samo nad praznim zadatkom. B isti rad dobiva i bez `start`, pa A-ov 404 bez `start` nije odgovor koji ta grana daje svima.
  - A otvara svoj rad na Z (drugi dokument od B-ova) prije svih pokušaja, a nakon njih ga šalje i reproducira i dobiva 200.
  - Broji pročitane odgovore (`CHECKS`, 13); manje znači da je test stao ili preskočio provjeru.
  - Provjera se čeka na najvišoj razini modula: provjera koja se nikad ne razriješi završava izlazom različitim od 0 (pod `tsx` 1, pod `node` 13).
  - Izlaz imenuje SHA checkouta koji pokreće test (i SHA iz `state.json` stoga kad se razlikuje; u CI-ju PR-a to je GitHubov merge commit) i SHA-256 `dist/server.js`. Test pada ako stog ne radi, ako direktorij stoga ne prolazi provjeru samog stoga ili je dosegnut kroz simboličku vezu, ako na portu servera ne sluša zapisani proces upravo tog direktorija s `dist/server.js` ovog checkouta, ako socket ne poslužuje postmaster vlastitog `pgdata` ili ako `dist/server.js` nije izgradnja koja radi.
- Sesije se upisuju u `identity.session` kako ih ostavlja uspješna prijava (kao `scripts/stack/vs1-commit-check.ts`). Prijava kroz lažni OIDC ovdje nije moguća jer server stoga namjerno ne dobiva adresu issuera (blokada D-09, t. 4 u README-u stoga).

```bash
pnpm build
pnpm stack:vs1 up
pnpm test:functional   # tsx tests/functional/own-not-other.ts (CODE_STYLE §12); VS1_STACK_DIR bira stog
```

## Tko ga zove

CI, posao „PostgreSQL i pgTAP”, korak „Stog VS-1”, nakon `vs1-commit-check.ts`. `not-found.test.ts` je u projektu `unit` (`pnpm test`) i ne treba stog.

## Koje podatke dira

Samo bazu stoga koji radi: izmišljeni studenti, nastavnici, kolegiji i zadaci demo-fakulteta, preko `psql` kao `ductus` kroz socket stoga; vrijednosti idu kroz stdin, nikad argv. Radovi i objekti nastaju kroz rute servera.

## Što izvozi

`checkOwnNotOther`, `CHECKS`, `notFoundProblem`, `runningStack`, `seedCourse`, `seedStudent`, `acknowledgeNotice` i tipove `Course`, `Student`, za matricu ruta × sedam uloga (S-1H.2).

## Što ne smije uvoziti

Ništa iz `server/` osim kroz HTTP: test gleda samo ono što vraća `dist/server.js`. Iznimka je `canonicalizeJcs` iz `server/domain/index.ts` (kroz `scripts/stack/client.ts`), samo za slaganje tijela commita. Stog samo kroz `scripts/stack/index.ts`; zahtjeve preglednika (`post`, `commitRequest`) dijeli s provjerom commita iz `scripts/stack/client.ts`.
