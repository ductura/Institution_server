# SRV-OPT-1000: scenarij opterećenja za 1000 pisaca i 1000 zahtjeva u sekundi

Zadatak: DAN-895, odluka Daniela 27. 11. 2026. (chat orkestratora: „Da, smiješ”, „sve ove prijedloge ti odobravam”). Opseg je **samo scenarij i skripta** na k6 osnovi iz ISTR-9 ([opterecenje-2611.md](opterecenje-2611.md), [scripts/load/](../../scripts/load/README.md)). **Ništa nije pokrenuto**: ni na stagingu, ni na drugom okruženju, ni lokalno (vidi „Što je provjereno”). Svako stvarno pokretanje odobrava Daniel.

## Datoteke

| Datoteka                        | Uloga                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `scripts/load/opt-1000.ts`      | k6 skripta s dva odvojena opterećenja (`OPTEREĆENJE=pisci` i `zahtjevi`).                        |
| `scripts/load/opt-1000-plan.ts` | Matrica pokreta (1, 2 i 4 kopije), parametri i provjere; bez mreže, pa se testira.               |
| `scripts/load/opt-1000-baza.ts` | Uzorkovanje opterećenja baze i duljine redova (samo SELECT, preko `psql`), CSV u `.local/load/`. |
| `scripts/load/opt-1000.test.ts` | Testovi plana i uzorkivača.                                                                      |
| `scripts/load/priprema.ts`      | Postojeća priprema, dodana zastavica `--velicina` (veći dokumenti).                              |

## Dva odvojena opterećenja

**(a) 1000 istodobnih pisaca (`pisci`).** Jedan VU je jedan student, 1000 VU-ova, svaki jedan prolaz.

1. Početak raspršen kroz prvih 15 s.
2. Spremanje (`evidence/commit`) svakih 15 do 30 s, lanac segmenata v2 iz `lanac.ts`. Veći dokumenti: `--velicina=<znakova po spremanju>` u pripremi (do 2000), uz `--spremanja=20` rad traje oko 8 do 10 minuta.
3. Ponovno slanje nakon prekida veze: slučajnih 10 % pisaca jednom ponovi spremanje koje nisu sigurni da je prošlo; ispravan odgovor je `duplicate`.
4. Predaja kroz `submission/v2` (`submission.submit-second.post`) na kraju.

**(b) 1000 zahtjeva u sekundi (`zahtjevi`).** `constant-arrival-rate`, `STOPA` zahtjeva u sekundi (zadano 1000), `TRAJANJE_S` sekundi (zadano 120). Stopa je zadana dolascima, pa spor poslužitelj ne može usporiti generator i sakriti zagušenje. Smjesa: 70 % `GET student/assignments`, 30 % `evidence/open` (`start: true`) na već otvoren rad. Samo čitanje, bez pisanja evidencije, pa se (a) i (b) ne miješaju.

Pragovi su kao u ISTR-9: `http_req_failed rate==0` i `checks rate==1`, pa svaka greška (i 429) daje k6 izlaz različit od 0.

## Parametri: 1, 2 i 4 kopije web procesa i workera

`buildMatrix()` u `opt-1000-plan.ts` daje šest pokreta; web i worker rastu zajedno:

| Oznaka (`OZNAKA`) | Opterećenje | Web | Worker |
| ----------------- | ----------- | --: | -----: |
| `pisci-w1-r1`     | (a)         |   1 |      1 |
| `pisci-w2-r2`     | (a)         |   2 |      2 |
| `pisci-w4-r4`     | (a)         |   4 |      4 |
| `zahtjevi-w1-r1`  | (b)         |   1 |      1 |
| `zahtjevi-w2-r2`  | (b)         |   2 |      2 |
| `zahtjevi-w4-r4`  | (b)         |   4 |      4 |

Pokret se ne smije ponavljati na istim studentima: svaki pokret troši pripremljene lance, pa treba novu pripremu (`--pokret=<oznaka>`). Kopije dijele jednu bazu; ispred web kopija je balanser opterećenja, a svaka kopija sluša na vlastitom portu ili instanci. Kako se kopije stvarno pokreću ovisi o okruženju koje Daniel odobri (u repou je samo jedna web usluga, `render.yaml`).

## Izlaz

- **p50, p95, p99 i greške:** k6 sažetak (`summaryTrendStats` ima p(50), p(95), p(99), max, count) i JSON u `IZLAZ` (`-e IZLAZ=<apsolutna putanja>`), s mjerama po imenu rute (`commit`, `submission`, `assignments`, `open`).
- **Opterećenje baze i duljina redova:** `node scripts/load/opt-1000-baza.ts --baza-env=<IME_VARIJABLE> --oznaka=<oznaka> --interval=5 --trajanje=<s>`. Svakih `interval` sekundi bilježi broj veza, aktivne i čekajuće (zaključavanje), ukupne commitove i rollbackove (razlika daje transakcije u sekundi), te poslove u redu pg-boss (`created`, `retry`), aktivne poslove i starost najstarijeg u redu. URL baze se zadaje preko imena varijable okoline, nikad u argumentu ni u repou.

## Generator i poslužitelj na odvojenim strojevima

Tri odvojena stroja u istoj mreži, iste regije, bez prometa preko javnog interneta:

