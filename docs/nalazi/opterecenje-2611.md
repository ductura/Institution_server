# ISTR-9: probe opterećenja, 26. 11. 2026.

Prvo stvarno izvođenje proba opterećenja. Skripte su u [scripts/load/](../../scripts/load/README.md). Raniji scenarij [OPS-OPTERECENJE](ops-opterecenje.md) napisan je, ali nije pokrenut. Ove probe mjere ista tri koraka (spremanje, ponovno spremanje, predaja) na lokalnom stogu.

## Okruženje

- Jedno računalo (Windows 10, 16 GB RAM). Slobodnog RAM-a prije pokretanja bilo je 3,6 do 3,9 GB. k6 i poslužitelj dijele isti procesor, pa su brojke donja granica onoga što poslužitelj može.
- Zaseban stog: `pnpm lokalno --izravno` (poslužitelj `dist/server.js` na :4000, lažni OIDC, lokalni S3) nad praznim klasterom PostgreSQL 16 samo za ovu probu. Baza nije bila ni jedna od baza u upotrebi.
- Računi su sintetički (`sim:student:load-<pokret>-<i>@demo.ductus.test`), upisani u izmišljeni tečaj `UPIS2026DEMO`, na zadatak „Seminarski rad: kućno kompostiranje”.
- k6 v2.4.0 (OSS, službeno GitHub izdanje, provjeren sha256), lokalno, bez Grafana Clouda.
- Sav promet dolazi s 127.0.0.1, pa poslužitelj sve studente vidi kao jedan IP.
- Svaki student ima 6 spremanja: lanac v2 segmenata koji poslužitelj prihvaća (`lanac.ts`).

## Rezultati

Vrijeme odgovora je `http_req_duration` iz k6, za sve zahtjeve pokreta.

| Scenarij         | Korisnika | Zahtjeva | Stopa grešaka |    p50 |    p95 |    max | Trajanje | k6 izlaz |
| ---------------- | --------: | -------: | ------------: | -----: | -----: | -----: | -------: | -------: |
| Bez opterećenja  |         3 |       15 |           0 % |  83 ms | 135 ms | 158 ms |    < 1 s |        0 |
| `nastava`        |       100 |      600 |           0 % |  43 ms |  63 ms | 143 ms |     1:42 |        0 |
| `rok`            |       100 |      700 |           0 % | 544 ms | 1,68 s | 2,51 s |   0:15,5 |        0 |
| `sinkronizacija` |       100 |      700 |           0 % | 1,43 s | 1,55 s | 1,67 s |   0:10,2 |        0 |

- `nastava`: 600 spremanja, sva `committed`.
- `rok`: 600 spremanja i 100 predaja, sva spremanja `committed`, sve predaje `submitted`. Poslužitelj je obrađivao oko 45 zahtjeva u sekundi.
- `sinkronizacija`: 600 spremanja bez stanke i 100 ponovljenih zadnjih spremanja, sva spremanja `committed`, sva ponavljanja `duplicate`. Poslužitelj je obrađivao oko 68 zahtjeva u sekundi.

## Testovi prihvata

| Test                                           | Ishod                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Bez opterećenja stopa grešaka je 0             | Prolaz: 3 studenta, 15 zahtjeva, 0 % grešaka, 30/30 provjera.                                      |
| Ugašen poslužitelj daje grešku, ne tihi prolaz | Prolaz: `IZVOR` na port na kojem ništa ne sluša, 100 % neuspjelih zahtjeva, k6 izlazi s kodom 99.  |
| Nema pripremljenih studenata                   | k6 izlazi s kodom 107 i porukom „no prepared students”. Prazan pokret nikad ne izgleda kao uspjeh. |

## Uska grla (prijedlozi zasebnih zadataka)

Ciljevi kapaciteta nisu dio ISTR-9. Ovo su opažanja koja traže odluku ili zaseban zadatak.

1. **Ograničenje spremanja po IP-u kod NAT-a.** `save_per_ip` je token bucket od 1200 zahtjeva i puni se 20 u sekundi. Predavaonica ili fakultetska mreža iza jednog javnog IP-a dijeli taj bucket. U `rok` probi 600 spremanja stalo je u kapacitet, ali rok duži od oko 30 s sa 100 studenata koji spremaju svake sekunde iscrpio bi ga i studenti bi dobili HTTP 429. Prijedlog: odluka o pragu ili ključu (npr. veći `save_per_ip` uz postojeći `save_per_account` od 120 u minuti), zatim proba s 200 i više korisnika.
2. **Propusnost spremanja.** U `sinkronizaciji` 100 studenata šalje bez stanke i poslužitelj obrađuje oko 68 spremanja u sekundi. Kašnjenje od oko 1,4 s je čekanje u redu: 100 istodobnih zahtjeva podijeljeno s 68 u sekundi daje oko 1,47 s. Isto se vidi u `roku` (45 u sekundi, p50 544 ms, p95 1,7 s), a u `nastavi` je p50 43 ms. Uzrok stropa nije izmjeren (jedan Node proces, baza ili k6 na istom računalu). Prijedlog: ponoviti `sinkronizaciju` s k6 na drugom računalu i profilirati `evidence/commit` (vrijeme u bazi naspram vremena u procesu).
3. **Ograničenje prijava pri pripremi.** Jedna prijava troši dva mjesta u `login_per_ip` (30 u minuti): `auth/login` i `auth/callback`. Priprema zato traje 4,1 s po studentu (100 studenata oko 7 minuta). Za proizvod to znači da 15 studenata iza istog NAT-a može započeti prijavu u minuti. Prijedlog: provjeriti treba li `auth/callback` trošiti isti bucket kao `auth/login` i kakav je prag za početak nastave u predavaonici.

## Ograde

- Jedan pokret po scenariju i 100 korisnika. Brojke nisu statistički ponovljene.
- Predaja ide kroz `submission` (v1), kao u lokalnim seedovima. `submission/v2` nije mjeren.
- Lanac ima šest kratkih spremanja po studentu. Veliki dokumenti i spremanja blizu granice segmenta nisu mjereni.
