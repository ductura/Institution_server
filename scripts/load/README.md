# Probe opterećenja (ISTR-9)

Skripte za mjerenje kako se poslužitelj ponaša pod opterećenjem. Opterećenje stvara [k6](https://k6.io) (OSS, AGPL-3.0). Koristi se samo kao lokalni alat: preuzima se kao izvršna datoteka sa službenog GitHub izdanja i nije ovisnost repoa. Grafana Cloud se ne koristi.

## Granice

- Samo zaseban lokalni stog sa sintetičkim računima (`sim:student:load-…@demo.ductus.test`), nikad stog u upotrebi.
- Jedna teška proba odjednom. Prije pokretanja provjeri da je slobodno barem 4 GB RAM-a.
- Rezultati idu u `.local/load/`, koji je izvan gita.

## Postupak

1. Podigni zaseban stog s vlastitom bazom: `.local/database-url` pokazuje na prazni klaster, zatim `pnpm lokalno --izravno`.
2. Pripremi studente (upis, obavijest, otvoren rad, unaprijed izračunat lanac spremanja). Priprema poštuje ograničenje prijava, pa traje oko 4 s po studentu (100 studenata oko 7 minuta):

   ```
   node scripts/load/priprema.ts --korisnika=100 --spremanja=6 --pokret=r1
   ```

3. Pokreni scenarij:

   ```
   k6 run -e SCENARIJ=rok -e PODACI=<apsolutna putanja>/.local/load/r1.json scripts/load/scenarij.ts
   ```

Svaki pokret troši pripremljene lance, pa svaki scenarij treba vlastitu pripremu.

## Scenariji

| `SCENARIJ`       | Što oponaša                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `nastava`        | Studenti rade tijekom nastave: početak raspršen kroz 30 s, spremanje svakih 5 do 15 s.                  |
| `rok`            | Zadnje minute prije roka: svi kreću unutar 5 s, spremaju svake sekunde, zatim predaju.                  |
| `sinkronizacija` | Veza se vratila: svi odjednom šalju spremanja iz reda bez stanke i ponove zadnje (očekuje se duplikat). |

Broj korisnika jednak je broju pripremljenih studenata. Pragovi `http_req_failed rate==0` i `checks rate==1` znače da svaki neuspio zahtjev ili provjera završava k6 kodom različitim od 0. Ugašen poslužitelj nikad ne prolazi tiho.

`lanac.ts` gradi lanac v2 segmenata (JCS, `predecessorSegmentHash`) koji poslužitelj prihvaća. `lanac.test.ts` ga provjerava s `verifyEvidenceChainV2`.

Rezultati i uska grla: [docs/nalazi/opterecenje-2611.md](../../docs/nalazi/opterecenje-2611.md).

SRV-OPT-1000 (1000 pisaca i 1000 zahtjeva u sekundi, 1, 2 i 4 kopije): [docs/nalazi/srv-opt-1000.md](../../docs/nalazi/srv-opt-1000.md). Samo scenarij i skripta; pokretanje odobrava Daniel.
