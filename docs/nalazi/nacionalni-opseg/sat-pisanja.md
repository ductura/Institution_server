# NAC-F1-SRV: mjerenje sata pisanja (suha proba, 1 korisnik)

Zadatak: izmjeriti što jedan sat pisanja jednog studenta traži od poslužitelja. Ovo je **suha proba**: skripta ne šalje ništa i ne treba stog. Gradi stvarni lanac spremanja (`scripts/load/lanac.ts`) pa su bajtovi tijela spremanja izmjereni, a ostalo se broji po ritmu klijenta. Lokalno pokretanje sa 100 korisnika radi Graditelj. Cijene i eure ne računamo.

Skripte: `scripts/load/nac/sat-pisanja.ts` (model i simulacija), `sat-pisanja-proba.ts` (pokretanje: `node scripts/load/nac/sat-pisanja-proba.ts`), `sat-pisanja.test.ts` (6 testova). Podaci su izmišljeni, generator je determinističan (`seed` 1).

## Rezultat jednog korisnika

**Jedan sat ovakvog pisanja stvara 2017 zahtjeva, 40,7 MB prometa, 274 potpisa.**

| Što                                        |                Broj |
| ------------------------------------------ | ------------------: |
| Spremanja (`evidence/commit`)              |                 274 |
| Potpisane potvrde (jedna po spremanju)     |                 274 |
| Objave prikaza uživo (`live.document.put`) |                 243 |
| Čitanja prikaza uživo, 200 (novi sadržaj)  |                 155 |
| Čitanja prikaza uživo, 304 (bez promjene)  |               1 345 |
| Neuspjeli pokušaji tijekom prekida veze    |                  26 |
| Poslano (tijela spremanja i objava)        |        32 470 680 B |
| Primljeno (tijela čitanja 200)             |        10 251 406 B |
| Najmanje / najveće tijelo spremanja        | 1 992 B / 165 470 B |

Zahtjevi (2017) = spremanja + objave + čitanja 200 + čitanja 304; neuspjeli pokušaji nisu u zbroju. Promet (40,7 MB) = poslano + primljeno.

## Što je u scenariju (sat, redom)

1. 0 do 10 min: kraći dokument, pisanje.
2. 10 do 15 min: mirovanje.
3. 15 do 35 min: veći dokument (60 000 znakova u prvom spremanju), pisanje. Od 15. do 45. min nastavnik ima otvoren prikaz uživo.
4. 30 do 35 min: prekid veze. Spremanja se redaju, objava i čitanje ponavljaju s odgodom 2, 4, 8, 16, 30 s. Po povratku red se isprazni bez stanke (oblik `sinkronizacija`).
5. 35 do 50 min: pisanje nakon povratka. 50 do 60 min: mirovanje.

Predaja (`submission.submit.post`) i izvoz (`work-export*`) su jednokratni i zasebni; ovdje nisu brojani niti mjereni.

## Glavni nalaz: tijelo spremanja nosi cijeli dokument

`CommitBody.document` je cijela kanonska snimka dokumenta u base64, uz svako spremanje (`scripts/load/lanac.ts`). Spremanje od 40 znakova na kratkom dokumentu je oko 2 KB, na dugom oko 165 KB. Živi prikaz isto šalje cijeli dokument (`live.document.put`, tijelo je JCS bajtovi snimke, do 2 MiB), najviše jednom u sekundi. Zato promet raste s veličinom dokumenta, a ne s brojem utipkanih znakova. Najveći dokazani trošak prometa u ovoj probi su ta dva ponavljanja cijele snimke (spremanje i objava uživo). Smanjenje (npr. slanje razlike) mijenja ugovor, pa ide kao odluka za Daniela, ne kao izmjena u ovom zadatku.

## Ritam klijenta (izvor)

Iz WEB repa, grana `migracija/kopija-ductus-front` (NAC-F1-WEB nije bio dostupan):

- `src/client/live-publisher.ts:34-36`: `LIVE_PUBLISH_GAP_MS = 1000`, ponovni pokušaj 2000 ms do 30 000 ms.
- `src/client/live-reader.ts:53-55`: `LIVE_READ_INTERVAL_MS = 1000`, ponovni pokušaj 2000 ms do 30 000 ms.
- Ritam spremanja: **nije pronađen** kao konstanta u `src/client` ni u `packages/editor-core/src/{sync,journal}`. Pretpostavka: spremanje svakih 5 do 15 s (kao `nastava` u `scripts/load/scenarij.ts`), 40 znakova po spremanju. Zamijeniti brojkom iz nalaza NAC-F1-WEB kad se spoji; rezultat se tada ponovno računa istom skriptom.

## Što nije izmjereno (traži lokalni stog i Graditelja)

Za 100 korisnika; vrijeme obrade, upiti prema bazi (`pg_stat_statements`), čekanje na zaključavanja, upisi objekata, ponovljeni pokušaji na poslužitelju, vrijeme do provjerene potpisane potvrde, CPU i memorija kroz dulji rad, veličina odgovora na spremanje i objavu (potvrda), zaglavlja HTTP-a. Skripta ih ne izmišlja. Dodatne ograde: prikaz uživo se objavljuje i bez otvorenog nastavničkog prikaza (pretpostavka iz čitanja `live-publisher.ts`, nije provjereno na žici); jedna potvrda po spremanju prema ugovoru `evidence.commit.post` (200 `signed`); odgovor 202 `pending_signature` u modelu nije.

## Sljedeći korak

Graditelj pokreće scenarij s 1, pa 100 korisnika na lokalnom stogu i dopunjuje stupce iz prethodnog odlomka. Uz to treba odluka o slanju razlike umjesto cijele snimke (promjena ugovora, Daniel).