1. **Generator:** k6 (v2.4.0 kao u ISTR-9) i skripte. Zasebno, jer k6 pri 1000 zahtjeva u sekundi s do 2000 VU-ova troši vlastiti procesor i memoriju; u ISTR-9 su k6 i poslužitelj dijelili procesor, pa je to donja granica.
2. **Poslužitelj:** web kopije i workeri (i balanser). Ni k6 ni uzorkivač ne rade na njemu.
3. **Baza i mjerenje:** baza na vlastitom stroju; `opt-1000-baza.ts` radi na trećem stroju, samo za čitanje.

Mrežni uvjeti: mjeri se jednosmjerna latencija između generatora i poslužitelja prije pokreta i bilježi uz rezultate. Ako generator dijeli procesor s drugim opterećenjem, pokret se ne računa.

### Ograničenja po IP-u (nužno prije pokreta)

Svi VU-ovi s jednog generatora dolaze s jedne IP adrese, a `save_per_ip` je token bucket od 1200 s punjenjem 20 u sekundi, `default_per_ip` 3000 u minuti. 1000 pisaca u prosjeku šalje oko 45 spremanja u sekundi, a (b) 1000 zahtjeva u sekundi: oboje bi odmah dalo HTTP 429, što bi mjerilo ograničenje, a ne poslužitelj (usp. uska grla 1 u ISTR-9). Dvije mogućnosti, obje odlučuje Daniel prije pokreta:

- `ZAGLAVLE=1` šalje po studentu različit `X-Forwarded-For` (10.x.y.z). Radi samo ako je adresa generatora (ili balansera ispred poslužitelja) u `TRUSTED_PROXIES` poslužitelja pod testom ([server/traffic/client-ip.ts](../../server/traffic/client-ip.ts)); tako poslužitelj vidi 1000 klijenata kao u predavaonicama bez NAT-a. Ne mijenja nikakve postavke.
- Ili se pragovi `save_per_ip` i `default_per_ip` na zasebnoj probnoj bazi dignu postavkama (`network.*`). Rezultat tada ne vrijedi za proizvodnju iza NAT-a.

Isto vrijedi za pripremu: `login_per_ip` je 30 u minuti, jedna prijava troši dva mjesta, pa 1000 studenata traje oko 68 minuta (iz `priprema.ts`; sesija mora ostati u roku od dva sata mirovanja). Priprema se radi odvojeno od mjerenja i najviše dva sata prije pokreta.

## Postupak (kad Daniel odobri okruženje)

1. Podigni poslužitelj i bazu za jedan red iz matrice, na odvojenim strojevima.
2. Na generatoru: `node scripts/load/priprema.ts --korisnika=1000 --spremanja=20 --velicina=1500 --pokret=<oznaka>`.
3. Na trećem stroju: `node scripts/load/opt-1000-baza.ts --baza-env=… --oznaka=<oznaka> --trajanje=<s>`.
4. Na generatoru: `k6 run -e OPTEREĆENJE=… -e PODACI=… -e IZVOR=… -e OZNAKA=<oznaka> -e IZLAZ=… [-e STOPA=1000 -e TRAJANJE_S=120] [-e ZAGLAVLE=1] scripts/load/opt-1000.ts`.
5. Ponovi za sve redove matrice, svaki s novom pripremom, jedan po jedan.

Lokalna suha proba (`dryRun()` u planu): 10 korisnika, jedna kopija, `OPTEREĆENJE=pisci` i `OPTEREĆENJE=zahtjevi -e STOPA=10`, na zasebnom lokalnom stogu (`pnpm lokalno --izravno`), kao u README-u ISTR-9.

## Što je provjereno

- `pnpm lint` i `pnpm typecheck` prolaze.
- `vitest run scripts/load`: 14 testova (matrica i oznake, granice 1000, jedinstvene adrese za 1000 pisaca, uzorkivač: samo SELECT, broj stupaca CSV-a, odbijanje URL-a u argumentu, `--velicina`).

## Što nije provjereno

- **k6 nije instaliran** u okruženju pisca (isto kao kod OPS-OPTERECENJE), pa `opt-1000.ts` nije izvedena ni kao suha proba. Provjerena je samo tipovima (`k6.d.ts`) i lintom.
- Nema lokalnog stoga (baza, poslužitelj), pa `opt-1000-baza.ts` nije pokrenut nad bazom. Upiti su provjereni čitanjem sheme (`pgboss.job`, `pg_stat_*`), ne izvođenjem.
- Odgovor `evidence/open` s `start: true` na već otvoren rad (smjesa (b)) nije izmjeren; ako vraća drugi status od 200, suha proba to otkriva prvo.

## Pretpostavke

- Smjesa (b) je samo čitanje (70/30). Plan traži 1000 zahtjeva u sekundi bez smjese; pisanje je pokriveno s (a).
- 10 % pisaca ponavlja jedno spremanje; udio je konstanta `RESEND_SHARE` u planu.
- „Kopije workera” su parametar pokreta. U repou ne postoji zaseban proces workera u `render.yaml`; pg-boss red je u bazi, pa se duljina reda mjeri iz `pgboss.job`.
- Uzorkivač koristi `psql` (kao `scripts/lokalno`), jer pristup bazi ide samo kroz `server/database` (ESLint pravilo), pa `pg` u skriptama nije dopušten.

## Otvoreno

- Odluka o IP ograničenjima (`ZAGLAVLE=1` s `TRUSTED_PROXIES` ili povišeni pragovi na zasebnoj bazi) prije prvog pravog pokreta.
- Ciljevi (npr. p95 ispod nečega) nisu zadani; skripta bilježi brojke, a pragovi su samo „bez grešaka”.
- `submission/v2` je mjeren samo ovom skriptom, još nikad stvarno; ograda iz ISTR-9 vrijedi dok se ne pokrene.
